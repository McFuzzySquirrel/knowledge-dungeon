/**
 * Validation for every canonical storage-v2 record type, plus the relationship
 * checks that decide whether a staged generation may be activated.
 *
 * Two rules hold everywhere in this module:
 *
 * 1. A problem is a code plus a count. It never carries the offending value, a
 *    room topic, a note, a filename, a URL, or a subject name, so a validation
 *    report is safe to log and to attach to a recovery screen.
 * 2. Validation never repairs. It reports; the migration decides what to do.
 *
 * The module is renderer-neutral and performs no storage access.
 */

import { validateSubjectSnapshot, type SubjectValidationCode } from '@/core/validation/persistence';
import { normalizeProgressionRecord } from '@/core/progression/canonicalProgression';
import type {
  ActiveGenerationPointer,
  AssistanceRecordValue,
  AttachmentBlobRecordValue,
  AttachmentMetadataRecordValue,
  CustomSpriteRecordValue,
  GenerationDescriptor,
  MigrationReceiptValue,
  PreferenceRecordValue,
  ProgressionRecordValue,
  RecoveryRecordValue,
  SessionRecordValue,
  ShortcutRecordValue,
  StorageRecordEnvelope,
  StorageV2StoreName,
  SubjectRecordValue,
} from './schema';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
} from './schema';
import { checksumValue } from './checksum';

/** Which record type a problem was found in. Never a record identity. */
export type ValidationScope =
  | 'generation'
  | 'pointer'
  | 'subject'
  | 'progression'
  | 'session'
  | 'preference'
  | 'shortcut'
  | 'assistance'
  | 'attachment'
  | 'attachment-blob'
  | 'custom-sprite'
  | 'recovery'
  | 'migration-receipt'
  | 'relationship'
  | 'checksum';

export type ValidationCode =
  | 'not-an-object'
  | 'unexpected-json-shape'
  | 'missing-field'
  | 'wrong-type'
  | 'empty-identifier'
  | 'duplicate-identifier'
  | 'checksum-mismatch'
  | 'unsupported-version'
  | 'unknown-subject-reference'
  | 'unknown-room-reference'
  | 'dangling-edge'
  | 'attachment-without-metadata'
  | 'blob-without-bytes'
  | 'content-hash-mismatch'
  | 'stored-without-bytes'
  | 'receipt-generation-mismatch'
  | 'count-mismatch'
  | 'relationship-invalid';

/**
 * How serious a finding is.
 *
 * - `error` blocks activation. The generation is internally inconsistent, or a
 *   record cannot be read back as what it claims to be.
 * - `warning` is reported and does not block. It marks a reference to something
 *   that is legitimately absent, such as progression for a subject the learner
 *   deleted. Dropping such a record would be destructive, so the generation
 *   activates with the reference intact and the condition is disclosed.
 */
export type ValidationSeverity = 'error' | 'warning';

export interface ValidationProblem {
  code: ValidationCode | SubjectValidationCode;
  scope: ValidationScope;
  count: number;
  severity: ValidationSeverity;
}

export interface ValidationResult {
  /** True when no problem has `error` severity. */
  ok: boolean;
  problems: ValidationProblem[];
}

/** Count only the problems that block activation. */
export function countBlockingProblems(problems: readonly ValidationProblem[]): number {
  return problems
    .filter((problem) => problem.severity === 'error')
    .reduce((total, problem) => total + problem.count, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ProblemCollector {
  private readonly accumulator = new Map<string, ValidationProblem>();

  add(
    code: ValidationCode | SubjectValidationCode,
    scope: ValidationScope,
    severity: ValidationSeverity = 'error',
  ): void {
    const key = `${scope}|${code}`;
    const existing = this.accumulator.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.accumulator.set(key, { code, scope, count: 1, severity });
  }

  merge(problems: readonly ValidationProblem[]): void {
    for (const problem of problems) {
      const key = `${problem.scope}|${problem.code}`;
      const existing = this.accumulator.get(key);
      if (existing) {
        existing.count += problem.count;
        continue;
      }
      this.accumulator.set(key, { ...problem });
    }
  }

  build(): ValidationResult {
    const problems = [...this.accumulator.values()].sort((a, b) => {
      if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
      return a.code < b.code ? -1 : 1;
    });
    // A generation activates when it has no blocking problem. Warnings are
    // disclosed, not fatal.
    return { ok: problems.every((problem) => problem.severity !== 'error'), problems };
  }
}

function requireString(
  collector: ProblemCollector,
  record: Record<string, unknown>,
  key: string,
  scope: ValidationScope,
  options: { allowEmpty?: boolean } = {},
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    collector.add('missing-field', scope);
    return null;
  }
  if (typeof value !== 'string') {
    collector.add('wrong-type', scope);
    return null;
  }
  if (!options.allowEmpty && value.length === 0) {
    collector.add('empty-identifier', scope);
    return null;
  }
  return value;
}

/**
 * Byte length of a stored buffer, or `null` when the value is not a buffer.
 *
 * Uses a structural check rather than `instanceof ArrayBuffer`, because a buffer
 * that has crossed a structured-clone boundary (which is what IndexedDB does)
 * need not share this realm's `ArrayBuffer` constructor.
 */
function bufferByteLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { byteLength?: unknown }).byteLength === 'number' &&
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return (value as { byteLength: number }).byteLength;
  }
  return null;
}

function requireNumber(collector: ProblemCollector, record: Record<string, unknown>, key: string, scope: ValidationScope): number | null {
  const value = record[key];
  if (value === undefined || value === null) {
    collector.add('missing-field', scope);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    collector.add('wrong-type', scope);
    return null;
  }
  return value;
}

// ── Envelope ──────────────────────────────────────────────────────────────

/**
 * Validate one stored envelope: shape, generation tagging, and checksum.
 *
 * The stored checksum is compared against a freshly computed one, so a record
 * that was written by a different version or hand-edited in place is caught
 * before the generation is activated.
 */
export function validateRecordEnvelope(
  envelope: unknown,
  expectedGenerationId: string,
  scope: ValidationScope,
  options: { verifyChecksum?: boolean } = {},
): ValidationResult {
  const collector = new ProblemCollector();
  if (!isRecord(envelope)) {
    collector.add('not-an-object', scope);
    return collector.build();
  }
  if (typeof envelope.generationId !== 'string' || envelope.generationId.length === 0) {
    collector.add('missing-field', scope);
  } else if (envelope.generationId !== expectedGenerationId) {
    collector.add('unsupported-version', scope);
  }
  if (typeof envelope.recordId !== 'string' || envelope.recordId.length === 0) {
    collector.add('empty-identifier', scope);
  }
  if (typeof envelope.updatedAt !== 'string' || envelope.updatedAt.length === 0) {
    collector.add('missing-field', scope);
  }
  if (!('value' in envelope)) {
    collector.add('missing-field', scope);
  } else if (options.verifyChecksum !== false) {
    const stored = envelope.checksum;
    if (stored !== null && stored !== undefined && stored !== checksumValue(envelope.value)) {
      collector.add('checksum-mismatch', 'checksum');
    }
  }
  return collector.build();
}

// ── Per-record validators ─────────────────────────────────────────────────

export function validateSubjectRecord(value: SubjectRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'subject');
    return collector.build();
  }
  requireString(collector, record, 'subjectId', 'subject');
  requireString(collector, record, 'schemaVersion', 'subject');
  if (record.schemaVersion !== CANONICAL_SUBJECT_SCHEMA_VERSION) {
    collector.add('unsupported-version', 'subject');
  }
  const snapshot = record.snapshot;
  if (!isRecord(snapshot)) {
    collector.add('wrong-type', 'subject');
    return collector.build();
  }
  // Deeper subject-payload findings are disclosed, not fatal. The importer accepts
  // shallow payloads today, and the migration must not refuse to carry a subject
  // the learner can currently open just because a field is missing.
  for (const problem of validateSubjectSnapshot(snapshot).problems) {
    collector.add(problem.code, 'subject', 'warning');
  }
  return collector.build();
}

export function validateProgressionRecord(value: ProgressionRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'progression');
    return collector.build();
  }
  requireString(collector, record, 'subjectId', 'progression');
  if (typeof record.rank !== 'string') {
    collector.add('wrong-type', 'progression');
  }
  requireNumber(collector, record, 'xpTotal', 'progression');
  if (!isRecord(record.bySubject)) {
    collector.add('wrong-type', 'progression');
  } else {
    // Normalizing must be total: a payload the canonical normalizer rejects is
    // a payload that cannot be written.
    normalizeProgressionRecord(record, { activeSubjectId: null });
  }
  if (!Array.isArray(record.crossSubjectAchievements)) {
    collector.add('wrong-type', 'progression');
  }
  return collector.build();
}

export function validateSessionRecord(value: SessionRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'session');
    return collector.build();
  }
  requireString(collector, record, 'sessionId', 'session');
  requireString(collector, record, 'subjectId', 'session');
  requireString(collector, record, 'eventId', 'session');
  requireString(collector, record, 'startedAt', 'session');
  if (record.endedAt !== null && typeof record.endedAt !== 'string') {
    collector.add('wrong-type', 'session');
  }
  if (!Array.isArray(record.roomsVisited)) {
    collector.add('wrong-type', 'session');
  }
  for (const key of ['notesSubmitted', 'reviewsCompleted', 'xpEarned'] as const) {
    if (typeof record[key] !== 'number') {
      collector.add('wrong-type', 'session');
    }
  }
  return collector.build();
}

export function validatePreferenceRecord(value: PreferenceRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'preference');
    return collector.build();
  }
  requireString(collector, record, 'preferenceId', 'preference');
  if (!('value' in record)) {
    collector.add('missing-field', 'preference');
  }
  return collector.build();
}

export function validateShortcutRecord(value: ShortcutRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'shortcut');
    return collector.build();
  }
  requireString(collector, record, 'actionId', 'shortcut');
  requireString(collector, record, 'labelKey', 'shortcut', { allowEmpty: true });
  requireString(collector, record, 'key', 'shortcut');
  for (const key of ['ctrlKey', 'shiftKey'] as const) {
    if (typeof record[key] !== 'boolean') {
      collector.add('wrong-type', 'shortcut');
    }
  }
  return collector.build();
}

export function validateAssistanceRecord(value: AssistanceRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'assistance');
    return collector.build();
  }
  requireString(collector, record, 'assistanceId', 'assistance');
  if (record.mode !== 'off' && record.mode !== 'gentle' && record.mode !== 'standard') {
    collector.add('unsupported-version', 'assistance');
  }
  if (!isRecord(record.signals)) {
    collector.add('wrong-type', 'assistance');
  } else {
    for (const entry of Object.values(record.signals)) {
      if (typeof entry !== 'number') {
        collector.add('wrong-type', 'assistance');
        break;
      }
    }
  }
  if (typeof record.dismissalCount !== 'number') {
    collector.add('wrong-type', 'assistance');
  }
  return collector.build();
}

export function validateAttachmentMetadataRecord(value: AttachmentMetadataRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'attachment');
    return collector.build();
  }
  requireString(collector, record, 'attachmentId', 'attachment');
  requireString(collector, record, 'subjectId', 'attachment');
  requireString(collector, record, 'roomId', 'attachment');
  if (record.sourceType !== 'local' && record.sourceType !== 'external') {
    collector.add('unsupported-version', 'attachment');
  }
  if (record.availability !== 'stored' && record.availability !== 'external-only') {
    collector.add('unsupported-version', 'attachment');
  }
  if (record.availability === 'external-only' && record.contentHash !== null) {
    // An external-only attachment has no bytes, so it cannot claim a content
    // hash. A mismatch here would misreport what a backup contains.
    collector.add('content-hash-mismatch', 'attachment');
  }
  if (record.contentHash !== null && typeof record.contentHash !== 'string') {
    collector.add('wrong-type', 'attachment');
  }
  return collector.build();
}

export function validateAttachmentBlobRecord(value: AttachmentBlobRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'attachment-blob');
    return collector.build();
  }
  requireString(collector, record, 'attachmentId', 'attachment-blob');
  requireString(collector, record, 'contentHash', 'attachment-blob');
  const bytes = record.bytes;
  const byteLength = bufferByteLength(bytes);
  if (byteLength === null) {
    collector.add('blob-without-bytes', 'attachment-blob');
    return collector.build();
  }
  if (byteLength === 0) {
    collector.add('blob-without-bytes', 'attachment-blob');
  }
  if (typeof record.byteLength === 'number' && record.byteLength !== byteLength) {
    collector.add('wrong-type', 'attachment-blob');
  }
  return collector.build();
}

export function validateCustomSpriteRecord(value: CustomSpriteRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'custom-sprite');
    return collector.build();
  }
  requireString(collector, record, 'spritePath', 'custom-sprite');
  if (record.kind !== 'override' && record.kind !== 'anim' && record.kind !== 'original') {
    collector.add('unsupported-version', 'custom-sprite');
  }
  // Raw content is preserved verbatim and is never parsed or validated here:
  // an unrecognized shape must survive a round trip unchanged.
  if (typeof record.content !== 'string') {
    collector.add('wrong-type', 'custom-sprite');
  }
  return collector.build();
}

export function validateRecoveryRecord(value: RecoveryRecordValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'recovery');
    return collector.build();
  }
  if (record.kind !== 'backup' && record.kind !== 'corrupt') {
    collector.add('unsupported-version', 'recovery');
  }
  requireString(collector, record, 'subjectId', 'recovery');
  // Recovery payloads are preserved byte-for-byte and are never parsed.
  if (typeof record.raw !== 'string') {
    collector.add('wrong-type', 'recovery');
  }
  return collector.build();
}

export function validateMigrationReceipt(value: MigrationReceiptValue): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'migration-receipt');
    return collector.build();
  }
  requireString(collector, record, 'receiptId', 'migration-receipt');
  requireString(collector, record, 'migrationId', 'migration-receipt');
  requireString(collector, record, 'stagedGenerationId', 'migration-receipt');
  if (!isRecord(record.recordCounts)) {
    collector.add('missing-field', 'migration-receipt');
  }
  if (!isRecord(record.recordChecksums)) {
    collector.add('missing-field', 'migration-receipt');
  }
  if (typeof record.contentChecksum !== 'string') {
    collector.add('wrong-type', 'migration-receipt');
  }
  return collector.build();
}

export function validateGenerationDescriptor(value: GenerationDescriptor): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'generation');
    return collector.build();
  }
  requireString(collector, record, 'generationId', 'generation');
  if (record.generationFormatVersion !== STORAGE_V2_GENERATION_FORMAT_VERSION) {
    collector.add('unsupported-version', 'generation');
  }
  if (record.subjectSchemaVersion !== CANONICAL_SUBJECT_SCHEMA_VERSION) {
    collector.add('unsupported-version', 'generation');
  }
  if (record.status !== 'staged' && record.status !== 'active' && record.status !== 'superseded') {
    collector.add('unsupported-version', 'generation');
  }
  if (!isRecord(record.recordCounts)) {
    collector.add('missing-field', 'generation');
  }
  if (typeof record.contentChecksum !== 'string') {
    collector.add('wrong-type', 'generation');
  }
  return collector.build();
}

export function validateActiveGenerationPointer(value: ActiveGenerationPointer): ValidationResult {
  const collector = new ProblemCollector();
  const record = value as unknown as Record<string, unknown>;
  if (!isRecord(record)) {
    collector.add('not-an-object', 'pointer');
    return collector.build();
  }
  if (typeof record.pointerVersion !== 'number') {
    collector.add('wrong-type', 'pointer');
  }
  if (record.activeGeneration !== null && typeof record.activeGeneration !== 'string') {
    collector.add('wrong-type', 'pointer');
  }
  if (typeof record.updatedAt !== 'string') {
    collector.add('missing-field', 'pointer');
  }
  return collector.build();
}

// ── Generation-level validation ───────────────────────────────────────────

/**
 * A generation's records, grouped by store.
 *
 * `attachments` holds both metadata and blob records; they are separated by
 * their record id prefix so a caller cannot confuse the two.
 */
export interface GenerationRecords {
  subjects: StorageRecordEnvelope<SubjectRecordValue>[];
  progression: StorageRecordEnvelope<ProgressionRecordValue>[];
  sessions: StorageRecordEnvelope<SessionRecordValue>[];
  preferences: StorageRecordEnvelope<PreferenceRecordValue>[];
  shortcuts: StorageRecordEnvelope<ShortcutRecordValue>[];
  assistance: StorageRecordEnvelope<AssistanceRecordValue>[];
  attachmentMetadata: StorageRecordEnvelope<AttachmentMetadataRecordValue>[];
  attachmentBlobs: StorageRecordEnvelope<AttachmentBlobRecordValue>[];
  customSprites: StorageRecordEnvelope<CustomSpriteRecordValue>[];
  recovery: StorageRecordEnvelope<RecoveryRecordValue>[];
  migrationReceipts: StorageRecordEnvelope<MigrationReceiptValue>[];
}

/** Record-id prefix for attachment metadata inside the `attachments` store. */
export const ATTACHMENT_METADATA_ID_PREFIX = 'meta:';
/** Record-id prefix for attachment bytes inside the `attachments` store. */
export const ATTACHMENT_BLOB_ID_PREFIX = 'blob:';

export function attachmentMetadataRecordId(attachmentId: string): string {
  return `${ATTACHMENT_METADATA_ID_PREFIX}${attachmentId}`;
}

export function attachmentBlobRecordId(attachmentId: string): string {
  return `${ATTACHMENT_BLOB_ID_PREFIX}${attachmentId}`;
}

export function emptyGenerationRecords(): GenerationRecords {
  return {
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
  };
}

/**
 * A generation's records **as values**, before the repository wraps them in a
 * storage envelope.
 *
 * This is what a caller (the migration, an importer) supplies. The repository
 * derives the envelope key, checksum, and timestamp, so a caller cannot
 * accidentally write a record that is missing its generation tag.
 */
export interface GenerationRecordValues {
  subjects: SubjectRecordValue[];
  progression: ProgressionRecordValue[];
  sessions: SessionRecordValue[];
  preferences: PreferenceRecordValue[];
  shortcuts: ShortcutRecordValue[];
  assistance: AssistanceRecordValue[];
  attachmentMetadata: AttachmentMetadataRecordValue[];
  attachmentBlobs: AttachmentBlobRecordValue[];
  customSprites: CustomSpriteRecordValue[];
  recovery: RecoveryRecordValue[];
  migrationReceipts: MigrationReceiptValue[];
}

/** An empty value set: a fresh generation with no data yet. */
export function emptyGenerationRecordValues(): GenerationRecordValues {
  return {
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
  };
}

/** Per-store record counts, including the two global stores. */
export function countGenerationRecords(records: GenerationRecords): Record<StorageV2StoreName, number> {
  return {
    meta: 0,
    subjects: records.subjects.length,
    progression: records.progression.length,
    sessions: records.sessions.length,
    preferences: records.preferences.length,
    shortcuts: records.shortcuts.length,
    assistance: records.assistance.length,
    attachments: records.attachmentMetadata.length + records.attachmentBlobs.length,
    customSprites: records.customSprites.length,
    recovery: records.recovery.length,
    migrationReceipts: records.migrationReceipts.length,
  };
}

function checkUniqueRecordIds(
  collector: ProblemCollector,
  scope: ValidationScope,
  envelopes: readonly { recordId: string }[],
): void {
  const seen = new Set<string>();
  for (const envelope of envelopes) {
    if (seen.has(envelope.recordId)) {
      collector.add('duplicate-identifier', scope);
      continue;
    }
    seen.add(envelope.recordId);
  }
}

/**
 * Validate a staged generation: every record type, then every relationship
 * between stores.
 *
 * Relationship checks (the ones that decide whether activation is safe):
 * - a progression record's subject must exist in `subjects`;
 * - a session record's subject must exist in `subjects`;
 * - an attachment's subject and room must exist in `subjects` and in that
 *   subject's rooms;
 * - an attachment marked `stored` must have a blob record with a matching
 *   content hash;
 * - a migration receipt must name the generation it belongs to;
 * - the declared record counts must match the actual counts.
 */
export function validateGenerationRecords(
  generationId: string,
  descriptor: GenerationDescriptor,
  records: GenerationRecords,
  options: { verifyChecksums?: boolean } = {},
): ValidationResult {
  const collector = new ProblemCollector();
  const verifyChecksums = options.verifyChecksums ?? true;

  const descriptorResult = validateGenerationDescriptor(descriptor);
  collector.merge(descriptorResult.problems);
  if (descriptor.generationId !== generationId) {
    collector.add('unsupported-version', 'generation');
  }

  const verify = <T>(envelopes: readonly StorageRecordEnvelope<T>[], scope: ValidationScope): void => {
    for (const envelope of envelopes) {
      collector.merge(
        validateRecordEnvelope(envelope, generationId, scope, { verifyChecksum: verifyChecksums }).problems,
      );
    }
  };

  checkUniqueRecordIds(collector, 'subject', records.subjects);
  checkUniqueRecordIds(collector, 'progression', records.progression);
  checkUniqueRecordIds(collector, 'session', records.sessions);
  checkUniqueRecordIds(collector, 'attachment', records.attachmentMetadata);
  checkUniqueRecordIds(collector, 'attachment-blob', records.attachmentBlobs);
  checkUniqueRecordIds(collector, 'custom-sprite', records.customSprites);
  checkUniqueRecordIds(collector, 'recovery', records.recovery);
  checkUniqueRecordIds(collector, 'migration-receipt', records.migrationReceipts);

  verify(records.subjects, 'subject');
  verify(records.progression, 'progression');
  verify(records.sessions, 'session');
  verify(records.preferences, 'preference');
  verify(records.shortcuts, 'shortcut');
  verify(records.assistance, 'assistance');
  verify(records.attachmentMetadata, 'attachment');
  verify(records.attachmentBlobs, 'attachment-blob');
  verify(records.customSprites, 'custom-sprite');
  verify(records.recovery, 'recovery');
  verify(records.migrationReceipts, 'migration-receipt');

  for (const envelope of records.subjects) {
    collector.merge(validateSubjectRecord(envelope.value).problems);
  }
  for (const envelope of records.progression) {
    collector.merge(validateProgressionRecord(envelope.value).problems);
  }
  for (const envelope of records.sessions) {
    collector.merge(validateSessionRecord(envelope.value).problems);
  }
  for (const envelope of records.preferences) {
    collector.merge(validatePreferenceRecord(envelope.value).problems);
  }
  for (const envelope of records.shortcuts) {
    collector.merge(validateShortcutRecord(envelope.value).problems);
  }
  for (const envelope of records.assistance) {
    collector.merge(validateAssistanceRecord(envelope.value).problems);
  }
  for (const envelope of records.attachmentMetadata) {
    collector.merge(validateAttachmentMetadataRecord(envelope.value).problems);
  }
  for (const envelope of records.attachmentBlobs) {
    collector.merge(validateAttachmentBlobRecord(envelope.value).problems);
  }
  for (const envelope of records.customSprites) {
    collector.merge(validateCustomSpriteRecord(envelope.value).problems);
  }
  for (const envelope of records.recovery) {
    collector.merge(validateRecoveryRecord(envelope.value).problems);
  }
  for (const envelope of records.migrationReceipts) {
    collector.merge(validateMigrationReceipt(envelope.value).problems);
  }

  // ── Relationships ──
  const subjectIds = new Set(records.subjects.map((envelope) => envelope.value.subjectId));
  const roomsBySubject = new Map<string, Set<string>>();
  for (const envelope of records.subjects) {
    const snapshot = envelope.value.snapshot;
    const rooms = isRecord(snapshot) && isRecord(snapshot.rooms) ? Object.keys(snapshot.rooms) : [];
    roomsBySubject.set(envelope.value.subjectId, new Set(rooms));
  }

  for (const envelope of records.progression) {
    if (!subjectIds.has(envelope.value.subjectId)) {
      // A subject can legitimately be gone while its progression remains.
      // Refusing to activate would strand the learner's XP and fish; dropping
      // the record would be destructive. Disclose it instead.
      collector.add('unknown-subject-reference', 'relationship', 'warning');
    }
  }
  for (const envelope of records.sessions) {
    if (!subjectIds.has(envelope.value.subjectId)) {
      collector.add('unknown-subject-reference', 'relationship', 'warning');
    }
  }
  for (const envelope of records.subjects) {
    const snapshot = envelope.value.snapshot;
    if (!isRecord(snapshot) || !isRecord(snapshot.dungeon)) continue;
    const edges = isRecord(snapshot.dungeon) && Array.isArray(snapshot.dungeon.edges) ? snapshot.dungeon.edges : [];
    const roomIds = roomsBySubject.get(envelope.value.subjectId) ?? new Set<string>();
    for (const edge of edges) {
      if (!isRecord(edge)) {
        collector.add('dangling-edge', 'relationship');
        continue;
      }
      if (
        (typeof edge.fromRoomId === 'string' && !roomIds.has(edge.fromRoomId)) ||
        (typeof edge.toRoomId === 'string' && !roomIds.has(edge.toRoomId))
      ) {
        collector.add('dangling-edge', 'relationship');
      }
    }
  }

  const blobByAttachment = new Map(records.attachmentBlobs.map((envelope) => [envelope.value.attachmentId, envelope.value]));
  for (const envelope of records.attachmentMetadata) {
    const metadata = envelope.value;
    if (!subjectIds.has(metadata.subjectId)) {
      collector.add('unknown-subject-reference', 'relationship');
    } else if (!(roomsBySubject.get(metadata.subjectId) ?? new Set()).has(metadata.roomId)) {
      collector.add('unknown-room-reference', 'relationship');
    }
    const blob = blobByAttachment.get(metadata.attachmentId);
    if (metadata.availability === 'stored') {
      if (!blob) {
        collector.add('attachment-without-metadata', 'relationship');
      } else if (metadata.contentHash !== null && blob.contentHash !== metadata.contentHash) {
        collector.add('content-hash-mismatch', 'relationship');
      }
    } else if (blob) {
      // External-only with recoverable bytes present: the report would be wrong.
      collector.add('stored-without-bytes', 'relationship');
    }
  }

  for (const envelope of records.migrationReceipts) {
    if (envelope.value.stagedGenerationId !== generationId) {
      collector.add('receipt-generation-mismatch', 'relationship');
    }
  }

  // ── Declared counts ──
  const actual = countGenerationRecords(records);
  for (const [storeName, count] of Object.entries(actual)) {
    if (descriptor.recordCounts[storeName as StorageV2StoreName] !== count) {
      collector.add('count-mismatch', 'generation');
    }
  }

  return collector.build();
}

