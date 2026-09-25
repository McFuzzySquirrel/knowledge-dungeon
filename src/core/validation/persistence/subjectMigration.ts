/**
 * The one subject-schema migration: `1.0.0` to `1.1.0`.
 *
 * The current importer has its own private copy of this transform. Storage-v2
 * needs the same transform with different unknown-field handling, so both paths
 * call this module and the only difference is the explicit
 * {@link SubjectMigrationOptions.unknownTopLevelFields} policy:
 *
 * - `'drop'` reproduces the current importer exactly. It rebuilds the top-level
 *   object as `{ dungeon, rooms }`, so a legacy top-level envelope is dropped.
 *   The Phase 0 characterization test pins this
 *   (`expect(imported).not.toHaveProperty('legacyEnvelope')`).
 * - `'preserve'` keeps every other top-level key. Plan section 7.3 requires
 *   unknown app-owned fields to survive migration, so this is the storage-v2
 *   policy.
 *
 * Dungeon-level and room-level unknown fields are preserved under both policies,
 * matching current behavior.
 *
 * The function is pure and renderer-neutral: it never reads the clock, storage,
 * or a renderer. `nowIso` is injected, which is what makes the migration
 * deterministic and fixture-testable.
 */

import { CURRENT_SCHEMA_VERSION, type RoomMetadata, type SubjectSnapshot } from './types';
import {
  compareSchemaVersions,
  isSchemaVersionAtLeast,
  LEGACY_SUBJECT_SCHEMA_VERSION,
} from './subjectValidation';

/** SM-2 default applied to a `1.0.0` room that has no quality response yet. */
export const DEFAULT_SM2_QUALITY_RESPONSE = 3;
/** SM-2 default ease factor. */
export const DEFAULT_SM2_EASE_FACTOR = 2.5;
/** SM-2 default interval in days. */
export const DEFAULT_SM2_INTERVAL_DAYS = 1;
/** SM-2 default consecutive-correct counter. */
export const DEFAULT_SM2_CONSECUTIVE_CORRECT = 0;

/**
 * How unknown top-level fields are treated.
 *
 * `'drop'` is the current importer's behavior. `'preserve'` is the storage-v2
 * requirement.
 */
export type UnknownTopLevelFieldPolicy = 'drop' | 'preserve';

export interface SubjectMigrationOptions {
  /** Injected ISO-8601 clock. Required: the migration never reads the real clock. */
  nowIso: string;
  /** Unknown top-level field policy. Defaults to `'preserve'`. */
  unknownTopLevelFields?: UnknownTopLevelFieldPolicy;
  /** Target schema version. Defaults to the current `1.1.0`. */
  targetSchemaVersion?: string;
}

export interface SubjectMigrationResult {
  /** The migrated snapshot. */
  snapshot: SubjectSnapshot;
  /** Detected source version, or `null` when absent. */
  sourceSchemaVersion: string | null;
  /** Version the snapshot now carries. */
  targetSchemaVersion: string;
  /** False when the input was already at (or above) the target version. */
  migrated: boolean;
  /** Number of rooms that received a default the input did not have. */
  appliedRoomDefaults: number;
  /** The policy that was applied, so a report can record it. */
  unknownTopLevelFields: UnknownTopLevelFieldPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readSchemaVersion(input: unknown): string | null {
  if (!isRecord(input) || !isRecord(input.dungeon)) return null;
  const version = input.dungeon.schemaVersion;
  return typeof version === 'string' ? version : null;
}

/** True when the payload still needs the `1.0.0` transform. */
export function needsSubjectSchemaMigration(
  input: unknown,
  targetSchemaVersion: string = CURRENT_SCHEMA_VERSION,
): boolean {
  const source = readSchemaVersion(input);
  if (source === null) return false;
  return !isSchemaVersionAtLeast(source, targetSchemaVersion);
}

/**
 * Migrate a subject snapshot to the target schema version.
 *
 * Idempotent by construction: the transform only fills in absent SM-2 defaults,
 * only supplies `tagIndex` when it is missing, and only rewrites
 * `schemaVersion`. Running it on its own output is a deep-equal no-op, which
 * the migration tests assert directly.
 */
export function migrateSubjectSnapshot(
  input: unknown,
  options: SubjectMigrationOptions,
): SubjectMigrationResult {
  const targetSchemaVersion = options.targetSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  const policy: UnknownTopLevelFieldPolicy = options.unknownTopLevelFields ?? 'preserve';
  const sourceSchemaVersion = readSchemaVersion(input);
  const nowIso = options.nowIso;

  if (!isRecord(input) || !isRecord(input.dungeon) || !isRecord(input.rooms)) {
    // Nothing to migrate. Returning the input keeps the function total; callers
    // validate before they migrate.
    return {
      snapshot: input as SubjectSnapshot,
      sourceSchemaVersion,
      targetSchemaVersion,
      migrated: false,
      appliedRoomDefaults: 0,
      unknownTopLevelFields: policy,
    };
  }

  if (
    sourceSchemaVersion === null ||
    compareSchemaVersions(sourceSchemaVersion, targetSchemaVersion) >= 0
  ) {
    return {
      snapshot: input as unknown as SubjectSnapshot,
      sourceSchemaVersion,
      targetSchemaVersion,
      migrated: false,
      appliedRoomDefaults: 0,
      unknownTopLevelFields: policy,
    };
  }

  let appliedRoomDefaults = 0;
  const migratedRooms: Record<string, RoomMetadata> = {};
  for (const [roomId, room] of Object.entries(input.rooms)) {
    if (!isRecord(room)) {
      migratedRooms[roomId] = room as unknown as RoomMetadata;
      continue;
    }
    const needsNextReview = room.sm2NextReviewDate === undefined || room.sm2NextReviewDate === null;
    if (
      needsNextReview ||
      room.sm2QualityResponse === undefined ||
      room.sm2EaseFactor === undefined ||
      room.sm2IntervalDays === undefined ||
      room.sm2ConsecutiveCorrect === undefined ||
      room.tags === undefined
    ) {
      appliedRoomDefaults += 1;
    }
    // Spread first, then the six migration keys, exactly as the current
    // importer orders them so the legacy path stays byte-identical.
    migratedRooms[roomId] = {
      ...room,
      sm2QualityResponse: (room.sm2QualityResponse as number | undefined) ?? DEFAULT_SM2_QUALITY_RESPONSE,
      sm2EaseFactor: (room.sm2EaseFactor as number | undefined) ?? DEFAULT_SM2_EASE_FACTOR,
      sm2IntervalDays: (room.sm2IntervalDays as number | undefined) ?? DEFAULT_SM2_INTERVAL_DAYS,
      sm2NextReviewDate: (room.sm2NextReviewDate as string | undefined) ?? nowIso,
      sm2ConsecutiveCorrect:
        (room.sm2ConsecutiveCorrect as number | undefined) ?? DEFAULT_SM2_CONSECUTIVE_CORRECT,
      tags: (room.tags as string[] | undefined) ?? [],
    } as unknown as RoomMetadata;
  }

  // `biome` is written explicitly (even when absent) because the current
  // importer does, and a test pins the resulting own-property.
  const migratedDungeon = {
    ...input.dungeon,
    schemaVersion: targetSchemaVersion,
    biome: input.dungeon.biome,
    tagIndex: (input.dungeon.tagIndex as Record<string, string[]> | undefined) ?? {},
  };

  const topLevel = policy === 'preserve' ? { ...input } : {};
  const snapshot = {
    ...topLevel,
    dungeon: migratedDungeon,
    rooms: migratedRooms,
  } as unknown as SubjectSnapshot;

  return {
    snapshot,
    sourceSchemaVersion,
    targetSchemaVersion,
    migrated: true,
    appliedRoomDefaults,
    unknownTopLevelFields: policy,
  };
}

/** The version a `1.0.0` payload is known by, re-exported for migration reports. */
export { LEGACY_SUBJECT_SCHEMA_VERSION };
