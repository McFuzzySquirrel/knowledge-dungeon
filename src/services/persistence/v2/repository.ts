/**
 * Transactional storage-v2 repository.
 *
 * Every multi-store write runs in **one** IndexedDB transaction spanning every
 * store it touches, so an abort leaves nothing behind. Nothing here is
 * referenced by the live application: `VITE_STORAGE_REPOSITORY` stays `legacy`
 * until Phase 4.
 *
 * Transaction discipline: a write never awaits between issuing its requests.
 * Reads that a write depends on happen in a preceding read-only pass, and every
 * `put`/`delete` in a write pass is issued synchronously, so the transaction is
 * still active when the last request is enqueued in a real browser as well as
 * under `fake-indexeddb`.
 *
 * Errors are typed and sanitized: every failure leaves through
 * {@link StorageV2Error}, whose `message` is fixed per code and whose `details`
 * carry only codes, counts, and identifiers.
 */

import {
  ACTIVE_GENERATION_POINTER_VERSION,
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  StorageV2Error,
  toStorageV2Error,
  type ActiveGenerationPointer,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type AssistanceRecordValue,
  type CustomSpriteRecordValue,
  type GenerationDescriptor,
  type MetaRecordEnvelope,
  type MigrationReceiptValue,
  type PreferenceRecordValue,
  type ProgressionRecordValue,
  type RecoveryRecordValue,
  type SessionRecordValue,
  type ShortcutRecordValue,
  type StorageRecordEnvelope,
  type StorageV2GenerationSource,
  type StorageV2StoreName,
  type SubjectRecordValue,
} from './schema';
import {
  allStoreNames,
  openStorageV2Database,
  requestToPromise,
  transactionToPromise,
  generationMetaKey,
  writeActiveGenerationPointerTo,
  writeGenerationDescriptorTo,
  fixedClock,
  createDeterministicIdFactory,
  type OpenStorageV2Options,
  type StorageV2Clock,
  type StorageV2IdFactory,
} from './database';
import { checksumOfChecksums, checksumValue } from './checksum';
import {
  attachmentBlobRecordId,
  attachmentMetadataRecordId,
  countGenerationRecords,
  emptyGenerationRecordValues,
  validateGenerationRecords,
  type GenerationRecords,
  type GenerationRecordValues,
  type ValidationProblem,
} from './validation';

const ACTIVE_GENERATION_META_KEY = 'activeGeneration';
const GENERATION_META_PREFIX = 'generation:';
const ATTACHMENT_BLOB_PREFIX = 'blob:';

// ── Public shapes ─────────────────────────────────────────────────────────

export interface StorageV2Repository {
  readonly databaseName: string;
  readonly clock: StorageV2Clock;
  readonly idFactory: StorageV2IdFactory;

  close(): void;

  listGenerations(): Promise<GenerationDescriptor[]>;
  readGeneration(generationId: string): Promise<GenerationSnapshot | null>;
  readActiveGenerationId(): Promise<string | null>;
  readActiveGeneration(): Promise<GenerationSnapshot | null>;
  stageGeneration(input: StageGenerationInput): Promise<StageGenerationResult>;
  validateGeneration(generationId: string): Promise<GenerationValidationReport>;
  activateGeneration(generationId: string): Promise<ActivationResult>;
  rollbackToGeneration(generationId: string): Promise<ActivationResult>;
  pruneGenerations(options?: PruneOptions): Promise<PruneResult>;
  /**
   * Delete a `staged` generation and everything in it.
   *
   * The recovery path for a run that failed after its stage commit. Refuses to
   * touch an `active` or `superseded` generation.
   */
  discardStagedGeneration(generationId: string): Promise<boolean>;
  readRecords(generationId: string): Promise<GenerationSnapshot>;
  putRecords(generationId: string, records: Partial<GenerationRecordValues>): Promise<PutRecordsResult>;
  deleteRecords(generationId: string, targets: DeleteRecordsTarget): Promise<DeleteRecordsResult>;
  writeMigrationReceipt(receipt: MigrationReceiptValue): Promise<void>;
  listMigrationReceipts(generationId?: string): Promise<MigrationReceiptValue[]>;
}

export interface GenerationSnapshot {
  generationId: string;
  descriptor: GenerationDescriptor | null;
  records: GenerationRecords;
  /** Roll-up checksum over every record checksum, sorted before hashing. */
  contentChecksum: string;
}

export interface StageGenerationInput {
  /** Opaque generation identifier. The caller injects it; nothing is random. */
  generationId: string;
  source: StorageV2GenerationSource;
  /** The generation this one descends from; retained for rollback. */
  parentGenerationId?: string | null;
  records: Partial<GenerationRecordValues>;
  /**
   * Test seam for failure injection. Called at a named point inside the staging
   * transaction; throwing aborts the transaction and nothing is committed.
   * Never wired to anything in production.
   */
  onStage?: (point: StageFailurePoint) => void;
}

/** Points inside the staging transaction where a failure can be injected. */
export type StageFailurePoint =
  | 'after-subjects'
  | 'after-progression'
  | 'after-sessions'
  | 'after-attachments'
  | 'before-meta'
  | 'before-commit';

export interface StageGenerationResult {
  generationId: string;
  descriptor: GenerationDescriptor;
  recordCounts: Record<StorageV2StoreName, number>;
  contentChecksum: string;
}

export interface GenerationValidationReport {
  generationId: string;
  ok: boolean;
  problems: ValidationProblem[];
  recordCounts: Record<StorageV2StoreName, number>;
  /** Declared count minus actual count, per store. */
  countDeltas: Record<StorageV2StoreName, number>;
  contentChecksum: string;
  /** Store names whose roll-up checksum disagrees with the descriptor. */
  checksumMismatches: StorageV2StoreName[];
}

export interface ActivationResult {
  /** The generation that was active before this call, or `null`. */
  previousActiveGenerationId: string | null;
  activeGenerationId: string;
}

export interface PruneOptions {
  /** Keep at least this many generations, counting the active one. */
  keepAtLeast?: number;
  /** Never prune these, whatever the policy says. */
  retain?: readonly string[];
}

export interface PruneResult {
  removed: string[];
  retained: string[];
}

export interface PutRecordsResult {
  generationId: string;
  recordCounts: Record<StorageV2StoreName, number>;
  contentChecksum: string;
}

export interface DeleteRecordsTarget {
  subjects?: readonly string[];
  progression?: readonly string[];
  sessions?: readonly string[];
  preferences?: readonly string[];
  shortcuts?: readonly string[];
  assistance?: readonly string[];
  attachments?: readonly string[];
  customSprites?: readonly string[];
  recovery?: readonly string[];
}

export interface DeleteRecordsResult {
  generationId: string;
  removed: number;
  recordCounts: Record<StorageV2StoreName, number>;
  contentChecksum: string;
}

export type OpenRepositoryOptions = OpenStorageV2Options;

// ── Record plumbing ───────────────────────────────────────────────────────

function emptyCounts(): Record<StorageV2StoreName, number> {
  return Object.fromEntries(allStoreNames().map((name) => [name, 0])) as Record<
    StorageV2StoreName,
    number
  >;
}

function envelope<TValue>(
  generationId: string,
  recordId: string,
  value: TValue,
  updatedAt: string,
): StorageRecordEnvelope<TValue> {
  return { generationId, recordId, value, checksum: checksumValue(value), updatedAt };
}

export function buildRecordEnvelopes(
  generationId: string,
  input: Partial<GenerationRecordValues>,
  updatedAt: string,
): GenerationRecords {
  const base = emptyGenerationRecordValues();
  return {
    subjects: (input.subjects ?? base.subjects).map((value) =>
      envelope(generationId, value.subjectId, value, updatedAt),
    ),
    progression: (input.progression ?? base.progression).map((value) =>
      envelope(generationId, value.subjectId, value, updatedAt),
    ),
    sessions: (input.sessions ?? base.sessions).map((value) =>
      envelope(generationId, value.sessionId, value, updatedAt),
    ),
    preferences: (input.preferences ?? base.preferences).map((value) =>
      envelope(generationId, value.preferenceId, value, updatedAt),
    ),
    shortcuts: (input.shortcuts ?? base.shortcuts).map((value) =>
      envelope(generationId, value.actionId, value, updatedAt),
    ),
    assistance: (input.assistance ?? base.assistance).map((value) =>
      envelope(generationId, value.assistanceId, value, updatedAt),
    ),
    attachmentMetadata: (input.attachmentMetadata ?? base.attachmentMetadata).map((value) =>
      envelope(generationId, attachmentMetadataRecordId(value.attachmentId), value, updatedAt),
    ),
    attachmentBlobs: (input.attachmentBlobs ?? base.attachmentBlobs).map((value) =>
      envelope(generationId, attachmentBlobRecordId(value.attachmentId), value, updatedAt),
    ),
    customSprites: (input.customSprites ?? base.customSprites).map((value) =>
      envelope(generationId, value.spritePath, value, updatedAt),
    ),
    recovery: (input.recovery ?? base.recovery).map((value) =>
      envelope(generationId, `${value.kind}:${value.subjectId}`, value, updatedAt),
    ),
    migrationReceipts: (input.migrationReceipts ?? base.migrationReceipts).map((value) =>
      envelope(generationId, value.receiptId, value, updatedAt),
    ),
  };
}

/** Store name and record list for each generation-scoped collection. */
const RECORD_LIST_STORES: readonly { key: keyof GenerationRecords; store: StorageV2StoreName }[] = [
  { key: 'subjects', store: 'subjects' },
  { key: 'progression', store: 'progression' },
  { key: 'sessions', store: 'sessions' },
  { key: 'preferences', store: 'preferences' },
  { key: 'shortcuts', store: 'shortcuts' },
  { key: 'assistance', store: 'assistance' },
  { key: 'attachmentMetadata', store: 'attachments' },
  { key: 'attachmentBlobs', store: 'attachments' },
  { key: 'customSprites', store: 'customSprites' },
  { key: 'recovery', store: 'recovery' },
  { key: 'migrationReceipts', store: 'migrationReceipts' },
];

/** Per-store roll-up checksums plus the whole-generation roll-up under `meta`. */
export function computeStoreChecksums(
  records: GenerationRecords,
): Record<StorageV2StoreName, string> {
  const checksums = emptyCounts() as unknown as Record<StorageV2StoreName, string>;
  const all: string[] = [];
  const assign = (name: StorageV2StoreName, values: readonly { checksum: string | null }[]): void => {
    const memberChecksums = values.map((value) => value.checksum ?? '');
    all.push(...memberChecksums);
    checksums[name] = checksumOfChecksums(memberChecksums);
  };
  assign('subjects', records.subjects);
  assign('progression', records.progression);
  assign('sessions', records.sessions);
  assign('preferences', records.preferences);
  assign('shortcuts', records.shortcuts);
  assign('assistance', records.assistance);
  assign('attachments', [...records.attachmentMetadata, ...records.attachmentBlobs]);
  assign('customSprites', records.customSprites);
  assign('recovery', records.recovery);
  assign('migrationReceipts', records.migrationReceipts);
  checksums.meta = checksumOfChecksums(all);
  return checksums;
}

/** Every envelope in a record set, across all lists. */
function* allEnvelopes(records: GenerationRecords): Generator<StorageRecordEnvelope<unknown>> {
  for (const { key } of RECORD_LIST_STORES) {
    yield* records[key] as readonly StorageRecordEnvelope<unknown>[];
  }
}

function countEnvelopes(records: GenerationRecords): number {
  return [...allEnvelopes(records)].length;
}

/**
 * Apply an upsert set to a record set, keyed by `(store, recordId)`.
 *
 * Mirrors what a `put` does inside the transaction, so the descriptor computed
 * from the result describes exactly what the commit will produce.
 */
function mergeEnvelopes(
  records: GenerationRecords,
  incoming: Partial<GenerationRecords>,
): GenerationRecords {
  const merged: GenerationRecords = {
    subjects: [...records.subjects],
    progression: [...records.progression],
    sessions: [...records.sessions],
    preferences: [...records.preferences],
    shortcuts: [...records.shortcuts],
    assistance: [...records.assistance],
    attachmentMetadata: [...records.attachmentMetadata],
    attachmentBlobs: [...records.attachmentBlobs],
    customSprites: [...records.customSprites],
    recovery: [...records.recovery],
    migrationReceipts: [...records.migrationReceipts],
  };
  for (const { key } of RECORD_LIST_STORES) {
    const upserts = incoming[key] as readonly StorageRecordEnvelope<unknown>[] | undefined;
    if (!upserts || upserts.length === 0) continue;
    const target = merged[key] as StorageRecordEnvelope<unknown>[];
    for (const upsert of upserts) {
      const index = target.findIndex((entry) => entry.recordId === upsert.recordId);
      if (index >= 0) {
        target[index] = upsert;
        continue;
      }
      target.push(upsert);
    }
  }
  return merged;
}

/** Remove the given record ids from a record set. */
function omitEnvelopes(
  records: GenerationRecords,
  removals: readonly [StorageV2StoreName, string[]][],
): GenerationRecords {
  const byStore = new Map<StorageV2StoreName, Set<string>>(removals.map(([store, ids]) => [store, new Set(ids)]));
  const keep = (store: StorageV2StoreName) => (entry: StorageRecordEnvelope<unknown>): boolean =>
    !byStore.get(store)?.has(entry.recordId);

  return {
    subjects: records.subjects.filter(keep('subjects')),
    progression: records.progression.filter(keep('progression')),
    sessions: records.sessions.filter(keep('sessions')),
    preferences: records.preferences.filter(keep('preferences')),
    shortcuts: records.shortcuts.filter(keep('shortcuts')),
    assistance: records.assistance.filter(keep('assistance')),
    attachmentMetadata: records.attachmentMetadata.filter(keep('attachments')),
    attachmentBlobs: records.attachmentBlobs.filter(keep('attachments')),
    customSprites: records.customSprites.filter(keep('customSprites')),
    recovery: records.recovery.filter(keep('recovery')),
    migrationReceipts: records.migrationReceipts.filter(keep('migrationReceipts')),
  };
}

/** The record ids a delete request resolves to, grouped by store. */
function resolveDeleteTargets(
  targets: DeleteRecordsTarget,
): [StorageV2StoreName, string[]][] {
  const resolved: [StorageV2StoreName, string[]][] = [];
  const drop = (store: StorageV2StoreName, ids: readonly string[] | undefined): void => {
    if (!ids || ids.length === 0) return;
    resolved.push([store, [...ids]]);
  };
  drop('subjects', targets.subjects);
  drop('progression', targets.progression);
  drop('sessions', targets.sessions);
  drop('preferences', targets.preferences);
  drop('shortcuts', targets.shortcuts);
  drop('assistance', targets.assistance);
  if (targets.attachments && targets.attachments.length > 0) {
    const ids: string[] = [];
    for (const id of targets.attachments) {
      ids.push(attachmentMetadataRecordId(id), attachmentBlobRecordId(id));
    }
    resolved.push(['attachments', ids]);
  }
  drop('customSprites', targets.customSprites);
  drop('recovery', targets.recovery);
  return resolved;
}

function splitAttachmentStore(entries: StorageRecordEnvelope<unknown>[]): {
  metadata: StorageRecordEnvelope<AttachmentMetadataRecordValue>[];
  blobs: StorageRecordEnvelope<AttachmentBlobRecordValue>[];
} {
  const metadata: StorageRecordEnvelope<AttachmentMetadataRecordValue>[] = [];
  const blobs: StorageRecordEnvelope<AttachmentBlobRecordValue>[] = [];
  for (const entry of entries) {
    if (entry.recordId.startsWith(ATTACHMENT_BLOB_PREFIX)) {
      blobs.push(entry as unknown as StorageRecordEnvelope<AttachmentBlobRecordValue>);
      continue;
    }
    metadata.push(entry as unknown as StorageRecordEnvelope<AttachmentMetadataRecordValue>);
  }
  return { metadata, blobs };
}

// ── Repository implementation ─────────────────────────────────────────────

class Repository implements StorageV2Repository {
  readonly databaseName: string;
  readonly clock: StorageV2Clock;
  readonly idFactory: StorageV2IdFactory;
  private readonly handle: { db: IDBDatabase; close(): void };

  constructor(
    handle: { db: IDBDatabase; databaseName: string; close(): void },
    clock: StorageV2Clock,
    idFactory: StorageV2IdFactory,
  ) {
    this.handle = handle;
    this.databaseName = handle.databaseName;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  private get db(): IDBDatabase {
    return this.handle.db;
  }

  close(): void {
    this.handle.close();
  }

  // ── Read-only passes ──

  private async readMeta<TValue>(recordId: string): Promise<TValue | null> {
    const tx = this.db.transaction('meta', 'readonly');
    const request = requestToPromise<MetaRecordEnvelope<TValue> | undefined>(
      tx.objectStore('meta').index('byKey').get(recordId) as IDBRequest<
        MetaRecordEnvelope<TValue> | undefined
      >,
    );
    const done = transactionToPromise(tx);
    const [entry] = await Promise.all([request, done.catch(() => undefined)]);
    return entry?.value ?? null;
  }

  private async readStore<TValue>(
    storeName: StorageV2StoreName,
    generationId: string,
  ): Promise<StorageRecordEnvelope<TValue>[]> {
    const tx = this.db.transaction(storeName, 'readonly');
    const request = requestToPromise<StorageRecordEnvelope<TValue>[]>(
      tx.objectStore(storeName).index('byGeneration').getAll(generationId) as IDBRequest<
        StorageRecordEnvelope<TValue>[]
      >,
    );
    const done = transactionToPromise(tx);
    const [entries] = await Promise.all([request, done.catch(() => undefined)]);
    return entries ?? [];
  }

  private async collectRecords(generationId: string): Promise<GenerationRecords> {
    const [
      subjects,
      progression,
      sessions,
      preferences,
      shortcuts,
      assistance,
      attachments,
      customSprites,
      recovery,
      migrationReceipts,
    ] = await Promise.all([
      this.readStore<SubjectRecordValue>('subjects', generationId),
      this.readStore<ProgressionRecordValue>('progression', generationId),
      this.readStore<SessionRecordValue>('sessions', generationId),
      this.readStore<PreferenceRecordValue>('preferences', generationId),
      this.readStore<ShortcutRecordValue>('shortcuts', generationId),
      this.readStore<AssistanceRecordValue>('assistance', generationId),
      this.readStore<AttachmentMetadataRecordValue>('attachments', generationId),
      this.readStore<CustomSpriteRecordValue>('customSprites', generationId),
      this.readStore<RecoveryRecordValue>('recovery', generationId),
      this.readStore<MigrationReceiptValue>('migrationReceipts', generationId),
    ]);
    const { metadata, blobs } = splitAttachmentStore(attachments as StorageRecordEnvelope<unknown>[]);
    return {
      subjects,
      progression,
      sessions,
      preferences,
      shortcuts,
      assistance,
      attachmentMetadata: metadata,
      attachmentBlobs: blobs,
      customSprites,
      recovery,
      migrationReceipts,
    };
  }

  // ── Write passes ──

  /**
   * Run a synchronous write body inside one read-write transaction.
   *
   * `body` must issue every request synchronously. If it throws, the transaction
   * is aborted, so a partial write can never commit.
   */
  private async writeTransaction(
    storeNames: readonly StorageV2StoreName[],
    stage: string,
    body: (tx: IDBTransaction) => void,
  ): Promise<void> {
    const tx = this.db.transaction(storeNames as unknown as string[], 'readwrite');
    const done = transactionToPromise(tx);
    try {
      body(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      await done.catch(() => undefined);
      throw toStorageV2Error(error, 'TRANSACTION_ABORTED', { stage });
    }
    await done;
  }

  // ── Generations ──

  async readRecords(generationId: string): Promise<GenerationSnapshot> {
    const [records, descriptor] = await Promise.all([
      this.collectRecords(generationId),
      this.readMeta<GenerationDescriptor>(generationMetaKey(generationId)),
    ]);
    return { generationId, descriptor, records, contentChecksum: computeStoreChecksums(records).meta };
  }

  async listGenerations(): Promise<GenerationDescriptor[]> {
    const tx = this.db.transaction('meta', 'readonly');
    const request = requestToPromise<MetaRecordEnvelope<GenerationDescriptor>[]>(
      tx.objectStore('meta').getAll() as IDBRequest<MetaRecordEnvelope<GenerationDescriptor>[]>,
    );
    const done = transactionToPromise(tx);
    const [entries] = await Promise.all([request, done.catch(() => undefined)]);
    return (entries ?? [])
      .filter((entry) => entry.recordId.startsWith(GENERATION_META_PREFIX))
      .map((entry) => entry.value)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.generationId < b.generationId
            ? -1
            : 1
          : a.createdAt < b.createdAt
            ? -1
            : 1,
      );
  }

  async readGeneration(generationId: string): Promise<GenerationSnapshot | null> {
    const descriptor = await this.readMeta<GenerationDescriptor>(generationMetaKey(generationId));
    if (!descriptor) return null;
    return this.readRecords(generationId);
  }

  async readActiveGenerationId(): Promise<string | null> {
    const pointer = await this.readMeta<ActiveGenerationPointer>(ACTIVE_GENERATION_META_KEY);
    return pointer?.activeGeneration ?? null;
  }

  async readActiveGeneration(): Promise<GenerationSnapshot | null> {
    const activeId = await this.readActiveGenerationId();
    if (activeId === null) return null;
    return this.readGeneration(activeId);
  }

  async stageGeneration(input: StageGenerationInput): Promise<StageGenerationResult> {
    if (input.generationId.trim().length === 0) {
      throw new StorageV2Error('RECORD_INVALID', { field: 'generationId' });
    }
    const existing = await this.readMeta<GenerationDescriptor>(generationMetaKey(input.generationId));
    if (existing && existing.status === 'active') {
      throw new StorageV2Error('GENERATION_ALREADY_ACTIVE', { generationId: input.generationId });
    }

    const updatedAt = this.clock.now();
    const records = buildRecordEnvelopes(input.generationId, input.records, updatedAt);
    const descriptor: GenerationDescriptor = {
      generationId: input.generationId,
      generationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
      subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      status: 'staged',
      source: input.source,
      createdAt: updatedAt,
      activatedAt: null,
      parentGenerationId: input.parentGenerationId ?? null,
      recordCounts: countGenerationRecords(records),
      contentChecksum: computeStoreChecksums(records).meta,
    };

    const point = input.onStage;
    await this.writeTransaction(allStoreNames(), 'stage', (tx) => {
      putAll(tx, 'subjects', records.subjects);
      point?.('after-subjects');
      putAll(tx, 'progression', records.progression);
      point?.('after-progression');
      putAll(tx, 'sessions', records.sessions);
      putAll(tx, 'preferences', records.preferences);
      putAll(tx, 'shortcuts', records.shortcuts);
      putAll(tx, 'assistance', records.assistance);
      point?.('after-sessions');
      putAttachmentRecords(tx, records);
      point?.('after-attachments');
      putAll(tx, 'customSprites', records.customSprites);
      putAll(tx, 'recovery', records.recovery);
      putAll(tx, 'migrationReceipts', records.migrationReceipts);
      writeGenerationDescriptorTo(tx, descriptor, updatedAt);
      point?.('before-meta');
      point?.('before-commit');
    });

    return {
      generationId: input.generationId,
      descriptor,
      recordCounts: descriptor.recordCounts,
      contentChecksum: descriptor.contentChecksum,
    };
  }

  /**
   * Validate a staged generation.
   *
   * Re-reads the generation from storage rather than trusting the caller's copy,
   * so a mismatch between what was intended and what landed is visible before
   * activation.
   */
  async validateGeneration(generationId: string): Promise<GenerationValidationReport> {
    const snapshot = await this.readGeneration(generationId);
    if (!snapshot || !snapshot.descriptor) {
      throw new StorageV2Error('GENERATION_NOT_FOUND', { generationId });
    }
    const { records, descriptor } = snapshot;
    const actual = countGenerationRecords(records);
    const result = validateGenerationRecords(generationId, descriptor, records);
    const countDeltas = emptyCounts();
    for (const [storeName, count] of Object.entries(actual)) {
      const declared = descriptor.recordCounts[storeName as StorageV2StoreName] ?? 0;
      countDeltas[storeName as StorageV2StoreName] = declared - count;
    }
    const checksumMismatches: StorageV2StoreName[] =
      snapshot.contentChecksum === descriptor.contentChecksum ? [] : ['meta'];
    return {
      generationId,
      ok: result.ok && checksumMismatches.length === 0,
      problems: result.problems,
      recordCounts: actual,
      countDeltas,
      contentChecksum: snapshot.contentChecksum,
      checksumMismatches,
    };
  }

  async activateGeneration(generationId: string): Promise<ActivationResult> {
    return this.pointPointerAt(generationId, 'activate');
  }

  async rollbackToGeneration(generationId: string): Promise<ActivationResult> {
    return this.pointPointerAt(generationId, 'rollback');
  }

  /**
   * Flip `activeGeneration` in one transaction.
   *
   * The previous generation is marked `superseded` and **retained**, which is
   * the rollback path (plan section 7.1 step 6). Both descriptor writes and the
   * pointer write commit together, so the pointer can never name a generation
   * whose registry entry is not `active`.
   */
  private async pointPointerAt(
    generationId: string,
    stage: 'activate' | 'rollback',
  ): Promise<ActivationResult> {
    const [descriptor, pointer] = await Promise.all([
      this.readMeta<GenerationDescriptor>(generationMetaKey(generationId)),
      this.readMeta<ActiveGenerationPointer>(ACTIVE_GENERATION_META_KEY),
    ]);
    if (!descriptor) {
      throw new StorageV2Error('GENERATION_NOT_FOUND', { generationId });
    }
    const previousActiveGenerationId = pointer?.activeGeneration ?? null;
    if (previousActiveGenerationId === generationId) {
      throw new StorageV2Error('GENERATION_ALREADY_ACTIVE', { generationId });
    }
    if (stage === 'activate' && descriptor.status !== 'staged') {
      throw new StorageV2Error('GENERATION_NOT_STAGGED', { generationId, status: descriptor.status });
    }

    const updatedAt = this.clock.now();
    let superseded: GenerationDescriptor | null = null;
    if (previousActiveGenerationId !== null) {
      superseded = await this.readMeta<GenerationDescriptor>(
        generationMetaKey(previousActiveGenerationId),
      );
    }

    await this.writeTransaction(['meta'], stage, (tx) => {
      if (superseded) {
        writeGenerationDescriptorTo(tx, { ...superseded, status: 'superseded' }, updatedAt);
      }
      writeGenerationDescriptorTo(
        tx,
        { ...descriptor, status: 'active', activatedAt: updatedAt },
        updatedAt,
      );
      writeActiveGenerationPointerTo(
        tx,
        {
          pointerVersion: ACTIVE_GENERATION_POINTER_VERSION,
          activeGeneration: generationId,
          updatedAt,
        } satisfies ActiveGenerationPointer,
        updatedAt,
      );
    });

    return { previousActiveGenerationId, activeGenerationId: generationId };
  }

  /**
   * Remove old generations.
   *
   * The active generation is never removed, explicit retains are never removed,
   * and `keepAtLeast` older generations are kept for rollback. All deletions for
   * one generation happen in a single transaction.
   */
  async pruneGenerations(options: PruneOptions = {}): Promise<PruneResult> {
    const keepAtLeast = Math.max(1, options.keepAtLeast ?? 2);
    const retain = new Set(options.retain ?? []);
    const generations = await this.listGenerations();
    const activeId = await this.readActiveGenerationId();
    if (activeId !== null) retain.add(activeId);

    const candidates = generations
      .filter((descriptor) => descriptor.status !== 'active' && !retain.has(descriptor.generationId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const keepCount = keepAtLeast - (activeId === null ? 0 : 1);
    const doomed = candidates.slice(0, Math.max(0, candidates.length - Math.max(0, keepCount)));

    const removed: string[] = [];
    for (const descriptor of doomed) {
      const generationId = descriptor.generationId;
      await this.writeTransaction(allStoreNames(), 'prune', (tx) => {
        // The keys are read and deleted inside the same transaction, from the
        // request's own success handler, so the transaction is still active and
        // a record written between two passes cannot survive a prune.
        for (const storeName of allStoreNames()) {
          if (storeName === 'meta') continue;
          const request = tx.objectStore(storeName).index('byGeneration').getAllKeys(generationId);
          request.onsuccess = () => {
            const store = tx.objectStore(storeName);
            for (const key of request.result) store.delete(key);
          };
        }
        tx.objectStore('meta').delete([generationId, generationMetaKey(generationId)]);
      });
      removed.push(generationId);
    }

    return {
      removed,
      retained: generations
        .map((descriptor) => descriptor.generationId)
        .filter((id) => !removed.includes(id)),
    };
  }

  /** Write or replace records inside an existing generation, in one transaction. */
  async putRecords(
    generationId: string,
    records: Partial<GenerationRecordValues>,
  ): Promise<PutRecordsResult> {
    const before = await this.requireGeneration(generationId);
    const updatedAt = this.clock.now();
    const envelopes = buildRecordEnvelopes(generationId, records, updatedAt);
    const next = mergeEnvelopes(before.records, envelopes);
    const descriptor = this.recomputeDescriptor(before, next);

    // The data and the descriptor that describes it commit together, so a crash
    // can never leave a `recordCounts` / `contentChecksum` that disagrees with
    // the records it describes.
    await this.writeTransaction(allStoreNames(), 'put', (tx) => {
      for (const { key, store } of RECORD_LIST_STORES) {
        const list = envelopes[key] as readonly StorageRecordEnvelope<unknown>[];
        if (list.length === 0) continue;
        putAll(tx, store, list);
      }
      writeGenerationDescriptorTo(tx, descriptor, updatedAt);
    });

    return {
      generationId,
      recordCounts: descriptor.recordCounts,
      contentChecksum: descriptor.contentChecksum,
    };
  }

  /** Delete records from a generation by record id, in one transaction. */
  async deleteRecords(
    generationId: string,
    targets: DeleteRecordsTarget,
  ): Promise<DeleteRecordsResult> {
    const before = await this.requireGeneration(generationId);
    const removedIds = resolveDeleteTargets(targets);
    const next = omitEnvelopes(before.records, removedIds);
    const updatedAt = this.clock.now();
    const descriptor = this.recomputeDescriptor(before, next);
    const removed = countEnvelopes(before.records) - countEnvelopes(next);

    await this.writeTransaction(allStoreNames(), 'delete', (tx) => {
      for (const [storeName, ids] of removedIds) {
        const objectStore = tx.objectStore(storeName);
        for (const id of ids) {
          objectStore.delete([generationId, id]);
        }
      }
      writeGenerationDescriptorTo(tx, descriptor, updatedAt);
    });

    return {
      generationId,
      removed,
      recordCounts: descriptor.recordCounts,
      contentChecksum: descriptor.contentChecksum,
    };
  }

  /**
   * The generation's descriptor together with its current records, or a typed
   * error.
   *
   * Every mutating method starts here, so no write is ever issued against a
   * generation that does not exist, and every one of them already knows the
   * post-write state before opening a transaction.
   */
  private async requireGeneration(
    generationId: string,
  ): Promise<{ descriptor: GenerationDescriptor; records: GenerationRecords }> {
    const [descriptor, records] = await Promise.all([
      this.readMeta<GenerationDescriptor>(generationMetaKey(generationId)),
      this.collectRecords(generationId),
    ]);
    if (!descriptor) {
      throw new StorageV2Error('GENERATION_NOT_FOUND', { generationId });
    }
    return { descriptor, records };
  }

  /**
   * A descriptor that describes `next` rather than the records still on disk.
   *
   * Pure, so the caller can compute the whole descriptor before opening a
   * transaction and commit it together with the data.
   */
  private recomputeDescriptor(
    before: { descriptor: GenerationDescriptor },
    next: GenerationRecords,
  ): GenerationDescriptor {
    return {
      ...before.descriptor,
      recordCounts: countGenerationRecords(next),
      contentChecksum: computeStoreChecksums(next).meta,
    };
  }

  /**
   * Discard a `staged` generation and everything in it.
   *
   * The recovery path for a run that failed after its stage commit: the abandoned
   * generation is invisible to every reader, and deleting it lets a retry with
   * the same id start from a clean slate. Refuses to touch an `active` or
   * `superseded` generation, so this can never destroy live or rollback data.
   *
   * Returns `true` when a staged generation was removed.
   */
  async discardStagedGeneration(generationId: string): Promise<boolean> {
    const descriptor = await this.readMeta<GenerationDescriptor>(generationMetaKey(generationId));
    if (!descriptor) return false;
    if (descriptor.status !== 'staged') {
      throw new StorageV2Error('GENERATION_NOT_STAGGED', {
        generationId,
        status: descriptor.status,
      });
    }

    await this.writeTransaction(allStoreNames(), 'discard', (tx) => {
      for (const storeName of allStoreNames()) {
        if (storeName === 'meta') continue;
        const request = tx.objectStore(storeName).index('byGeneration').getAllKeys(generationId);
        request.onsuccess = () => {
          const store = tx.objectStore(storeName);
          for (const key of request.result) store.delete(key);
        };
      }
      tx.objectStore('meta').delete([generationId, generationMetaKey(generationId)]);
    });
    return true;
  }

  /** Write a migration receipt into the generation it describes. */
  async writeMigrationReceipt(receipt: MigrationReceiptValue): Promise<void> {
    const generationId = receipt.stagedGenerationId;
    const before = await this.requireGeneration(generationId);
    const updatedAt = this.clock.now();
    const record = envelope(generationId, receipt.receiptId, receipt, updatedAt);
    const next = mergeEnvelopes(before.records, { migrationReceipts: [record] });
    const descriptor = this.recomputeDescriptor(before, next);

    await this.writeTransaction(allStoreNames(), 'receipt', (tx) => {
      tx.objectStore('migrationReceipts').put(record);
      writeGenerationDescriptorTo(tx, descriptor, updatedAt);
    });
  }


  async listMigrationReceipts(generationId?: string): Promise<MigrationReceiptValue[]> {
    const entries =
      generationId !== undefined
        ? await this.readStore<MigrationReceiptValue>('migrationReceipts', generationId)
        : await (async () => {
            const tx = this.db.transaction('migrationReceipts', 'readonly');
            const request = requestToPromise<StorageRecordEnvelope<MigrationReceiptValue>[]>(
              tx.objectStore('migrationReceipts').getAll() as IDBRequest<
                StorageRecordEnvelope<MigrationReceiptValue>[]
              >,
            );
            const done = transactionToPromise(tx);
            const [all] = await Promise.all([request, done.catch(() => undefined)]);
            return all ?? [];
          })();
    return entries
      .map((entry) => entry.value)
      .sort((a, b) => (a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0));
  }
}

function putAll<TValue>(
  tx: IDBTransaction,
  storeName: StorageV2StoreName,
  records: readonly StorageRecordEnvelope<TValue>[],
): void {
  const store = tx.objectStore(storeName);
  for (const record of records) {
    store.put(record);
  }
}

/**
 * Write both attachment record kinds into the one `attachments` store.
 *
 * Their record ids are prefixed (`meta:` and `blob:`) so the two can be split
 * apart again on read without an extra index.
 */
function putAttachmentRecords(tx: IDBTransaction, records: GenerationRecords): void {
  const store = tx.objectStore('attachments');
  for (const record of records.attachmentMetadata) {
    store.put(record);
  }
  for (const record of records.attachmentBlobs) {
    store.put(record);
  }
}

/**
 * Open the storage-v2 database and return its repository.
 *
 * Nothing in the live application calls this yet. Phase 4 introduces the
 * disabled-by-default flag that routes the persistence facade through it.
 */
export async function openStorageV2Repository(
  options: OpenRepositoryOptions = {},
): Promise<StorageV2Repository> {
  const clock = options.clock ?? fixedClock('1970-01-01T00:00:00.000Z');
  const idFactory = options.idFactory ?? createDeterministicIdFactory('gen');
  const handle = await openStorageV2Database({ ...options, clock, idFactory });
  return new Repository(handle, clock, idFactory);
}
