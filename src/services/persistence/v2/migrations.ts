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
 * ## The device-level guard
 *
 * Two guards decide whether a run does anything, and they are not the same
 * question. The first is per generation id: "did *this* migration already produce
 * *this* generation?", which is a no-op success. The second is per device: "has
 * this device already moved off the legacy keys?", which is a no-op reported as
 * `already-migrated`. The second is the load-bearing one, and the order matters -
 * see {@link decideDeviceMigration} for the rule, the six cases it decides, and
 * the trade-off it deliberately makes.
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
  type GenerationStatus,
  type MigrationCounts,
  type MigrationReceiptValue,
  type MigrationReport,
  type PreferenceRecordValue,
  type ProgressionRecordValue,
  type RecoveryRecordValue,
  type SessionRecordValue,
  type ShortcutRecordValue,
  type StorageV2GenerationSource,
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

// ── The device-level guard ────────────────────────────────────────────────

/**
 * One generation, as the guard needs it: three fields, so a test can drive the
 * whole decision table without a database and without inventing a descriptor.
 */
export interface DeviceGenerationRef {
  readonly generationId: string;
  readonly source: StorageV2GenerationSource;
  readonly status: GenerationStatus;
}

/** One `LEGACY_MIGRATION_ID` receipt, as the guard needs it. */
export interface LegacyMigrationReceiptRef {
  readonly receiptId: string;
  /** The generation the receipt was written into. */
  readonly stagedGenerationId: string;
}

/**
 * Everything the registry knows about one device, and nothing else.
 *
 * Deliberately *device*-shaped rather than *generation*-shaped. The guard this
 * feeds used to ask "is this generation id already migrated?", which is the wrong
 * question, and the answer is a cross-phase data-loss defect: a device whose
 * first boot took the `hasNoLearnerContent` short-circuit holds
 * `gen-initial-0001`, so a re-run asked about `gen-migration-0001`, found nothing
 * there, concluded the device had never migrated, and staged a brand-new
 * generation from the stale `localStorage` mirror - superseding the generation
 * every product write lands in. No reader follows a superseded generation, so the
 * write was invisible and unreachable, and the next boot did it again. The
 * comment above that guard already said the rule was "this migration already
 * produced this generation"; this is the rule it meant, stated over the device.
 */
export interface DeviceMigrationEvidence {
  /** Every generation the registry describes, in the repository's own order. */
  readonly generations: readonly DeviceGenerationRef[];
  /** What `activeGeneration` names, or `null` when it names nothing. */
  readonly activeGenerationId: string | null;
  /**
   * Every `LEGACY_MIGRATION_ID` receipt on this device, from **any** generation.
   *
   * Filtered by migration id by the reader, because "this migration ran here" is
   * the only question the receipt can answer: a receipt from some other migration
   * says nothing about whether the legacy keys have been consumed.
   */
  readonly legacyMigrationReceipts: readonly LegacyMigrationReceiptRef[];
}

/**
 * What the migration should do with a device that already has legacy content.
 *
 * Two outcomes, and no third: either re-stage a generation, or do nothing at all.
 */
export type DeviceMigrationDecision =
  | {
      readonly kind: 'migrate';
      /** The device has nothing reachable, so there is nothing to supersede. */
      readonly reason: 'no-reachable-generation';
    }
  | {
      readonly kind: 'skip';
      readonly reason: 'device-already-migrated';
      /** What the pointer named, or `null` when it named nothing. */
      readonly activeGenerationId: string | null;
      /** The `LEGACY_MIGRATION_ID` receipt on a reachable generation, if any. */
      readonly receiptId: string | null;
    };

/**
 * Whether this device has already moved off the legacy `localStorage` keys.
 *
 * ## The one rule
 *
 * **A device that holds a reachable generation has already moved on.** "Reachable"
 * is the registry's own word, not a new one: `staged` is the only status whose
 * records no reader can reach, so `active` and `superseded` both qualify. That is
 * the same reachable-or-superseded rule the `migrated` status is defined against,
 * used for the question it was always meant to answer.
 *
 * The rule reads the **registry**, and that is deliberate. A pointer naming a
 * generation the registry does not describe at all is a corrupt registry, not a
 * migrated device, and the run that finds it migrates: nothing describes what that
 * generation holds, so nothing can be said to have superseded it. The reclaim step
 * refuses to touch whatever the pointer owns, so the run is the safe one.
 *
 * ## Why a reachable generation is enough, and a receipt is not required
 *
 * A reachable generation means storage-v2 is this device's store. Its pointer is
 * authoritative, and the legacy keys are the rollback mirror behind it, not a
 * source of truth. Re-staging a generation from that mirror can only *lose*:
 *
 * - it supersedes the generation the device is using, and every write that landed
 *   only there - a `.kdbak` restore, a `.kdsubject` copy, a `.kdtemplate` import -
 *   becomes unreachable;
 * - it can resurrect a subject the learner deleted by restoring, because a restore
 *   rewrites storage-v2 and not the mirror;
 * - it reports `activated` for a move the learner did not ask for.
 *
 * So the receipt is corroboration, not the test. It is read so the report can name
 * the receipt that proves the device really was migrated by this migration, which
 * is the difference between "already migrated" and "was moved on by something
 * else" - and the first case is the only one a caller can act on by rolling back to
 * the legacy keys.
 *
 * ## The six cases, as a table
 *
 * | the device holds | decision | why |
 * | --- | --- | --- |
 * | nothing at all | `migrate` | A device that used an older build and then upgraded. This is the whole point of the phase. |
 * | only a `staged` generation | `migrate` | A run that failed after its stage commit. Its records are unreachable, so `migrated` for it would be the dishonesty the status is defined to prevent. The caller discards and re-stages it. |
 * | a `legacy-migration` generation with a `LEGACY_MIGRATION_ID` receipt, plus the pointer on it | `skip` | Already migrated, by this migration. |
 * | a `legacy-migration` generation with a receipt, since superseded by a later generation | `skip` | Already migrated; a later phase legitimately moved the pointer on. |
 * | an `initial` generation, no receipt (the `hasNoLearnerContent` short-circuit) | `skip` | **The defect.** The device moved on by deciding there was nothing to move, and anything written into it since is real. |
 * | a generation a product created (`.kdbak`, `.kdsubject`, `.kdtemplate`) | `skip` | Same, one step further along: those writes reach storage-v2 only. |
 *
 * ## What is given up, deliberately
 *
 * Once a device holds a reachable generation, the legacy mirror is no longer
 * migrated from. A learner who rolls back to a `legacy` build, creates a subject
 * there, and returns to this build keeps that subject in the mirror - which is
 * exactly where a rollback build would find it - and storage-v2 will not import it.
 * Re-reading the mirror on every boot to catch that case is the defect, not a fix
 * for it: the mirror is a mirror, it is a *stale* mirror by construction, and
 * merging it into a live generation is a different feature from guarding a
 * migration. The alternative - re-migrate whenever the mirror names anything the
 * active generation lacks - is what destroys the three data products.
 */
export function decideDeviceMigration(evidence: DeviceMigrationEvidence): DeviceMigrationDecision {
  const reachable = evidence.generations.filter((generation) => generation.status !== 'staged');
  if (reachable.length === 0) {
    return { kind: 'migrate', reason: 'no-reachable-generation' };
  }
  const reachableIds = new Set(reachable.map((generation) => generation.generationId));
  // Only a receipt on a *reachable* generation counts. A receipt left on a
  // `staged` generation is the fingerprint of a run that failed, and reading it as
  // proof of a migration is precisely the dishonesty the staged rule exists to
  // prevent.
  const onReachable = evidence.legacyMigrationReceipts.filter((receipt) =>
    reachableIds.has(receipt.stagedGenerationId),
  );
  // The pointer's own generation is the one worth naming, because that is the
  // generation a caller would have to roll back *from*. When the pointer names
  // something unreachable - which a self-consistent registry cannot produce - the
  // report says `null` rather than naming a generation the pointer does not name.
  const active = evidence.activeGenerationId !== null && reachableIds.has(evidence.activeGenerationId);
  return {
    kind: 'skip',
    reason: 'device-already-migrated',
    activeGenerationId: active ? evidence.activeGenerationId : null,
    receiptId: onReachable.length > 0 ? (onReachable[0] as LegacyMigrationReceiptRef).receiptId : null,
  };
}

/**
 * Read the three registry facts {@link decideDeviceMigration} needs, in one pass.
 *
 * `listMigrationReceipts()` with no argument reads every receipt on the device
 * rather than one generation's, which is the whole point: the question is whether
 * *this device* was migrated, and a generation-scoped read can only answer it for
 * the generation it was asked about.
 */
async function readDeviceMigrationEvidence(
  repository: StorageV2Repository,
): Promise<DeviceMigrationEvidence> {
  const [generations, activeGenerationId, receipts] = await Promise.all([
    repository.listGenerations(),
    repository.readActiveGenerationId(),
    repository.listMigrationReceipts(),
  ]);
  return {
    generations: generations.map((descriptor) => ({
      generationId: descriptor.generationId,
      source: descriptor.source,
      status: descriptor.status,
    })),
    activeGenerationId,
    legacyMigrationReceipts: receipts
      .filter((receipt) => receipt.migrationId === LEGACY_MIGRATION_ID)
      .map((receipt) => ({
        receiptId: receipt.receiptId,
        stagedGenerationId: receipt.stagedGenerationId,
      })),
  };
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
    //
    // This guard is per *generation id*, and it is the **second** line of defence
    // rather than the first. A device can be migrated without this id existing on
    // it at all - the `hasNoLearnerContent` short-circuit above hands a fresh
    // device `gen-initial-0001` and never writes `gen-migration-0001` - so asking
    // only about `generationId` cannot answer "has this device moved on?". The
    // device-level guard below answers that, and it is the one that has to be
    // right.
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

    // ── The device-level guard: has this *device* already moved on? ──
    //
    // Reached whenever the guard above did not: a different generation id, or no
    // generation under this one. Before the device-level rule existed, that
    // answered "never migrated" on every boot of a device that had been
    // initialised, and the run below staged a fresh generation from the stale
    // `localStorage` mirror and flipped the pointer onto it. The generation the
    // device was actually using became `superseded`, and every write that reached
    // only that generation - a `.kdbak` restore, a `.kdsubject` copy import, a
    // `.kdtemplate` import - became invisible and unreachable, with a subject the
    // learner deleted by restoring coming back from the mirror on the next boot.
    // Two accepted phases missed it because every unit gate read the active
    // generation directly, which is the very generation that was superseded.
    const deviceDecision = decideDeviceMigration(await readDeviceMigrationEvidence(repository));
    if (deviceDecision.kind === 'skip') {
      // This run stages nothing, so it reports nothing as staged and nothing as
      // moved. `recordCounts` and `contentChecksum` stay at their empty
      // initialisers for the same reason `no-source-data` leaves them empty: they
      // count what a run wrote, and this run wrote nothing.
      //
      // Nothing is reclaimed on this path either, and that is deliberate. A
      // `staged` generation is unreachable by definition, so leaving one is not
      // data loss, and a decision whose entire content is "do not touch this
      // device" must not end in a delete.
      report.status = 'already-migrated';
      report.stagedGenerationId = null;
      report.previousActiveGenerationId = deviceDecision.activeGenerationId;
      report.activated = false;
      report.receiptId = deviceDecision.receiptId;
      return { report, stagedGenerationId: null, records: null };
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
