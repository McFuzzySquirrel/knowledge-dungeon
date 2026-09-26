/**
 * Legacy `localStorage` to storage-v2 migration.
 *
 * This module follows plan section 7.2 exactly, in order:
 *
 * 1. Read the legacy state **without modifying it** (see `legacyReader.ts`).
 * 2. Validate the source, and validate every subject with the shared subject
 *    validator. Nothing is written before validation passes.
 * 3. Migrate subject schema `1.0.0` to `1.1.0`, preserving unknown top-level,
 *    dungeon-level, and room-level app-owned fields.
 * 4. Normalize progression versions 1, 2, and 3 into the one canonical form.
 * 5. Stage a **complete** new generation in one transaction.
 * 6. Compare record counts, relationships, and checksums against what was staged.
 * 7. Write a migration receipt (counts, checksums, and version identifiers only).
 * 8. Flip `activeGeneration` **only after** validation succeeds.
 * 9. Retain the previous generation for rollback.
 *
 * On any failure the legacy state stays active and untouched, `activeGeneration`
 * is not flipped, and a recovery result is returned.
 *
 * Determinism: the clock and the id factory are injected, `createId` is seeded,
 * and nothing here reads the real clock, calls `Math.random()`, or touches the
 * network.
 */

import {
  isImportableSubjectSnapshot,
  migrateSubjectSnapshot,
  validateSubjectSnapshot,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import {
  normalizeProgressionRecord,
  type CanonicalProgression,
} from '@/core/progression/canonicalProgression';
import { checksumValue } from './checksum';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  LEGACY_MIGRATION_ID,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  StorageV2Error,
  type AssistanceRecordValue,
  type AttachmentMetadataRecordValue,
  type CustomSpriteRecordValue,
  type ExternalOnlyAttachmentReport,
  type MigrationCounts,
  type MigrationReceiptValue,
  type MigrationReport,
  type PreferenceRecordValue,
  type ProgressionRecordValue,
  type RecoveryRecordValue,
  type SessionRecordValue,
  type ShortcutRecordValue,
  type SubjectRecordValue,
} from './schema';
import { computeStoreChecksums, type StorageV2Repository } from './repository';
import {
  countBlockingProblems,
  type GenerationRecords,
  type GenerationRecordValues,
  type ValidationProblem,
} from './validation';
import { hasNoLearnerContent, readLegacyAppState, type LegacyAppState, type ReadOnlyLegacyStorage } from './legacyReader';

/**
 * Points in the migration where a failure can be injected by a test.
 *
 * The hook is a test seam, declared as part of the migration contract so the
 * rollback behavior is provable rather than asserted. It is never wired to
 * anything in production.
 */
export type MigrationStage =
  | 'read-legacy'
  | 'transform'
  | 'stage-records'
  | 'validate'
  | 'compare'
  | 'receipt'
  | 'activate';

export const MIGRATION_STAGES: readonly MigrationStage[] = [
  'read-legacy',
  'transform',
  'stage-records',
  'validate',
  'compare',
  'receipt',
  'activate',
];

/**
 * The injected collaborator a test uses to fail a run at a chosen point.
 *
 * Failure injection is a *dependency*, not a property of the migration: it is a
 * separate object the caller passes, the production value is
 * {@link NO_MIGRATION_SEAMS}, and the application's entry point
 * (`migrateLegacyStateForApplication` in the application bootstrap) drops any
 * injected instance before calling in. Nothing in `src/ui`, `src/store`, or
 * `src/main.tsx` can reach a seam by passing an option.
 */
export interface MigrationSeams {
  /**
   * Called as the migration enters each stage; throwing aborts the run and
   * produces a `recovery-required` report.
   */
  onStage?: (stage: MigrationStage) => void;
  /** Fail validation after the generation is staged, to exercise recovery. */
  forceValidationFailure?: boolean;
}

/** The production value: no failure injection at all. */
export const NO_MIGRATION_SEAMS: MigrationSeams = Object.freeze({});

/**
 * Flatten the retained per-stage hooks into the injected collaborator.
 *
 * `onStage` and `forceValidationFailure` stay as direct option members because
 * the Phase 3 verification suites bind them there; they are normalized into the
 * collaborator here, and from this point on only the collaborator is read.
 */
function resolveMigrationSeams(options: MigrateLegacyStateOptions): MigrationSeams {
  const injected: MigrationSeams = options.seams ?? {};
  const onStage = injected.onStage ?? options.onStage;
  const forceValidationFailure = injected.forceValidationFailure ?? options.forceValidationFailure;
  if (onStage === undefined && forceValidationFailure === undefined) return NO_MIGRATION_SEAMS;
  return { ...(onStage ? { onStage } : {}), ...(forceValidationFailure ? { forceValidationFailure } : {}) };
}

export interface MigrateLegacyStateOptions {
  repository: StorageV2Repository;
  /**
   * Generation identifier for the new generation. Injected so a run is
   * reproducible; nothing here is random.
   */
  generationId: string;
  /** ISO-8601 timestamp used for every record the migration writes. */
  now: string;
  /** Injected ISO clock, used for the staged/activated markers. */
  clock: { now(): string };
  /**
   * Read the legacy state from here instead of the live `localStorage`. Passing
   * a snapshot is how a migration test proves the real store is never touched.
   */
  storage?: ReadOnlyLegacyStorage;
  /** Pre-read legacy state. When supplied, `storage` is not consulted. */
  legacyState?: LegacyAppState;
  /** Injected test collaborator. Normalized into the run's failure points. */
  seams?: MigrationSeams;
  /**
   * Retained flat alias for {@link MigrationSeams.onStage}, bound by the Phase 3
   * verification suites. The application never sets it.
   */
  onStage?: (stage: MigrationStage) => void;
  /**
   * Retained flat alias for {@link MigrationSeams.forceValidationFailure}. The
   * application never sets it.
   */
  forceValidationFailure?: boolean;
}

export interface MigrationOutcome {
  report: MigrationReport;
  /** `null` unless a generation was staged. */
  stagedGenerationId: string | null;
  /** The staged generation's records, for inspection. Never persisted twice. */
  records: GenerationRecords | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyCounts(): MigrationCounts {
  return {
    subjects: 0,
    progression: 0,
    sessions: 0,
    preferences: 0,
    shortcuts: 0,
    assistance: 0,
    attachments: 0,
    attachmentBlobs: 0,
    customSprites: 0,
    recovery: 0,
  };
}

function toCounts(records: GenerationRecords): MigrationCounts {
  return {
    subjects: records.subjects.length,
    progression: records.progression.length,
    sessions: records.sessions.length,
    preferences: records.preferences.length,
    shortcuts: records.shortcuts.length,
    assistance: records.assistance.length,
    attachments: records.attachmentMetadata.length,
    attachmentBlobs: records.attachmentBlobs.length,
    customSprites: records.customSprites.length,
    recovery: records.recovery.length,
  };
}

/**
 * Turn a read-only legacy state into a complete set of storage-v2 records.
 *
 * Pure: no storage access, no clock beyond the injected `now`, no randomness.
 * A subject that fails validation is reported as a problem and skipped rather
 * than written, so an unreadable subject cannot corrupt the generation.
 *
 * **Every problem raised here is a `warning`, and that is not a downgrade.**
 * `ValidationSeverity` is the activation rule: `error` means activation was
 * refused, `warning` means the condition was disclosed and the run continued.
 * These problems describe records in the *source* that this transform declined to
 * carry; by construction none of them is in the staged generation, so there is
 * nothing for generation validation to refuse, and refusing to activate the whole
 * device because one payload is corrupt would be a worse outcome than migrating
 * the rest and disclosing the count. The rule is declared once as
 * `MIGRATION_BLOCKING_POLICY` in `./migrationState`, and the activation path
 * below still refuses on any `error` from `validateGeneration`.
 */
export function buildMigratedRecords(
  state: LegacyAppState,
  options: { now: string; generationId: string },
): {
  records: Partial<GenerationRecordValues>;
  problems: ValidationProblem[];
  externalOnly: ExternalOnlyAttachmentReport[];
  subjectSchemaVersions: Record<string, number>;
  progressionSourceVersions: Record<string, number>;
} {
  const problems: ValidationProblem[] = [];
  const externalOnly: ExternalOnlyAttachmentReport[] = [];
  const subjectSchemaVersions: Record<string, number> = {};
  const progressionSourceVersions: Record<string, number> = {};

  // Identifier factory for a persisted record that is missing an id.
  //
  // It must honour the `loot` / `gear` prefix, otherwise distinct loot and gear
  // items in the same record collapse onto one id. The counter is local to this
  // call, so two runs over the same legacy state at the same injected clock
  // produce identical ids, which is what makes a migration reproducible.
  let identifierCount = 0;
  const createId = (prefix: 'loot' | 'gear'): string => {
    identifierCount += 1;
    return `${prefix}-migrated-${String(identifierCount).padStart(4, '0')}`;
  };

  const subjects: SubjectRecordValue[] = [];
  const attachmentMetadata: AttachmentMetadataRecordValue[] = [];
  // A payload the subject index does not name is preserved here instead of in
  // `subjects`, so the generation never loses bytes the device still holds while
  // its subject set stays equal to the one this build can open.
  const unindexedSubjects: RecoveryRecordValue[] = [];
  const indexedIds = state.indexedSubjectIds === undefined ? null : new Set(state.indexedSubjectIds);

  for (const subject of state.subjects) {
    if (indexedIds !== null && !indexedIds.has(subject.subjectId)) {
      unindexedSubjects.push({
        kind: 'unindexed-subject',
        subjectId: subject.subjectId,
        raw: subject.raw,
        capturedAt: options.now,
      });
      problems.push({
        code: 'unindexed-subject-payload',
        scope: 'subject',
        count: 1,
        severity: 'warning',
      });
      continue;
    }
    if (subject.parsed === null) {
      problems.push({ code: 'not-an-object', scope: 'subject', count: 1, severity: 'warning' });
      continue;
    }
    // A payload the current importer rejects is not migrated; a payload the
    // importer accepts is always carried, with its shallower structural findings
    // disclosed as warnings. Dropping an openable subject would be destructive.
    if (!isImportableSubjectSnapshot(subject.parsed)) {
      problems.push({ code: 'not-an-object', scope: 'subject', count: 1, severity: 'warning' });
      continue;
    }
    for (const problem of validateSubjectSnapshot(subject.parsed).problems) {
      problems.push({ code: problem.code, scope: 'subject', count: problem.count, severity: 'warning' });
    }
    if (subject.schemaVersion !== null) {
      subjectSchemaVersions[subject.schemaVersion] =
        (subjectSchemaVersions[subject.schemaVersion] ?? 0) + 1;
    }

    // Storage-v2 policy: preserve unknown top-level, dungeon, and room fields.
    const migration = migrateSubjectSnapshot(subject.parsed, {
      nowIso: options.now,
      unknownTopLevelFields: 'preserve',
    });
    const snapshot = migration.snapshot as unknown as SubjectSnapshot;
    const subjectId = snapshot.dungeon.dungeonId || subject.subjectId;

    const record: SubjectRecordValue = {
      subjectId,
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      snapshot,
      createdAt: snapshot.dungeon.createdAt || options.now,
      updatedAt: snapshot.dungeon.updatedAt || options.now,
    };
    // Re-staging an identical payload must not duplicate a record.
    const existingIndex = subjects.findIndex((entry) => entry.subjectId === subjectId);
    if (existingIndex >= 0) {
      problems.push({ code: 'duplicate-identifier', scope: 'subject', count: 1, severity: 'warning' });
      subjects[existingIndex] = record;
    } else {
      subjects.push(record);
    }

    // Dedupe is scoped to this subject: an attachment id is only unique within
    // a subject's graph, so a repeated id in a second subject must not make the
    // first subject responsible for dropping the second subject's record.
    const seenAttachmentIds = new Set<string>();
    for (const roomId of Object.keys(snapshot.rooms)) {
      const room = snapshot.rooms[roomId];
      const attachments = room?.attachments ?? [];
      for (const attachment of attachments) {
        if (seenAttachmentIds.has(attachment.attachmentId)) {
          problems.push({ code: 'duplicate-identifier', scope: 'attachment', count: 1, severity: 'warning' });
          continue;
        }
        seenAttachmentIds.add(attachment.attachmentId);
        const isExternal = attachment.sourceType === 'external';
        const reason: ExternalOnlyAttachmentReport['reason'] = isExternal
          ? 'historical-external-url'
          : 'bytes-not-recoverable';
        attachmentMetadata.push({
          attachmentId: attachment.attachmentId,
          subjectId,
          roomId,
          sourceType: isExternal ? 'external' : 'local',
          mimeType: attachment.mimeType,
          availability: 'external-only',
          // No bytes are recoverable from the legacy web build, so there is no
          // content hash to record. Never a placeholder hash.
          contentHash: null,
          fileName: attachment.fileName,
          externalUrl: attachment.externalUrl,
          altText: attachment.altText,
          addedAt: attachment.addedAt || options.now,
        });
        externalOnly.push({
          attachmentId: attachment.attachmentId,
          subjectId,
          roomId,
          contentHash: null,
          byteLength: null,
          reason,
          sourceType: isExternal ? 'external' : 'local',
        });
        // `externalOnly` is the detailed per-attachment disclosure; this is its
        // summary line, so a reader who only reads the problem list still sees
        // that a record was carried without its bytes. A disclosure, never a
        // block: the metadata is honest and the generation is consistent.
        problems.push({ code: 'stored-without-bytes', scope: 'attachment', count: 1, severity: 'warning' });
      }
    }
  }

  // ── Progression ──
  const progression: ProgressionRecordValue[] = [];
  if (state.progressionRaw !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(state.progressionRaw) as unknown;
    } catch {
      problems.push({ code: 'not-an-object', scope: 'progression', count: 1, severity: 'warning' });
    }
    if (parsed !== null) {
      const canonical: CanonicalProgression = normalizeProgressionRecord(parsed, {
        activeSubjectId: state.activeSubjectId,
        createId: createId,
      });
      const sourceKey = String(canonical.sourceVersion);
      progressionSourceVersions[sourceKey] = 1;
      for (const [subjectId, subject] of Object.entries(canonical.bySubject)) {
        progression.push({
          subjectId,
          sourceVersion: canonical.sourceVersion,
          rank: subject.rank,
          xpTotal: subject.xpTotal,
          bySubject: { [subjectId]: { ...subject, extraFields: subject.extraFields } },
          crossSubjectAchievements: [...canonical.crossSubjectAchievements],
        });
      }
    }
  }

  // ── Sessions ──
  const sessions: SessionRecordValue[] = [];
  if (state.sessionsRaw !== null) {
    try {
      const parsed = JSON.parse(state.sessionsRaw) as unknown;
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        for (const raw of parsed) {
          if (!isRecord(raw) || typeof raw.sessionId !== 'string') {
            problems.push({ code: 'wrong-type', scope: 'session', count: 1, severity: 'warning' });
            continue;
          }
          if (seen.has(raw.sessionId)) {
            problems.push({ code: 'duplicate-identifier', scope: 'session', count: 1, severity: 'warning' });
            continue;
          }
          seen.add(raw.sessionId);
          sessions.push({
            sessionId: raw.sessionId,
            subjectId: typeof raw.subjectId === 'string' ? raw.subjectId : '',
            // The name the legacy session record holds, so a session for a
            // subject with no carried record hydrates the same name here.
            ...(typeof raw.subjectName === 'string' ? { subjectName: raw.subjectName } : {}),
            startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : options.now,
            endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
            roomsVisited: Array.isArray(raw.roomsVisited)
              ? raw.roomsVisited.filter((room): room is string => typeof room === 'string')
              : [],
            notesSubmitted: typeof raw.notesSubmitted === 'number' ? raw.notesSubmitted : 0,
            reviewsCompleted: typeof raw.reviewsCompleted === 'number' ? raw.reviewsCompleted : 0,
            xpEarned: typeof raw.xpEarned === 'number' ? raw.xpEarned : 0,
            // Derived from the legacy identifiers, so re-running the migration
            // produces the same event id and a replay is a no-op.
            eventId: checksumValue({ sessionId: raw.sessionId, startedAt: raw.startedAt }).slice(0, 32),
          });
        }
      } else {
        problems.push({ code: 'unexpected-json-shape', scope: 'session', count: 1, severity: 'warning' });
      }
    } catch {
      problems.push({ code: 'not-an-object', scope: 'session', count: 1, severity: 'warning' });
    }
  }

  // ── Preferences, shortcuts, locale, UI markers ──
  const preferences: PreferenceRecordValue[] = [];
  if (state.preferencesRaw !== null) {
    preferences.push({ preferenceId: 'graphics', value: parseOrKeep(state.preferencesRaw), updatedAt: options.now });
  }
  if (state.locale !== null) {
    preferences.push({ preferenceId: 'locale', value: state.locale, updatedAt: options.now });
  }
  for (const [keyId, value] of Object.entries(state.uiMarkers)) {
    if (value === null) continue;
    preferences.push({ preferenceId: `ui:${keyId}`, value, updatedAt: options.now });
  }

  const shortcuts: ShortcutRecordValue[] = [];
  if (state.shortcutsRaw !== null) {
    try {
      const parsed = JSON.parse(state.shortcutsRaw) as unknown;
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          if (!isRecord(raw) || typeof raw.key !== 'string') {
            problems.push({ code: 'wrong-type', scope: 'shortcut', count: 1, severity: 'warning' });
            continue;
          }
          shortcuts.push({
            actionId: typeof raw.labelKey === 'string' ? raw.labelKey : 'unknown',
            labelKey: typeof raw.labelKey === 'string' ? raw.labelKey : '',
            key: raw.key,
            ctrlKey: typeof raw.ctrlKey === 'boolean' ? raw.ctrlKey : false,
            shiftKey: typeof raw.shiftKey === 'boolean' ? raw.shiftKey : false,
          });
        }
      } else {
        problems.push({ code: 'unexpected-json-shape', scope: 'shortcut', count: 1, severity: 'warning' });
      }
    } catch {
      problems.push({ code: 'not-an-object', scope: 'shortcut', count: 1, severity: 'warning' });
    }
  }

  // ── Assistance defaults (Phase 19 rules, Phase 3 default only) ──
  const assistance: AssistanceRecordValue[] = [
    { assistanceId: 'default', mode: 'standard', signals: {}, dismissalCount: 0, updatedAt: options.now },
  ];

  // ── Custom sprites, preserved verbatim ──
  const customSprites: CustomSpriteRecordValue[] = [];
  for (const sprite of state.customSprites) {
    if (sprite.override !== null) {
      customSprites.push({
        spritePath: sprite.spritePath,
        kind: 'override',
        content: sprite.override,
        updatedAt: options.now,
      });
    }
    if (sprite.anim !== null) {
      customSprites.push({
        spritePath: sprite.spritePath,
        kind: 'anim',
        content: sprite.anim,
        updatedAt: options.now,
      });
    }
    if (sprite.original !== null) {
      customSprites.push({
        spritePath: sprite.spritePath,
        kind: 'original',
        content: sprite.original,
        updatedAt: options.now,
      });
    }
  }
  if (state.spritePacksRaw !== null) {
    customSprites.push({
      spritePath: 'packs',
      kind: 'override',
      content: state.spritePacksRaw,
      updatedAt: options.now,
    });
  }

  // ── Recovery records, byte-for-byte ──
  const recovery: RecoveryRecordValue[] = state.recovery.map((entry) => ({
    kind: entry.kind,
    subjectId: entry.subjectId,
    raw: entry.raw,
    capturedAt: options.now,
  }));
  // After the quarantined records, so a reader walking them sees the
  // device's own recovery data before the migration's own.
  recovery.push(...unindexedSubjects);

  return {
    records: { subjects, progression, sessions, preferences, shortcuts, assistance, attachmentMetadata, customSprites, recovery },
    problems,
    externalOnly,
    subjectSchemaVersions,
    progressionSourceVersions,
  };
}

function parseOrKeep(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Preserved as text rather than dropped: the migration must not lose data
    // it cannot interpret.
    return { rawText: raw };
  }
}

/**
 * Run the legacy-to-storage-v2 migration.
 *
 * Never throws for a data problem: a failure is reported through
 * `report.status === 'recovery-required'` with `report.recovery` set, and the
 * legacy state is left exactly as it was. An unexpected internal error is still
 * converted to a typed {@link StorageV2Error} so the caller can log it safely.
 */
export async function migrateLegacyState(
  options: MigrateLegacyStateOptions,
): Promise<MigrationOutcome> {
  const { repository, generationId, now, clock } = options;
  const seams = resolveMigrationSeams(options);
  const createdAt = clock.now();
  const empty = emptyCounts();

  const report: MigrationReport = {
    migrationId: LEGACY_MIGRATION_ID,
    status: 'recovery-required',
    stagedGenerationId: null,
    activated: false,
    previousActiveGenerationId: null,
    createdAt,
    legacyKeys: {
      allowlistedKeys: 0,
      present: 0,
      absent: 0,
      parseErrors: 0,
      unsupportedShapes: 0,
    },
    subjectSchemaVersions: {},
    progressionSourceVersions: {},
    recordCounts: empty,
    attachments: { total: 0, storedBytes: 0, externalOnly: 0 },
    externalOnlyAttachments: [],
    problems: [],
    contentChecksum: null,
    receiptId: null,
    recovery: null,
  };

  const point = seams.onStage;
  const forceValidationFailure = seams.forceValidationFailure === true;
  let state: LegacyAppState;
  let records: GenerationRecords | null = null;
  let previousActiveGenerationId: string | null = null;
  // Tracked so a recovery result names the stage the failure happened in, even
  // when the thrown value carries no stage of its own.
  let currentStage: MigrationStage = 'read-legacy';
  const enter = (stage: MigrationStage): void => {
    currentStage = stage;
    point?.(stage);
  };

  try {
    // ── Step 1: read and validate the source without modifying it ──
    state = options.legacyState ?? readLegacyAppState(options.storage ? { storage: options.storage } : {});
    report.legacyKeys = { ...state.report.totals };
    enter('read-legacy');

    if (hasNoLearnerContent(state)) {
      // Nothing to migrate, even though the device holds app-owned keys. A
      // first-time learner's device holds their locale, and maybe a quest step or
      // a UI marker, and that is not data: staging a generation for it would
      // write a receipt and report `activated` for zero subjects, telling a
      // learner their data was moved when there was none.
      //
      // Honest in what it leaves behind: nothing staged, no receipt, the pointer
      // never moved, and the legacy keys still authoritative. The first real
      // write creates the initial generation through `ensureInitialGeneration`.
      report.status = 'no-source-data';
      return { report, stagedGenerationId: null, records: null };
    }

    // ── Step 2: transform ──
    const built = buildMigratedRecords(state, { now, generationId });
    report.subjectSchemaVersions = built.subjectSchemaVersions;
    report.progressionSourceVersions = built.progressionSourceVersions;
    report.problems = built.problems;
    report.externalOnlyAttachments = built.externalOnly;
    report.attachments = {
      total: built.records.attachmentMetadata?.length ?? 0,
      storedBytes: 0,
      externalOnly: built.externalOnly.length,
    };
    enter('transform');

    // ── Step 3: write a complete new generation ──
    previousActiveGenerationId = await repository.readActiveGenerationId();
    report.previousActiveGenerationId = previousActiveGenerationId;

    // A retry with the same id must not look like a failure, and it must not
    // redo work that is already on disk. This migration already produced this
    // generation - it says so in the descriptor's `source` and in a receipt - so
    // the only correct action is nothing. The generation may since have been
    // superseded by a later phase, which is not this migration's business.
    //
    // One case is deliberately NOT a no-op: a generation that is still only
    // `staged`. That is what a run that failed after its stage commit (or after
    // its receipt write) leaves behind - real records that no reader can reach -
    // and reporting `migrated` for it would tell a caller reading only `status`
    // that the device is migrated when its data is not. It is discarded and
    // migrated again, so `migrated` always means reachable-or-superseded.
    const existing = await repository.readGeneration(generationId);
    const existingReceipts = existing ? await repository.listMigrationReceipts(generationId) : [];
    const alreadyMigrated =
      existing?.descriptor?.source === 'legacy-migration' &&
      existing.descriptor.status !== 'staged' &&
      existingReceipts.some((receipt) => receipt.migrationId === LEGACY_MIGRATION_ID);
    if (existing !== null && alreadyMigrated) {
      report.stagedGenerationId = generationId;
      report.contentChecksum = existing.descriptor?.contentChecksum ?? null;
      report.recordCounts = toCounts(existing.records);
      report.previousActiveGenerationId = await repository.readActiveGenerationId();
      report.receiptId = existingReceipts[0]?.receiptId ?? null;
      // True only when this generation is the one the pointer names. A
      // superseded generation was completed and later moved past.
      report.activated = existing.descriptor?.status === 'active';
      report.status = 'migrated';
      records = existing.records;
      return { report, stagedGenerationId: generationId, records };
    }

    // Anything unusable at this id is reclaimed before re-staging: a `staged`
    // generation (abandoned, or left behind by an activation that failed), and
    // orphan records that a registry entry no longer describes. Only `staged` and
    // orphans are reclaimed - an `active` or `superseded` generation is
    // legitimate rollback data that must be preserved, and the refusal for one is
    // left to `stageGeneration` below so it is reported as a staging failure.
    if (existing !== null) {
      await repository.discardAbandonedGeneration(generationId);
    }

    enter('stage-records');
    const staged = await repository.stageGeneration({
      generationId,
      source: 'legacy-migration',
      parentGenerationId: previousActiveGenerationId,
      records: built.records,
    });
    report.stagedGenerationId = generationId;
    report.contentChecksum = staged.contentChecksum;
    const stagedRecords = await repository.readRecords(generationId);
    records = stagedRecords.records;
    report.recordCounts = toCounts(stagedRecords.records);

    // ── Step 4: compare record counts, relationships, and checksums ──
    // The stage is entered *before* the forced failure, so a validation failure
    // reports the stage that failed rather than the one that ran before it. The
    // same rule the Phase 3 review applied to a failure inside staging.
    enter('validate');
    if (forceValidationFailure) {
      throw new StorageV2Error('VALIDATION_FAILED', { stage: 'validate', problemCount: 1 });
    }
    const validation = await repository.validateGeneration(generationId);
    if (!validation.ok) {
      report.problems = [
        ...report.problems,
        ...validation.problems,
        ...(validation.checksumMismatches.length > 0
          ? [
              {
                code: 'checksum-mismatch' as const,
                scope: 'checksum' as const,
                count: validation.checksumMismatches.length,
                severity: 'error' as const,
              },
            ]
          : []),
      ];
      throw new StorageV2Error('VALIDATION_FAILED', {
        stage: 'validate',
        problemCount: countBlockingProblems(validation.problems),
      });
    }
    enter('compare');
    if (validation.contentChecksum !== staged.contentChecksum) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { stage: 'compare' });
    }

    // ── Step 5: write a migration receipt ──
    const receipts = await repository.listMigrationReceipts(generationId);
    const receiptId = receipts.length > 0 ? receipts[0].receiptId : `${generationId}-receipt`;
    const receipt: MigrationReceiptValue = {
      receiptId,
      migrationId: LEGACY_MIGRATION_ID,
      fromStorage: 'legacy-localstorage',
      toStorage: 'storage-v2',
      stagedGenerationId: generationId,
      previousActiveGenerationId,
      status: 'activated',
      createdAt: now,
      storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
      subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      subjectSchemaVersions: { ...report.subjectSchemaVersions },
      progressionSourceVersions: { ...report.progressionSourceVersions },
      recordCounts: { ...staged.recordCounts },
      recordChecksums: { ...computeStoreChecksums(stagedRecords.records) },
      contentChecksum: staged.contentChecksum,
    };
    enter('receipt');
    await repository.writeMigrationReceipt(receipt);
    report.receiptId = receiptId;

    // ── Step 6: flip the pointer, retaining the previous generation ──
    enter('activate');
    const activation = await repository.activateGeneration(generationId);
    report.previousActiveGenerationId = activation.previousActiveGenerationId;
    report.activated = true;
    report.status = 'migrated';

    // The receipt is part of the generation, so the report's checksum is the
    // activated generation's final checksum rather than the pre-receipt one.
    // Reading it back also proves the descriptor was refreshed with the receipt.
    const activated = await repository.readGeneration(generationId);
    report.contentChecksum = activated?.descriptor?.contentChecksum ?? report.contentChecksum;
    report.recordCounts = toCounts(activated !== null ? activated.records : stagedRecords.records);

    return { report, stagedGenerationId: generationId, records };
  } catch (error) {
    const stage = currentStage;
    const storageError =
      error instanceof StorageV2Error
        ? error
        : new StorageV2Error('MIGRATION_FAILED', { stage });
    report.status = 'recovery-required';
    report.activated = false;
    // The pointer is only ever flipped after validation succeeds, so a failure
    // here leaves the previous generation active and the legacy state untouched.
    report.recovery = { code: storageError.code, stage };
    return { report, stagedGenerationId: report.stagedGenerationId, records };
  }
}

/**
 * Point `activeGeneration` back at a retained generation.
 *
 * The migration itself never deletes the generation it replaced, so this is the
 * whole rollback path.
 */
export async function rollbackMigration(
  repository: StorageV2Repository,
  generationId: string,
): Promise<{ ok: boolean; error: ReturnType<StorageV2Error['toReport']> | null }> {
  try {
    await repository.rollbackToGeneration(generationId);
    return { ok: true, error: null };
  } catch (error) {
    const storageError =
      error instanceof StorageV2Error
        ? error
        : new StorageV2Error('MIGRATION_FAILED', { stage: 'rollback' });
    return { ok: false, error: storageError.toReport() };
  }
}
