/**
 * Storage-v2 data contract.
 *
 * Three version concepts live here and are deliberately separate (plan section
 * 12, rule 4):
 *
 * - {@link STORAGE_V2_SCHEMA_VERSION} — the IndexedDB structural version. It
 *   changes only when an object store or index is added or removed.
 * - {@link STORAGE_V2_GENERATION_FORMAT_VERSION} — the shape of a generation
 *   record. It changes when a generation's fields change, independently of the
 *   database layout.
 * - The **subject schema version**, re-exported as
 *   {@link CANONICAL_SUBJECT_SCHEMA_VERSION} from the subject contract. It
 *   describes a subject snapshot and is never used as a storage version.
 *
 * Data product format versions (`.kdbak`, `.kdsubject`, `.kdtemplate`) are a
 * fourth concept and live in `src/core/validation/persistence/types.ts`.
 *
 * This module is types, constants, and a sanitized error type. It performs no
 * storage access and is renderer-neutral.
 */

import { CURRENT_SCHEMA_VERSION, type SubjectSnapshot } from '@/core/validation/persistence/types';
import type { RankTier } from '@/core/progression/types';
import type { ValidationProblem } from './validation';

// ── Versions ──────────────────────────────────────────────────────────────

/** IndexedDB structural version. Bump only for a store or index change. */
export const STORAGE_V2_SCHEMA_VERSION = 1;

/** Shape version of a generation record. Bump for a generation field change. */
export const STORAGE_V2_GENERATION_FORMAT_VERSION = 1;

/** The single active-generation pointer's own shape version. */
export const ACTIVE_GENERATION_POINTER_VERSION = 1;

/** Subject schema version storage-v2 writes. Kept separate from the above. */
export const CANONICAL_SUBJECT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

/** IndexedDB database name. The legacy `localStorage` keys are untouched. */
export const STORAGE_V2_DATABASE_NAME = 'knowledge-dungeon-storage-v2';

// ── Object stores ─────────────────────────────────────────────────────────

/**
 * The object stores, in creation order. Matches plan section 7.1 exactly.
 */
export const STORAGE_V2_STORE_NAMES = [
  'meta',
  'subjects',
  'progression',
  'sessions',
  'preferences',
  'shortcuts',
  'assistance',
  'attachments',
  'customSprites',
  'recovery',
  'migrationReceipts',
] as const;

export type StorageV2StoreName = (typeof STORAGE_V2_STORE_NAMES)[number];

/** Stores that hold one record per logical entity, indexed by generation. */
export const GENERATION_SCOPED_STORE_NAMES: readonly StorageV2StoreName[] = [
  'subjects',
  'progression',
  'sessions',
  'preferences',
  'shortcuts',
  'assistance',
  'attachments',
  'customSprites',
  'recovery',
];

/** Stores that are not generation-scoped: the pointer and the receipts. */
export const GLOBAL_STORE_NAMES: readonly StorageV2StoreName[] = ['meta', 'migrationReceipts'];

/** `meta` record key that holds the active-generation pointer. */
export const ACTIVE_GENERATION_META_KEY = 'activeGeneration';

/**
 * Owner tag stored on the active-generation pointer's own row.
 *
 * The pointer belongs to no generation - it is what names one - so it cannot be
 * tagged with a generation id. It also cannot be tagged with `null`, because a
 * compound IndexedDB key component must be a valid key and `null` is not one.
 * This sentinel keeps the pointer's primary key stable, which is what makes
 * re-pointing a plain update instead of a delete plus an insert.
 */
export const ACTIVE_GENERATION_META_OWNER = '@active-generation';

/** Prefix used for generation registry entries inside `meta`. */
export const GENERATION_META_KEY_PREFIX = 'generation:';

// ── Record envelope ───────────────────────────────────────────────────────

/**
 * Every stored record uses this envelope, so a record is always traceable to the
 * generation that owns it and can be checksummed without knowing its type.
 */
export interface StorageRecordEnvelope<TValue> {
  generationId: string;
  /** Identifier unique within (generationId, store). */
  recordId: string;
  value: TValue;
  /** Canonical-JSON SHA-256 of `value`, or `null` when not yet computed. */
  checksum: string | null;
  /** Injected ISO-8601 timestamp of the last write. */
  updatedAt: string;
}

/**
 * Envelope for the two `meta` record families: the active-generation pointer and
 * the generation registry.
 *
 * Data records are unconditionally tagged with their generation; see
 * {@link StorageRecordEnvelope}. A registry row is tagged with the generation it
 * describes, and the pointer row is tagged with
 * {@link ACTIVE_GENERATION_META_OWNER} because it is what names a generation.
 */
export interface MetaRecordEnvelope<TValue> {
  generationId: string;
  recordId: string;
  value: TValue;
  checksum: string | null;
  updatedAt: string;
}

// ── Record values ─────────────────────────────────────────────────────────

/** Lifecycle of a generation. A staged generation is invisible to readers. */
export type GenerationStatus = 'staged' | 'active' | 'superseded';

/** What produced a generation. Fixed set: no free text, so no learner data. */
export type StorageV2GenerationSource =
  | 'legacy-migration'
  | 'full-device-import'
  | 'subject-import'
  | 'initial'
  | 'local-edit';

export interface GenerationDescriptor {
  generationId: string;
  /** {@link STORAGE_V2_GENERATION_FORMAT_VERSION} at write time. */
  generationFormatVersion: number;
  /** {@link CANONICAL_SUBJECT_SCHEMA_VERSION} for this generation's subjects. */
  subjectSchemaVersion: string;
  status: GenerationStatus;
  source: StorageV2GenerationSource;
  /** Injected ISO-8601 timestamp. */
  createdAt: string;
  /** Injected ISO-8601 timestamp, or `null` while staged. */
  activatedAt: string | null;
  parentGenerationId: string | null;
  /** Record count per store, including `meta` and `migrationReceipts`. */
  recordCounts: Record<StorageV2StoreName, number>;
  /** Roll-up checksum over every record checksum in this generation. */
  contentChecksum: string;
}

export interface ActiveGenerationPointer {
  pointerVersion: number;
  /** `null` before the first activation. */
  activeGeneration: string | null;
  updatedAt: string;
}

/** A complete subject snapshot plus the identifiers needed to relate it. */
export interface SubjectRecordValue {
  subjectId: string;
  schemaVersion: string;
  snapshot: SubjectSnapshot;
  /** Injected ISO-8601 timestamp. */
  createdAt: string;
  updatedAt: string;
}

export interface ProgressionRecordValue {
  subjectId: string;
  /** Persisted envelope version the canonical form was normalized from. */
  sourceVersion: 0 | 1 | 2 | 3;
  rank: RankTier;
  xpTotal: number;
  bySubject: Record<string, unknown>;
  crossSubjectAchievements: string[];
}

export interface SessionRecordValue {
  sessionId: string;
  subjectId: string;
  /**
   * The subject name as it was when the session was written, preserved so a
   * session for a subject that no longer has a `subjects` record - one the
   * migration could not carry, or one the learner deleted - still hydrates the
   * name the legacy session record holds. A live subject's current name always
   * wins, so this is a fallback and never a second source of truth.
   */
  subjectName?: string;
  startedAt: string;
  endedAt: string | null;
  roomsVisited: string[];
  notesSubmitted: number;
  reviewsCompleted: number;
  xpEarned: number;
  /**
   * Opaque event key that makes a replayed study event a no-op. Session
   * accounting is idempotent through this key (plan section 5.2).
   */
  eventId: string;
}

export interface PreferenceRecordValue {
  preferenceId: string;
  value: unknown;
  updatedAt: string;
}

export interface ShortcutRecordValue {
  actionId: string;
  labelKey: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export type AssistanceMode = 'off' | 'gentle' | 'standard';

export interface AssistanceRecordValue {
  assistanceId: string;
  mode: AssistanceMode;
  /** Aggregate, locally derived signals. Never raw keystrokes or traits. */
  signals: Record<string, number>;
  dismissalCount: number;
  updatedAt: string;
}

/** How an attachment's bytes are (or are not) available. */
export type AttachmentAvailability = 'stored' | 'external-only';

export interface AttachmentMetadataRecordValue {
  attachmentId: string;
  subjectId: string;
  roomId: string;
  sourceType: 'local' | 'external';
  mimeType: string;
  availability: AttachmentAvailability;
  /** SHA-256 of the bytes, or `null` when no bytes are recoverable. */
  contentHash: string | null;
  /**
   * Present only so the application can still render the attachment it already
   * has. Reports, receipts, and logs must never copy it (see
   * `ExternalOnlyAttachmentReport`).
   */
  fileName?: string;
  externalUrl?: string;
  altText?: string;
  addedAt: string;
}

export interface AttachmentBlobRecordValue {
  attachmentId: string;
  /** SHA-256 of {@link bytes}; the blob's identity. */
  contentHash: string;
  bytes: ArrayBuffer;
  byteLength: number;
  storedAt: string;
}

export interface CustomSpriteRecordValue {
  /** Sprite path within the asset tree; the record's identity. */
  spritePath: string;
  kind: 'override' | 'anim' | 'original';
  /** Raw SVG or JSON animation configuration, preserved verbatim. */
  content: string;
  updatedAt: string;
}

export interface RecoveryRecordValue {
  /**
   * `backup` or `corrupt` matches the legacy key families. `unindexed-subject`
   * is a payload the subject index does not name: it is preserved here so the
   * generation never loses bytes the device still holds, and it is not a
   * `subjects` record because this build's own reader would not show it.
   */
  kind: 'backup' | 'corrupt' | 'unindexed-subject';
  subjectId: string;
  /** Raw legacy string, preserved byte-for-byte. Never parsed. */
  raw: string;
  capturedAt: string;
}

// ── Migration receipt ─────────────────────────────────────────────────────

/** Identifier for the legacy-localStorage to storage-v2 migration. */
export const LEGACY_MIGRATION_ID = 'legacy-localstorage-to-storage-v2';

export type MigrationReceiptStatus = 'staged' | 'activated' | 'rolled-back';

/**
 * A migration receipt.
 *
 * Counts, checksums, and version identifiers only. It deliberately carries no
 * subject id, subject name, room topic, note, filename, or attachment URL, so a
 * receipt is safe to log or attach to a bug report.
 */
export interface MigrationReceiptValue {
  receiptId: string;
  migrationId: string;
  fromStorage: 'legacy-localstorage';
  toStorage: 'storage-v2';
  stagedGenerationId: string;
  previousActiveGenerationId: string | null;
  status: MigrationReceiptStatus;
  /** Injected ISO-8601 timestamp. */
  createdAt: string;
  storageGenerationFormatVersion: number;
  subjectSchemaVersion: string;
  /** Histogram: subject schema version -> number of subjects. */
  subjectSchemaVersions: Record<string, number>;
  /** Histogram: persisted progression version -> number of envelopes. */
  progressionSourceVersions: Record<string, number>;
  recordCounts: Record<StorageV2StoreName, number>;
  /** Per-store roll-up checksum of every record checksum. */
  recordChecksums: Record<StorageV2StoreName, string>;
  contentChecksum: string;
}

// ── Reports ───────────────────────────────────────────────────────────────

/**
 * An attachment whose bytes could not be recovered and will not be fetched.
 *
 * Plan section 2.3 requires external-only attachments to be disclosed honestly.
 * The disclosure carries opaque ids and a content hash only: never a filename,
 * never a URL, never a subject name.
 */
export interface ExternalOnlyAttachmentReport {
  attachmentId: string;
  subjectId: string;
  roomId: string;
  contentHash: string | null;
  byteLength: number | null;
  reason:
    | 'historical-external-url'
    | 'bytes-not-recoverable'
    | 'bytes-missing-locally';
  sourceType: 'local' | 'external';
}

/**
 * The outcome of a migration run.
 *
 * - `migrated` - the generation this run describes is either the one
 *   `activeGeneration` names, or one a later generation has since superseded. It
 *   never describes a generation that is still only `staged`: a staged
 *   generation's records exist but nothing points at them, so reporting success
 *   for one would tell a caller the device is migrated while its data is
 *   unreachable. A run that finds its own generation left `staged` discards it
 *   and migrates again.
 * - `recovery-required` - a failure. The legacy generation is still authoritative
 *   and `activeGeneration` was not flipped.
 * - `no-source-data` - the device had nothing to migrate, so nothing was staged.
 *
 * The activation-blocking rule that produces these values is declared once, as
 * `MIGRATION_BLOCKING_POLICY` in `./migrationState`.
 */
export type MigrationOutcomeStatus = 'migrated' | 'recovery-required' | 'no-source-data';


export interface MigrationCounts {
  subjects: number;
  progression: number;
  sessions: number;
  preferences: number;
  shortcuts: number;
  assistance: number;
  attachments: number;
  attachmentBlobs: number;
  customSprites: number;
  recovery: number;
}

/** The migration report model. Counts, codes, and versions only. */
export interface MigrationReport {
  migrationId: string;
  status: MigrationOutcomeStatus;
  /** `null` unless a generation was staged. */
  stagedGenerationId: string | null;
  activated: boolean;
  previousActiveGenerationId: string | null;
  /** Injected ISO-8601 timestamp. */
  createdAt: string;
  legacyKeys: {
    allowlistedKeys: number;
    present: number;
    absent: number;
    parseErrors: number;
    unsupportedShapes: number;
  };
  subjectSchemaVersions: Record<string, number>;
  progressionSourceVersions: Record<string, number>;
  recordCounts: MigrationCounts;
  attachments: {
    total: number;
    storedBytes: number;
    externalOnly: number;
  };
  externalOnlyAttachments: ExternalOnlyAttachmentReport[];
  /**
   * Sanitized validation problems, code and count only.
   *
   * `severity` is the activation rule, not a mood: `error` means activation was
   * refused, `warning` means the condition was disclosed and the run continued.
   * A record the migration could not read out of the source device is a
   * `warning`, because it is never in the staged generation - there is nothing
   * for generation validation to refuse - and the count is surfaced on the
   * migration state screen instead.
   */
  problems: ValidationProblem[];
  contentChecksum: string | null;
  receiptId: string | null;
  /** Present when `status` is `recovery-required`. */
  recovery: {
    code: StorageV2ErrorCode;
    stage: string;
  } | null;
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Machine-readable failure codes.
 *
 * No message in this application embeds a subject name, a topic, a note, a
 * filename, or a URL, so a `StorageV2Error` is always safe to log.
 */
export type StorageV2ErrorCode =
  | 'INDEXEDDB_UNAVAILABLE'
  | 'DATABASE_OPEN_FAILED'
  | 'DATABASE_VERSION_TOO_LOW'
  | 'TRANSACTION_ABORTED'
  | 'TRANSACTION_FAILED'
  | 'GENERATION_NOT_FOUND'
  | 'GENERATION_ALREADY_ACTIVE'
  | 'GENERATION_NOT_STAGGED'
  | 'NO_ACTIVE_GENERATION'
  | 'RECORD_NOT_FOUND'
  | 'RECORD_INVALID'
  | 'VALIDATION_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'COUNT_MISMATCH'
  | 'RELATIONSHIP_INVALID'
  | 'ARCHIVE_UNSAFE_PATH'
  | 'ARCHIVE_MEMBER_LIMIT'
  | 'ARCHIVE_MEMBER_TOO_LARGE'
  | 'ARCHIVE_TOTAL_TOO_LARGE'
  | 'ARCHIVE_RATIO_EXCEEDED'
  | 'ARCHIVE_MALFORMED'
  | 'ARCHIVE_MEMBER_MISSING'
  | 'LEGACY_UNREADABLE'
  | 'MIGRATION_ABORTED'
  | 'MIGRATION_FAILED';

/**
 * The only error type the storage-v2 modules throw.
 *
 * `message` is a fixed, sanitized string per code; `details` carries codes,
 * counts, booleans, and opaque identifiers. Neither ever carries record
 * contents, and the constructor *enforces* that rather than trusting the call
 * site: a string detail that is not code-shaped is refused at construction, so a
 * subject name, a room topic, a note, a filename, or a URL cannot reach
 * {@link StorageV2Error.toReport} even by accident. See
 * {@link isSanitizedDetailText}.
 */
export class StorageV2Error extends Error {
  readonly code: StorageV2ErrorCode;
  readonly details: Readonly<StorageV2ErrorDetails>;

  constructor(
    code: StorageV2ErrorCode,
    details: StorageV2ErrorDetails = {},
    message?: string,
  ) {
    super(message ?? `storage-v2 error: ${code}`);
    assertSanitizedDetails(details);
    this.name = 'StorageV2Error';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  /** Sanitized, log-safe projection. */
  toReport(): { code: StorageV2ErrorCode; details: Readonly<StorageV2ErrorDetails> } {
    return { code: this.code, details: { ...this.details } };
  }
}

/** The values a {@link StorageV2Error} detail may hold. */
export type StorageV2ErrorDetailValue = string | number | boolean;

/** A detail bag: codes, counts, booleans, and opaque identifiers only. */
export type StorageV2ErrorDetails = Readonly<Record<string, StorageV2ErrorDetailValue>>;

/**
 * The shape a string detail must have to be considered sanitized.
 *
 * Two rules, and both are needed:
 *
 * 1. **Only `[A-Za-z0-9._-]`.** Every character a learner-authored string is
 *    *likely* to contain - space, slash, colon, comma, quote, newline, non-ASCII -
 *    is excluded, while every code, stage name, store name, generation id, and
 *    subject id this application mints is accepted. A path or a URL is refused
 *    outright by the `/` and `:` alone.
 * 2. **No filename ending.** The character class alone cannot tell
 *    `gen-synthetic-0001` from `photo-of-my-cat.png`, because a slug is
 *    identifier-shaped. No code, stage, or identifier this application mints ends
 *    in `.` plus a short extension, so a trailing `.xxxx` marks the value as a
 *    filename and it is refused.
 *
 * A residual is recorded rather than hidden: a subject id that happened to end in
 * `.v1` would be refused too. That is the conservative direction - the gate
 * refuses a value rather than passing a filename - and every current id shape is
 * code-shaped.
 */
const SANITIZED_DETAIL_TEXT = /^[A-Za-z0-9._-]{1,64}$/;
const FILENAME_ENDING = /\.[A-Za-z0-9]{1,5}$/;

/** Whether a string detail is code-shaped and therefore safe to report. */
export function isSanitizedDetailText(value: string): boolean {
  return SANITIZED_DETAIL_TEXT.test(value) && !FILENAME_ENDING.test(value);
}

function assertSanitizedDetails(details: StorageV2ErrorDetails): void {
  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== 'string') continue;
    if (isSanitizedDetailText(value)) continue;
    // The offending value is deliberately NOT interpolated: a throw that echoed
    // it would be the leak this check exists to prevent.
    throw new TypeError(
      `storage-v2 error detail "${key}" is not a code, count, or opaque identifier and was refused.`,
    );
  }
}

export function isStorageV2Error(value: unknown): value is StorageV2Error {
  return value instanceof StorageV2Error;
}

/** Wrap an unknown thrown value as a {@link StorageV2Error}. */
export function toStorageV2Error(
  value: unknown,
  fallbackCode: StorageV2ErrorCode,
  details: StorageV2ErrorDetails = {},
): StorageV2Error {
  if (isStorageV2Error(value)) return value;
  return new StorageV2Error(fallbackCode, details);
}
