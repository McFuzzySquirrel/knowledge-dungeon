/**
 * `.kdbak` archive validation: read, validate, and inspect without touching
 * stored data.
 *
 * This module is the **only** place a `.kdbak` is interpreted, and both the
 * import and the Data Center's preview go through it. That is deliberate: the
 * plan requires (section 7.3) that a failed import must not replace the active
 * generation, and the cheapest way to be certain of that is for the file a
 * learner picked and the file a learner is shown to be the *same* parse, run
 * with the same rules, before anything is written.
 *
 * Three properties hold here, and each one is a rule rather than a convention:
 *
 * 1. **No stored data is touched.** Every input is the archive's bytes. There is
 *    no repository handle, no `localStorage`, no `navigator`, no renderer, and no
 *    clock. The result of {@link readFullDeviceArchive} is a function of its
 *    argument alone, which is what makes it safe to call on a file a learner has
 *    not yet committed to restoring.
 * 2. **Errors are typed and sanitized.** Every rejection is a
 *    {@link StorageV2Error} whose code is a real `StorageV2ErrorCode` and whose
 *    details are codes, counts, and lengths. The constructor enforces the
 *    detail rule, so a subject name, a topic, a note, a filename, or a URL cannot
 *    reach an error report even by accident.
 * 3. **The result is sanitized, with one documented exception.**
 *    {@link readFullDeviceArchive} returns counts, versions, digests, member
 *    names, and opaque attachment ids - never a subject name, a topic, a note, a
 *    filename, or a URL. The learner's own bytes live behind
 *    {@link readFullDeviceArchiveContents}, which is the importer's view and is
 *    named so that a caller reaching for the wrong one is visible.
 *
 * ## The layout
 *
 * The plan fixes it (section 7.3) and this module does not redesign it:
 *
 * ```text
 * manifest.json
 * state.json
 * attachments/<sha256>
 * custom-sprites/*
 * recovery/*
 * ```
 *
 * A **directory entry** - `attachments/`, `custom-sprites/`, or `recovery/` with
 * a trailing slash and no payload - is accepted and ignored. It is metadata, not
 * a member: it is not counted, not declared, and must never be treated as an
 * unexpected extra member. That is what makes a `.kdbak` written here readable
 * by ordinary ZIP tooling and an archive written by ordinary ZIP tooling
 * readable here. A member name that escapes the archive root is still refused,
 * and so is an entry whose recorded POSIX mode says it is a directory or a
 * symbolic link: those are *claims* about a member, not the trailing-slash
 * convention, and a backup member is data.
 *
 * ## Privacy
 *
 * No learner value appears in this module's output except through
 * {@link readFullDeviceArchiveContents}. The synthetic host
 * `example.invalid` is the only host named anywhere in the gate suite that
 * exercises this module, and nothing here ever dereferences a URL.
 */

import {
  classifyArchiveMemberTypes,
  classifyUnreadableArchive,
  decodeArchiveJsonMember,
  describeUnsafeArchivePath,
  isDirectoryEntryName,
  readArchive,
  readArchiveEntryNames,
  UNREPRESENTABLE_MEMBER_NAME,
  type ArchiveFile,
} from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  STORAGE_V2_STORE_NAMES,
  StorageV2Error,
  type ExternalOnlyAttachmentReport,
  type StorageV2ErrorCode,
  type StorageV2ErrorDetails,
  type StorageV2StoreName,
} from '@/services/persistence/v2/schema';
import {
  DATA_PRODUCT_FORMAT_VERSIONS,
  type DataProductKind,
} from '@/core/validation/persistence/types';
import {
  partitionMigrationProblems,
  MIGRATION_BLOCKING_POLICY,
  type MigrationBlockingPolicy,
} from '@/services/persistence/v2/migrationState';
import {
  countBlockingProblems,
  validateAssistanceRecord,
  validateAttachmentMetadataRecord,
  validateCustomSpriteRecord,
  validateMigrationReceipt,
  validatePreferenceRecord,
  validateProgressionRecord,
  validateRecoveryRecord,
  validateSessionRecord,
  validateShortcutRecord,
  validateSubjectRecord,
  type ValidationProblem,
} from '@/services/persistence/v2/validation';

// ── The layout ────────────────────────────────────────────────────────────

/** Which product this module reads. */
export const FULL_DEVICE_PRODUCT: DataProductKind = 'kdbak';

/** The product format version this build writes and accepts. */
export const FULL_DEVICE_FORMAT_VERSION = DATA_PRODUCT_FORMAT_VERSIONS[FULL_DEVICE_PRODUCT];

/** The two member names the plan fixes by name. */
export const FULL_DEVICE_MANIFEST_MEMBER = 'manifest.json';
export const FULL_DEVICE_STATE_MEMBER = 'state.json';

/**
 * The three member-name prefixes the plan allows, without the trailing slash.
 *
 * A member name is acceptable when it is one of the two fixed names, or a
 * content-addressed or opaque-index name under one of these three. A name that
 * carries a subject id, a room id, a topic, a note, or a filename is not a
 * member name: it is learner content that escaped into the filesystem-shaped
 * part of the archive.
 */
export const FULL_DEVICE_MEMBER_PREFIXES = ['attachments', 'custom-sprites', 'recovery'] as const;

export type FullDeviceMemberPrefix = (typeof FULL_DEVICE_MEMBER_PREFIXES)[number];

/** Lowercase 64-hex: the content-addressed member-name shape. */
const CONTENT_HASH_NAME = /^[0-9a-f]{64}$/;

/** A short, opaque, non-descriptive index segment. */
const OPAQUE_INDEX_SEGMENT = /^[a-z0-9]{6,24}$/;

/** A short, opaque extension segment. */
const OPAQUE_INDEX_EXTENSION = /^[a-z0-9]{1,12}$/;

/** How one member name relates to the plan's layout. */
export type MemberNameVerdict =
  | { readonly kind: 'fixed-name' }
  | { readonly kind: 'content-addressed'; readonly contentHash: string }
  | { readonly kind: 'opaque-index'; readonly prefix: FullDeviceMemberPrefix; readonly extension: string }
  | { readonly kind: 'directory-entry' }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Classify one member name against the plan's layout.
 *
 * The reasons are fixed, code-shaped strings: they name a *property* of the name
 * and never the name itself, so a rejection cannot leak what it rejected.
 */
export function classifyFullDeviceMemberName(path: string): MemberNameVerdict {
  if (path === FULL_DEVICE_MANIFEST_MEMBER || path === FULL_DEVICE_STATE_MEMBER) {
    return { kind: 'fixed-name' };
  }
  if (typeof path !== 'string' || path.length === 0) {
    return { kind: 'rejected', reason: 'empty-path' };
  }
  if (path.includes('\\')) return { kind: 'rejected', reason: 'backslash-separator' };
  if (path.startsWith('//')) return { kind: 'rejected', reason: 'unc-path' };
  if (path.startsWith('/')) return { kind: 'rejected', reason: 'absolute-path' };
  if (/^[a-zA-Z]:/.test(path)) return { kind: 'rejected', reason: 'drive-letter' };
  if (/[\u0000-\u001f\u007f]/.test(path)) return { kind: 'rejected', reason: 'control-character' };
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    return { kind: 'rejected', reason: 'parent-traversal' };
  }
  // A trailing slash is the ZIP convention for a directory entry, and it is
  // separated out here so the caller can accept-and-ignore it rather than
  // mistake it for an unexpected member.
  if (isDirectoryEntryName(path)) {
    return FULL_DEVICE_MEMBER_PREFIXES.includes(path.slice(0, -1) as FullDeviceMemberPrefix)
      ? { kind: 'directory-entry' }
      : { kind: 'rejected', reason: 'unknown-prefix' };
  }
  if (segments.some((segment) => segment.length === 0)) {
    return { kind: 'rejected', reason: 'empty-segment' };
  }
  if (segments.length < 2) {
    // A bare word at the archive root. The layout is prefix/name, so there is
    // nowhere for it to go and no prefix to hold it.
    return { kind: 'rejected', reason: 'not-under-a-member-prefix' };
  }
  if (segments.length > 2) {
    return { kind: 'rejected', reason: 'nested-too-deep' };
  }
  const [prefix, name] = segments as [string, string];
  if (!FULL_DEVICE_MEMBER_PREFIXES.includes(prefix as FullDeviceMemberPrefix)) {
    return { kind: 'rejected', reason: 'unknown-prefix' };
  }
  if (prefix === 'attachments') {
    return CONTENT_HASH_NAME.test(name)
      ? { kind: 'content-addressed', contentHash: name }
      : { kind: 'rejected', reason: 'descriptive-member-name' };
  }
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const stem = name.slice(0, dot);
    const extension = name.slice(dot + 1);
    if (OPAQUE_INDEX_SEGMENT.test(stem) && OPAQUE_INDEX_EXTENSION.test(extension)) {
      return { kind: 'opaque-index', prefix: prefix as FullDeviceMemberPrefix, extension };
    }
  }
  return { kind: 'rejected', reason: 'descriptive-member-name' };
}

// ── The manifest ──────────────────────────────────────────────────────────

/** The manifest's exact key set. Nothing may be added and nothing may be dropped. */
export const FULL_DEVICE_MANIFEST_KEYS = [
  'product',
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
  'createdAt',
  'memberCount',
  'totalBytes',
  'contentChecksum',
  'recordCounts',
  'attachmentBytes',
  'externalOnlyAttachments',
  'members',
] as const;

export type FullDeviceManifestKey = (typeof FULL_DEVICE_MANIFEST_KEYS)[number];

/** The `members[]` entry key set: a path, a length, and a digest. Nothing else. */
export const FULL_DEVICE_MANIFEST_MEMBER_KEYS = ['path', 'byteLength', 'sha256'] as const;

/** The `attachmentBytes` sub-document key set. */
export const FULL_DEVICE_ATTACHMENT_BYTES_KEYS = ['memberCount', 'byteLength'] as const;

/** The `externalOnlyAttachments` sub-document key set. */
export const FULL_DEVICE_EXTERNAL_ONLY_KEYS = ['count', 'reasons'] as const;

export interface FullDeviceManifestMember {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface FullDeviceManifest {
  readonly product: DataProductKind;
  /** The `.kdbak` layout version. A separate contract from the two below. */
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
  readonly recordCounts: Readonly<Record<StorageV2StoreName, number>>;
  readonly attachmentBytes: { readonly memberCount: number; readonly byteLength: number };
  readonly externalOnlyAttachments: {
    readonly count: number;
    readonly reasons: Readonly<Record<string, number>>;
  };
  readonly members: readonly FullDeviceManifestMember[];
}

/**
 * The manifest's counting rule, stated once because it is the only place the two
 * member counts can diverge.
 *
 * `memberCount` is the number of entries in `members[]`, and `members[]`
 * describes every member **except** `manifest.json` itself: a member cannot
 * contain its own digest, so the manifest is not self-describing. An archive's
 * total member count is therefore `memberCount + 1`, and a reader that compares
 * `memberCount` with `members.length` must get equality.
 */
export const FULL_DEVICE_MANIFEST_OMITS_ITSELF = true;

/** The roll-up digest over the declared members. Order is the manifest's order. */
export function fullDeviceManifestContentChecksum(
  members: readonly FullDeviceManifestMember[],
): string {
  return sha256Hex(
    new TextEncoder().encode(members.map((member) => `${member.sha256} ${member.path}`).join('\n')),
  );
}

// ── The state document ────────────────────────────────────────────────────

/**
 * The record sections of `state.json`, in the order the plan lists them.
 *
 * `attachmentBlobs` is deliberately absent: attachment **bytes** are members,
 * addressed by their content hash. What is in `state.json` is the attachment
 * *metadata* that says which hash an attachment has.
 */
export const FULL_DEVICE_STATE_SECTIONS = [
  'subjects',
  'progression',
  'sessions',
  'preferences',
  'shortcuts',
  'assistance',
  'attachmentMetadata',
  'customSprites',
  'recovery',
  'migrationReceipts',
] as const;

export type FullDeviceStateSection = (typeof FULL_DEVICE_STATE_SECTIONS)[number];

/**
 * The three version fields, as three names.
 *
 * Plan section 12, rule 4 keeps the data product format version, the storage
 * generation format version, and the subject schema version apart. They are
 * written, validated, and refused separately here; a single `version` field
 * cannot hold all three, because two are integers and one is a semver string.
 */
export const FULL_DEVICE_VERSION_KEYS = [
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
] as const;

/** The remaining document keys, outside the record sections. */
export const FULL_DEVICE_STATE_KEYS = [
  ...FULL_DEVICE_VERSION_KEYS,
  'createdAt',
  'sourceGenerationId',
  'activeSubjectId',
  'locale',
  'questState',
  ...FULL_DEVICE_STATE_SECTIONS,
] as const;

function validationFailure(
  reason: string,
  details: StorageV2ErrorDetails = {},
): StorageV2Error {
  // A refusal that counts zero problems is the D1 defect in a second form: the
  // error would assert "this is invalid" and "nothing is wrong" in one breath, and
  // a caller triaging on the count would conclude the archive was fine. The count
  // is a programming error if it reaches here, so it fails loudly and immediately
  // rather than being published as a plausible-looking refusal.
  const problemCount = details.problemCount;
  if (typeof problemCount === 'number' && problemCount < 1) {
    // The offending value is not interpolated: a throw that echoed it would be the
    // leak this module's detail rule exists to prevent.
    throw new TypeError(
      `validation refusal "${reason}" was asked to report a non-positive problem count.`,
    );
  }
  return new StorageV2Error('VALIDATION_FAILED', {
    reason,
    // The policy that decided this, in every problem-count refusal, so a caller can
    // tell *which* rule refused it without reading this module's source.
    ...(problemCount === undefined ? {} : { policy: MIGRATION_BLOCKING_POLICY }),
    ...details,
  });
}

// ── Reading and validating an archive ─────────────────────────────────────

/**
 * The sanitized view of an archive: everything a preview may show and a report
 * may carry, and nothing else.
 *
 * No subject name, room topic, note content, attachment filename, attachment
 * URL, or absolute path appears anywhere in this shape. `members` is a list of
 * paths, lengths, and digests; `recordCounts` is a histogram; and
 * `externalOnlyAttachments` is a list of opaque ids with a null hash.
 */
export interface FullDeviceArchivePreview {
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
  readonly recordCounts: Readonly<Record<StorageV2StoreName, number>>;
  readonly attachmentBytes: { readonly memberCount: number; readonly byteLength: number };
  readonly memberNames: readonly string[];
  readonly members: readonly FullDeviceManifestMember[];
  /** Directory entries that were accepted and ignored, by prefix. */
  readonly ignoredDirectoryEntries: readonly string[];
  readonly externalOnlyAttachments: readonly ExternalOnlyAttachmentReport[];
  readonly externalOnlyCount: number;
  /** The active-subject id the archive names, or `null` when it names none. */
  readonly activeSubjectId: string | null;
  /**
   * Non-blocking validation problems found while reading, disclosed not dropped.
   *
   * A problem with `error` severity refuses the read, so it can never appear
   * here; {@link MIGRATION_BLOCKING_POLICY} is the single rule that decides
   * which is which, and the same rule the importer applies. This is the shape a
   * caller can render counts from, and it is deliberately the same shape the
   * storage-v2 validation report uses, so a screen learns one contract.
   */
  readonly problems: readonly ValidationProblem[];
  /** The policy that separated {@link problems} from the refusals. */
  readonly blockingPolicy: MigrationBlockingPolicy;
}

/**
 * The importer's view of an archive: the preview **plus** the learner's own
 * bytes.
 *
 * This type carries subject names, topics, notes, filenames, and external URLs,
 * because that is what a backup is. It must never be rendered, logged, attached
 * to a bug report, or put in an error. The name says so; a caller that reaches
 * for `preview` when it wants `contents` is therefore visible in review.
 */
export interface FullDeviceArchiveContents {
  readonly preview: FullDeviceArchivePreview;
  /** The `state.json` document, verbatim. Learner data. */
  readonly state: Record<string, unknown>;
  /** Member bytes by path. Learner data. */
  readonly memberBytes: ReadonlyMap<string, Uint8Array>;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Only these names may be refused outright, before they are interpreted.
 *
 * A member name is attacker-controlled. `__proto__` in particular cannot be an
 * ordinary object key: assigning it changes the object's prototype rather than
 * adding a member, so a reader that indexed members by name would lose the
 * member silently. Every name that exists on `Object.prototype` is refused for
 * the same reason, and the closed layout has no place for any of them.
 */
/**
 * Whether a name is one that cannot be an ordinary own key of a plain object.
 *
 * `__proto__` changes an object's prototype instead of adding a member, and the
 * rest of `Object.prototype`'s own names shadow inherited methods. A member name
 * is attacker-controlled, so both are refused rather than indexed.
 *
 * Exported because the rule is not only about archive members: the same reasoning
 * applies to any identifier this product adopts from an archive, and
 * `fullDeviceBackup.ts` applies it to a generation label - which is a *database
 * key*, where a prototype name is at least as hazardous as it is in a member name.
 */
export function isPrototypeMemberName(name: string): boolean {
  return name === UNREPRESENTABLE_MEMBER_NAME || Object.hasOwn(Object.prototype, name);
}

function readMembers(bytes: Uint8Array): { files: readonly ArchiveFile[]; ignored: readonly string[] } {
  const ignored: string[] = [];
  try {
    const files = readArchive(bytes, {
      acceptDirectoryEntry: (name) => {
        // A directory entry under one of the plan's three prefixes is metadata.
        // It is recorded as ignored and never becomes a member, so it can never be
        // counted, declared, or treated as an unexpected extra member.
        if (!FULL_DEVICE_MEMBER_PREFIXES.includes(name.slice(0, -1) as FullDeviceMemberPrefix)) {
          return false;
        }
        ignored.push(name);
        return true;
      },
    });
    return { files, ignored };
  } catch (error) {
    // The codec reports one outcome - "these bytes are not a readable ZIP" - for
    // three different problems, and each of them deserves its own reason:
    // a file that is not a ZIP at all, a file that stops mid-member, and a file
    // whose members are all present but whose index is not. The classifier reads
    // fixed header fields and inflates nothing; see `classifyUnreadableArchive`.
    if (error instanceof StorageV2Error && error.code === 'ARCHIVE_MALFORMED' && error.details.reason === 'unzip-failed') {
      const shape = classifyUnreadableArchive(bytes);
      if (shape !== 'unreadable-with-end-of-central-directory') {
        throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: shape });
      }
    }
    throw error;
  }
}

/**
 * Refuse an entry whose recorded POSIX mode says it is not a file.
 *
 * A trailing slash is a naming convention and is accepted-and-ignored above. A
 * recorded `S_IFDIR` or `S_IFLNK` is a *claim about the member*, and a backup
 * member is data: a member that would be materialised as a directory or as a link
 * is refused rather than interpreted.
 *
 * The entry names are taken from the central directory rather than from the read
 * result, so an entry that was accepted-and-ignored as directory metadata is
 * still classified. That is the whole distinction: `attachments/` written by
 * ordinary ZIP tooling carries no POSIX mode and is metadata, while an entry that
 * *declares itself* a directory is a claim and is refused.
 */
function assertEntriesAreData(bytes: Uint8Array, entryNames: readonly string[]): void {
  const types = classifyArchiveMemberTypes(bytes, entryNames);
  for (const name of entryNames) {
    const type = types.get(name);
    if (type === 'symlink') {
      throw new StorageV2Error('ARCHIVE_UNSAFE_PATH', { reason: 'symlink-member' });
    }
    if (type === 'directory') {
      throw new StorageV2Error('ARCHIVE_UNSAFE_PATH', { reason: 'directory-entry' });
    }
    if (type === 'other-special') {
      throw new StorageV2Error('ARCHIVE_UNSAFE_PATH', { reason: 'special-member' });
    }
  }
}

/**
 * No member may be read and then silently discarded.
 *
 * fflate assigns each member name onto a plain object, so a name that cannot be
 * an ordinary key - `__proto__` above all - sets the prototype instead of adding
 * a member: its bytes are inflated and then dropped, with no error. Comparing the
 * archive's own central-directory entry list against the members that came back
 * is the only way to see that happened.
 *
 * A dropped member is refused rather than tolerated, because "we read those bytes
 * and threw them away" is indistinguishable from data loss once the archive is
 * on another device.
 */
function assertNoMemberWasDropped(
  entryNames: readonly string[],
  memberNames: ReadonlySet<string>,
): void {
  for (const name of entryNames) {
    // A directory entry is dropped *on purpose*, by the caller's own predicate,
    // and is recorded as ignored.
    if (isDirectoryEntryName(name)) continue;
    if (memberNames.has(name)) continue;
    if (isPrototypeMemberName(name)) {
      throw new StorageV2Error('ARCHIVE_UNSAFE_PATH', { reason: 'prototype-member-name' });
    }
    throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'member-dropped' });
  }
}

/**
 * Per-member safety, before anything is interpreted.
 *
 * Three things, all of them about the *name*: a name that could escape the
 * extraction root, a name that is an `Object.prototype` key, and a name that
 * appears twice.
 *
 * What this deliberately does **not** do is judge whether a name belongs to the
 * layout. A safe name that the layout does not define is a different problem
 * with a different answer, and it is reported by the manifest comparison as an
 * unexpected member - which is the honest place for it, because "the layout is
 * closed" is a statement about the *declared* member set.
 */
function assertMemberNamesAreSafe(files: readonly ArchiveFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (isPrototypeMemberName(file.path)) {
      // A prototype key is refused as an unsafe path rather than as a layout
      // error: the hazard is that an object-keyed index would lose it, not that
      // the layout dislikes it.
      throw new StorageV2Error('ARCHIVE_UNSAFE_PATH', { reason: 'prototype-member-name' });
    }
    const unsafe = describeUnsafeArchivePath(file.path);
    if (unsafe !== null) {
      throw new StorageV2Error('ARCHIVE_UNSAFE_PATH', { reason: unsafe });
    }
    if (seen.has(file.path)) {
      throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'duplicate-member' });
    }
    seen.add(file.path);
  }
}

/**
 * Every member the manifest declares must have a name the layout allows.
 *
 * Without this an archive could declare - and carry - a member under a prefix the
 * plan does not have, and the member-set comparison would be satisfied by the
 * manifest agreeing with itself.
 */
function assertDeclaredNamesAreInLayout(manifest: FullDeviceManifest): void {
  for (const member of manifest.members) {
    const verdict = classifyFullDeviceMemberName(member.path);
    if (verdict.kind === 'rejected') {
      throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'member-name-not-in-layout' });
    }
    if (verdict.kind === 'directory-entry') {
      throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'member-name-not-in-layout' });
    }
  }
}

function validateManifestShape(manifest: unknown): FullDeviceManifest {
  if (!isRecordObject(manifest)) {
    // `field` carries a *name*, never the offending value, and it has to be
    // code-shaped or the `StorageV2Error` constructor refuses the detail and
    // throws a `TypeError` instead - which would turn a typed refusal into an
    // untyped one.
    throw validationFailure('manifest-wrong-type', { field: 'manifest' });
  }
  const declared = Object.keys(manifest).sort();
  // `string[]`, not the literal union: the key being looked for is itself a string
  // read out of an untrusted object, and `Array.includes` on a literal-union array
  // would refuse to accept it.
  const required: readonly string[] = [...FULL_DEVICE_MANIFEST_KEYS].sort();
  for (const key of required) {
    if (!declared.includes(key)) {
      throw validationFailure('manifest-missing-field', { field: key });
    }
  }
  for (const key of declared) {
    if (!required.includes(key)) {
      // A closed key set at format version 1. An extra key is how a version
      // conflation, or a future field, would arrive unnoticed.
      throw validationFailure('manifest-unexpected-field', { field: key });
    }
  }

  if (manifest.product !== FULL_DEVICE_PRODUCT) {
    throw validationFailure('unsupported-product', { field: 'product' });
  }
  if (!isInteger(manifest.formatVersion)) {
    throw validationFailure('manifest-invalid-field', { field: 'formatVersion' });
  }
  if (!isInteger(manifest.storageGenerationFormatVersion)) {
    throw validationFailure('manifest-invalid-field', { field: 'storageGenerationFormatVersion' });
  }
  if (typeof manifest.subjectSchemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.subjectSchemaVersion)) {
    throw validationFailure('manifest-invalid-field', { field: 'subjectSchemaVersion' });
  }
  if (typeof manifest.createdAt !== 'string' || manifest.createdAt.length === 0) {
    throw validationFailure('manifest-invalid-field', { field: 'createdAt' });
  }
  if (!Array.isArray(manifest.members)) {
    throw validationFailure('manifest-invalid-field', { field: 'members' });
  }

  const members: FullDeviceManifestMember[] = [];
  manifest.members.forEach((entry, index) => {
    if (!isRecordObject(entry)) {
      throw validationFailure('manifest-invalid-field', { field: 'members' });
    }
    const memberKeys = Object.keys(entry).sort();
    const memberRequired: readonly string[] = [...FULL_DEVICE_MANIFEST_MEMBER_KEYS].sort();
    for (const key of memberRequired) {
      if (!memberKeys.includes(key)) {
        throw validationFailure('manifest-invalid-field', { field: 'members', index });
      }
    }
    for (const key of memberKeys) {
      if (!memberRequired.includes(key)) {
        throw validationFailure('manifest-invalid-field', { field: 'members', index });
      }
    }
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
  const recordCountKeys = Object.keys(manifest.recordCounts).sort();
  const storeNames: readonly string[] = [...STORAGE_V2_STORE_NAMES].sort();
  for (const key of storeNames) {
    if (!recordCountKeys.includes(key) || !isInteger(manifest.recordCounts[key])) {
      throw validationFailure('manifest-invalid-field', { field: 'recordCounts' });
    }
  }
  for (const key of recordCountKeys) {
    if (!storeNames.includes(key)) {
      throw validationFailure('manifest-invalid-field', { field: 'recordCounts' });
    }
  }
  const recordCounts: Record<StorageV2StoreName, number> = {} as Record<StorageV2StoreName, number>;
  for (const storeName of STORAGE_V2_STORE_NAMES) {
    recordCounts[storeName] = manifest.recordCounts[storeName] as number;
  }
  void storeNames;

  if (!isRecordObject(manifest.attachmentBytes)) {
    throw validationFailure('manifest-invalid-field', { field: 'attachmentBytes' });
  }
  const attachmentBytesKeys = Object.keys(manifest.attachmentBytes).sort();
  const attachmentBytesRequired: readonly string[] = [...FULL_DEVICE_ATTACHMENT_BYTES_KEYS].sort();
  for (const key of attachmentBytesRequired) {
    if (!attachmentBytesKeys.includes(key)) {
      throw validationFailure('manifest-invalid-field', { field: 'attachmentBytes' });
    }
  }
  for (const key of attachmentBytesKeys) {
    if (!attachmentBytesRequired.includes(key)) {
      throw validationFailure('manifest-invalid-field', { field: 'attachmentBytes' });
    }
  }
  if (!isInteger(manifest.attachmentBytes.memberCount) || !isInteger(manifest.attachmentBytes.byteLength)) {
    throw validationFailure('manifest-invalid-field', { field: 'attachmentBytes' });
  }

  if (!isRecordObject(manifest.externalOnlyAttachments)) {
    throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
  }
  const externalKeys = Object.keys(manifest.externalOnlyAttachments).sort();
  const externalRequired: readonly string[] = [...FULL_DEVICE_EXTERNAL_ONLY_KEYS].sort();
  for (const key of externalRequired) {
    if (!externalKeys.includes(key)) {
      throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
    }
  }
  for (const key of externalKeys) {
    if (!externalRequired.includes(key)) {
      throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
    }
  }
  if (!isInteger(manifest.externalOnlyAttachments.count)) {
    throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
  }
  if (!isRecordObject(manifest.externalOnlyAttachments.reasons)) {
    throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
  }
  const reasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(manifest.externalOnlyAttachments.reasons)) {
    if (!/^[a-z][a-z0-9-]*$/.test(reason) || !isInteger(count)) {
      throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
    }
    reasons[reason] = count;
  }
  if (!isInteger(manifest.memberCount) || !isInteger(manifest.totalBytes)) {
    throw validationFailure('manifest-invalid-field', { field: 'memberCount' });
  }
  if (typeof manifest.contentChecksum !== 'string' || !CONTENT_HASH_NAME.test(manifest.contentChecksum)) {
    throw validationFailure('manifest-invalid-field', { field: 'contentChecksum' });
  }

  return {
    product: FULL_DEVICE_PRODUCT,
    formatVersion: manifest.formatVersion,
    storageGenerationFormatVersion: manifest.storageGenerationFormatVersion,
    subjectSchemaVersion: manifest.subjectSchemaVersion,
    createdAt: manifest.createdAt,
    memberCount: manifest.memberCount,
    totalBytes: manifest.totalBytes,
    contentChecksum: manifest.contentChecksum,
    recordCounts,
    attachmentBytes: {
      memberCount: manifest.attachmentBytes.memberCount,
      byteLength: manifest.attachmentBytes.byteLength,
    },
    externalOnlyAttachments: { count: manifest.externalOnlyAttachments.count, reasons },
    members,
  };
}

/**
 * Refuse an archive whose three version contracts this build cannot honour.
 *
 * All three are separate refusals with separate reasons, because they fail for
 * different reasons and a caller that merged them would not know which contract
 * it was violating. The subject schema refusal is the one that stops a *newer*
 * backup being silently restored into an older build and losing data.
 */
function assertSupportedVersions(
  formatVersion: number,
  storageGenerationFormatVersion: number,
  subjectSchemaVersion: string,
): void {
  if (formatVersion !== FULL_DEVICE_FORMAT_VERSION) {
    throw validationFailure('unsupported-product-format-version');
  }
  if (storageGenerationFormatVersion !== STORAGE_V2_GENERATION_FORMAT_VERSION) {
    throw validationFailure('unsupported-storage-format-version');
  }
  if (subjectSchemaVersion !== CANONICAL_SUBJECT_SCHEMA_VERSION) {
    throw validationFailure('unsupported-subject-schema-version');
  }
}

function assertManifestCountsAgree(manifest: FullDeviceManifest): void {
  if (manifest.memberCount !== manifest.members.length) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const declaredBytes = manifest.members.reduce((total, member) => total + member.byteLength, 0);
  if (manifest.totalBytes !== declaredBytes) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const attachmentMembers = manifest.members.filter((member) => member.path.startsWith('attachments/'));
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
  if (manifest.externalOnlyAttachments.count < 0) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
}

function assertManifestContentChecksum(manifest: FullDeviceManifest): void {
  if (fullDeviceManifestContentChecksum(manifest.members) !== manifest.contentChecksum) {
    throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'manifest-content-checksum-mismatch' });
  }
}

/** The declared member set, the actual member set, and the manifest must agree. */
function assertMemberSetsAgree(manifest: FullDeviceManifest, files: readonly ArchiveFile[]): void {
  const actual = new Set(files.map((file) => file.path));
  actual.delete(FULL_DEVICE_MANIFEST_MEMBER);
  for (const member of manifest.members) {
    if (!actual.has(member.path)) {
      throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'missing-declared-member' });
    }
  }
  const declared = new Set(manifest.members.map((member) => member.path));
  for (const path of actual) {
    if (!declared.has(path)) {
      throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'unexpected-member' });
    }
  }
}

/**
 * Every member is what the manifest says it is.
 *
 * Two independent claims are checked, because they can disagree and each is a
 * real corruption in its own right:
 *
 * - the member's bytes hash to the digest the manifest declared for it, and
 * - an `attachments/<sha256>` member's bytes hash to **its own name**, because
 *   content addressing is the plan's contract for that prefix rather than a
 *   label the writer chose.
 */
function assertMemberChecksums(
  manifest: FullDeviceManifest,
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
    if (member.path.startsWith('attachments/')) {
      if (member.path.slice('attachments/'.length) !== member.sha256) {
        throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'member-checksum-mismatch' });
      }
    }
  }
}

function validateStateShape(state: unknown): Record<string, unknown> {
  if (!isRecordObject(state)) {
    throw validationFailure('state-wrong-shape', { field: 'state' });
  }
  for (const key of FULL_DEVICE_VERSION_KEYS) {
    if (!(key in state)) {
      throw validationFailure('state-wrong-shape', { field: key });
    }
  }
  // A wrong *type* is a shape problem and is reported as one; a wrong *value* is
  // a version problem and is reported by `assertSupportedVersions`, which is the
  // only place the subject-schema refusal is made.
  if (!isInteger(state.formatVersion)) {
    throw validationFailure('state-wrong-shape', { field: 'formatVersion' });
  }
  if (!isInteger(state.storageGenerationFormatVersion)) {
    throw validationFailure('state-wrong-shape', { field: 'storageGenerationFormatVersion' });
  }
  if (typeof state.subjectSchemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(state.subjectSchemaVersion)) {
    throw validationFailure('state-wrong-shape', { field: 'subjectSchemaVersion' });
  }
  if (typeof state.createdAt !== 'string' || state.createdAt.length === 0) {
    throw validationFailure('state-wrong-shape', { field: 'createdAt' });
  }
  for (const key of ['sourceGenerationId', 'activeSubjectId', 'locale'] as const) {
    if (key in state && state[key] !== null && typeof state[key] !== 'string') {
      throw validationFailure('state-wrong-shape', { field: key });
    }
  }
  for (const section of FULL_DEVICE_STATE_SECTIONS) {
    if (!Array.isArray(state[section])) {
      throw validationFailure('state-wrong-shape', { field: section });
    }
  }
  return state;
}

/**
 * Run the application's own per-record validators over the state document.
 *
 * Reuse rather than reimplement: a record the storage-v2 repository would refuse
 * to activate must be refused here too, or the preview would promise a restore
 * the import cannot deliver.
 *
 * ## D1: a warning is a disclosure, not a refusal
 *
 * The refusal decision is {@link MIGRATION_BLOCKING_POLICY}, applied through
 * {@link isActivationBlocking} via {@link partitionMigrationProblems} - the *same*
 * single policy `importFullDeviceBackup` gates on. Refusing on the *total* problem
 * count made this reader stricter than the importer it feeds, and the consequence
 * was the worst kind of data bug: a device storage-v2 was perfectly happy with
 * could take a backup it could never restore, because the archive the product
 * itself wrote was refused on read with an error whose own `problemCount` was `0`.
 *
 * Non-blocking problems are therefore **returned**, not dropped. A disclosure is
 * the entire point of a warning, and a reader that threw them away would be
 * reporting the same state as one with no problems at all.
 *
 * @returns the non-blocking problems, for the preview to disclose.
 */
function validateStateRecords(state: Record<string, unknown>): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const section = <T>(name: FullDeviceStateSection): T[] => state[name] as T[];

  const run = <T>(
    name: FullDeviceStateSection,
    validate: (value: T) => { problems: ValidationProblem[] },
  ): void => {
    for (const value of section<T>(name)) {
      if (!isRecordObject(value)) {
        problems.push({ code: 'not-an-object', scope: scopeFor(name), count: 1, severity: 'error' });
        continue;
      }
      problems.push(...validate(value).problems);
    }
  };

  run('subjects', validateSubjectRecord);
  run('progression', validateProgressionRecord);
  run('sessions', validateSessionRecord);
  run('preferences', validatePreferenceRecord);
  run('shortcuts', validateShortcutRecord);
  run('assistance', validateAssistanceRecord);
  run('attachmentMetadata', validateAttachmentMetadataRecord);
  run('customSprites', validateCustomSpriteRecord);
  run('recovery', validateRecoveryRecord);
  run('migrationReceipts', validateMigrationReceipt);

  const { blocking, disclosed } = partitionMigrationProblems(problems);
  if (blocking.length > 0) {
    throw validationFailure('state-record-invalid', { problemCount: countBlockingProblems(problems) });
  }
  return disclosed;
}

function scopeFor(name: FullDeviceStateSection): ValidationProblem['scope'] {
  switch (name) {
    case 'subjects':
      return 'subject';
    case 'progression':
      return 'progression';
    case 'sessions':
      return 'session';
    case 'preferences':
      return 'preference';
    case 'shortcuts':
      return 'shortcut';
    case 'assistance':
      return 'assistance';
    case 'attachmentMetadata':
      return 'attachment';
    case 'customSprites':
      return 'custom-sprite';
    case 'recovery':
      return 'recovery';
    case 'migrationReceipts':
      return 'migration-receipt';
  }
}

/**
 * The disclosure reason an attachment whose bytes the archive does not carry gets.
 *
 * One rule, used by the export when it writes the manifest and by the import when
 * it rebuilds the records, because the manifest's reason histogram and the
 * importer's disclosure set are cross-checked against each other: if the two
 * could disagree, a perfectly honest export would be refused by its own importer.
 *
 * - An `external` attachment is a user-supplied URL the application never fetches,
 *   so its bytes are `historical-external-url`.
 * - A `local` attachment is `bytes-not-recoverable` whenever the archive does not
 *   carry the bytes its record names: absent, or present but hashing to something
 *   other than the record's declared content hash. Both are the same statement -
 *   "these are not the bytes this record says they are" - and neither is a reason
 *   to invent a hash.
 */
export const FULL_DEVICE_EXTERNAL_ONLY_REASON_BY_SOURCE: Readonly<
  Record<string, ExternalOnlyAttachmentReport['reason']>
> = {
  external: 'historical-external-url',
  local: 'bytes-not-recoverable',
};

export function fullDeviceExternalOnlyReason(
  record: { readonly sourceType?: string },
): ExternalOnlyAttachmentReport['reason'] {
  return record.sourceType === 'external'
    ? 'historical-external-url'
    : 'bytes-not-recoverable';
}

/**
 * The archive's own disclosure set, read out of `state.json`.
 *
 * Every entry has `contentHash: null` and `byteLength: null`. An attachment whose
 * bytes are not in the archive has no content to hash and no length to report,
 * and a fabricated digest would misreport what the backup contains (plan
 * section 2.3). The sub-document in the manifest carries only a count and a
 * reason histogram precisely so the *ids* live here, on the importer's side.
 */
function disclosureSet(
  state: Record<string, unknown>,
  manifest: FullDeviceManifest,
  availableContentHashes: ReadonlySet<string>,
): ExternalOnlyAttachmentReport[] {
  const metadata = (state.attachmentMetadata ?? []) as Record<string, unknown>[];
  const disclosures: ExternalOnlyAttachmentReport[] = [];
  for (const record of metadata) {
    if (!isRecordObject(record)) continue;
    const storedBytesPresent =
      record.availability === 'stored' &&
      typeof record.contentHash === 'string' &&
      availableContentHashes.has(record.contentHash);
    if (storedBytesPresent) continue;
    disclosures.push({
      attachmentId: String(record.attachmentId ?? ''),
      subjectId: String(record.subjectId ?? ''),
      roomId: String(record.roomId ?? ''),
      contentHash: null,
      byteLength: null,
      // The same rule the export used, so the manifest's histogram and this set
      // are the same statement and the cross-check below can hold.
      reason: fullDeviceExternalOnlyReason(record),
      sourceType: record.sourceType === 'external' ? 'external' : 'local',
    });
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
 * Read and validate a `.kdbak`, and touch no stored data.
 *
 * Synchronous on purpose: everything it needs is in the bytes, so a caller can
 * use it inside a `FileReader` callback or an `onchange` handler without
 * introducing a pending state, and so a failure is a thrown typed error rather
 * than a promise that has to be awaited before the learner can be told anything.
 *
 * Throws a {@link StorageV2Error} for every rejection. The codes and reasons are
 * the product contract; the message is fixed per code and the details carry only
 * codes, counts, and lengths.
 */
export function readFullDeviceArchiveContents(bytes: Uint8Array): FullDeviceArchiveContents {
  if (!(bytes instanceof Uint8Array)) {
    throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'not-bytes' });
  }

  // ── 1. Structure ──
  const { files, ignored } = readMembers(bytes);
  if (files.length === 0) {
    throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'no-members' });
  }
  const entryNames = readArchiveEntryNames(bytes);
  // Both structural checks run against the archive's *own* account of its
  // contents, not only against what came back, so an entry the codec could not
  // represent is caught here rather than being missing without an error.
  assertNoMemberWasDropped(entryNames, new Set(files.map((file) => file.path)));
  assertEntriesAreData(bytes, entryNames);
  assertMemberNamesAreSafe(files);

  const bytesByPath = new Map<string, Uint8Array>();
  for (const file of files) bytesByPath.set(file.path, file.bytes);

  // ── 2. The two fixed members ──
  if (!bytesByPath.has(FULL_DEVICE_MANIFEST_MEMBER)) {
    throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'no-manifest' });
  }
  if (!bytesByPath.has(FULL_DEVICE_STATE_MEMBER)) {
    throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'no-state' });
  }
  const manifest = validateManifestShape(decodeArchiveJsonMember(files, FULL_DEVICE_MANIFEST_MEMBER));
  assertSupportedVersions(
    manifest.formatVersion,
    manifest.storageGenerationFormatVersion,
    manifest.subjectSchemaVersion,
  );

  // The two fixed members are read and *interpreted* before the per-member
  // checksum sweep, in that order, and the reason is the order a person would use:
  // open the manifest, open the state, and only then ask whether every byte in the
  // file is what the manifest says it is. A file whose `state.json` has been
  // mangled should be told the state is unreadable, not that a digest disagrees -
  // and a file whose state is unreadable is corrupt either way.
  const state = validateStateShape(decodeArchiveJsonMember(files, FULL_DEVICE_STATE_MEMBER));
  // The state document carries its own copy of all three contracts, and they must
  // agree with the manifest's: one member cannot claim a newer subject schema
  // than the other, or the archive's declared contract is not a contract.
  assertSupportedVersions(
    state.formatVersion as number,
    state.storageGenerationFormatVersion as number,
    String(state.subjectSchemaVersion),
  );
  const disclosed = validateStateRecords(state);

  // ── 3. The manifest's claims about the rest of the file ──
  assertManifestCountsAgree(manifest);
  assertDeclaredNamesAreInLayout(manifest);
  assertManifestContentChecksum(manifest);
  assertMemberSetsAgree(manifest, files);
  assertMemberChecksums(manifest, bytesByPath);

  // ── 4. Index-addressed members, verified against the records they carry ──
  assertIndexedMembersMatchRecords(state, bytesByPath);

  const availableContentHashes = new Set(
    manifest.members
      .filter((member) => member.path.startsWith('attachments/'))
      .map((member) => member.path.slice('attachments/'.length)),
  );
  const disclosures = disclosureSet(state, manifest, availableContentHashes);

  const activeSubjectId = typeof state.activeSubjectId === 'string' ? state.activeSubjectId : null;

  return {
    preview: {
      product: manifest.product,
      formatVersion: manifest.formatVersion,
      storageGenerationFormatVersion: manifest.storageGenerationFormatVersion,
      subjectSchemaVersion: manifest.subjectSchemaVersion,
      createdAt: typeof state.createdAt === 'string' ? state.createdAt : manifest.createdAt,
      manifestCreatedAt: manifest.createdAt,
      memberCount: manifest.memberCount,
      totalMemberCount: manifest.memberCount + 1,
      totalBytes: manifest.totalBytes,
      contentChecksum: manifest.contentChecksum,
      recordCounts: manifest.recordCounts,
      attachmentBytes: manifest.attachmentBytes,
      memberNames: manifest.members.map((member) => member.path),
      members: manifest.members,
      ignoredDirectoryEntries: [...ignored].sort(),
      externalOnlyAttachments: disclosures,
      externalOnlyCount: manifest.externalOnlyAttachments.count,
      activeSubjectId,
      problems: disclosed,
      blockingPolicy: MIGRATION_BLOCKING_POLICY,
    },
    state,
    memberBytes: bytesByPath,
  };
}

/**
 * The stable, zero-padded, one-based index a record's member is addressed by.
 *
 * `000001`, `000002`, … The stem is opaque and the extension is the record's own
 * `kind` token for a custom sprite, or `json` for a recovery record - both are
 * fixed vocabulary, never a value a learner authored.
 */
export function fullDeviceIndexMemberName(position: number, extension: string): string {
  return `${String(position).padStart(6, '0')}.${extension}`;
}

/**
 * The `custom-sprites/*` and `recovery/*` members must be byte-for-byte the
 * records that `state.json` carries, in the order the document lists them.
 *
 * Those members are not decoration: they are the plan's separate member groups
 * for custom sprite data and recovery records, and the archive is only
 * self-consistent if the two copies agree. A member that disagrees is a corrupt
 * archive, and the direction of the disagreement does not matter.
 */
function assertIndexedMembersMatchRecords(
  state: Record<string, unknown>,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): void {
  const encoder = new TextEncoder();
  const sprites = state.customSprites as Record<string, unknown>[];
  sprites.forEach((record, index) => {
    const kind = isRecordObject(record) ? String(record.kind ?? '') : '';
    const path = `custom-sprites/${fullDeviceIndexMemberName(index + 1, kind)}`;
    const expected = encoder.encode(String(isRecordObject(record) ? record.content : ''));
    const actual = bytesByPath.get(path);
    if (actual === undefined) {
      throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'missing-declared-member' });
    }
    if (actual.length !== expected.length || !actual.every((byte, at) => byte === expected[at])) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'member-checksum-mismatch' });
    }
  });

  const recovery = state.recovery as Record<string, unknown>[];
  recovery.forEach((record, index) => {
    const path = `recovery/${fullDeviceIndexMemberName(index + 1, 'json')}`;
    const expected = encoder.encode(String(isRecordObject(record) ? record.raw : ''));
    const actual = bytesByPath.get(path);
    if (actual === undefined) {
      throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'missing-declared-member' });
    }
    if (actual.length !== expected.length || !actual.every((byte, at) => byte === expected[at])) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'member-checksum-mismatch' });
    }
  });
}

/**
 * Read and validate a `.kdbak` and return only what a preview may show.
 *
 * The Data Center calls this before a learner commits to anything, and it is the
 * only read path a UI needs: it touches no stored data, opens no database, and
 * returns counts, versions, digests, member names, and the disclosure set. What
 * it can therefore show **before** the learner confirms is: how many subjects,
 * progression records, sessions, preferences, shortcuts, assistance records,
 * attachment records, custom sprites, recovery records, and migration receipts the
 * archive carries; how many attachment members and how many attachment bytes;
 * which attachments cannot be restored and why; the three separate version
 * numbers; and the archive's own creation time.
 */
export function readFullDeviceArchive(bytes: Uint8Array): FullDeviceArchivePreview {
  return readFullDeviceArchiveContents(bytes).preview;
}

/** A preview outcome that cannot throw, for a UI that renders the failure. */
export type FullDeviceArchiveInspection =
  | { readonly ok: true; readonly preview: FullDeviceArchivePreview }
  | { readonly ok: false; readonly error: ReturnType<StorageV2Error['toReport']> };

/**
 * {@link readFullDeviceArchive} as a result rather than a throw.
 *
 * A preview is the one place where a failure is an expected outcome rather than
 * an exception, so this returns the same sanitized report the typed error
 * carries and never re-throws.
 */
export function inspectFullDeviceArchive(bytes: Uint8Array): FullDeviceArchiveInspection {
  try {
    return { ok: true, preview: readFullDeviceArchive(bytes) };
  } catch (error) {
    if (error instanceof StorageV2Error) return { ok: false, error: error.toReport() };
    return {
      ok: false,
      error: { code: 'ARCHIVE_MALFORMED' as StorageV2ErrorCode, details: { reason: 'unreadable' } },
    };
  }
}
