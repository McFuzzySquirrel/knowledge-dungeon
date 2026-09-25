/**
 * Pure subject-snapshot validation.
 *
 * Extracted from the UI-facing persistence facade so the storage-v2 migration
 * and the current importer validate with exactly one rule set. This module is
 * renderer-neutral and side-effect free: it never reads `localStorage`,
 * `IndexedDB`, the clock, or any renderer state.
 *
 * Two entry points on purpose:
 * - {@link assertImportableSubjectSnapshot} reproduces the current importer's
 *   error messages verbatim. The Phase 0 characterization tests pin those
 *   strings, so the legacy boundary must keep them.
 * - {@link validateSubjectSnapshot} returns structured, sanitized problems for
 *   the migration report: problem codes and counts only, never a record's
 *   contents, a note, a topic, or a filename.
 */

import {
  CURRENT_SCHEMA_VERSION,
  EDGE_RELATION_TYPES,
  PHASE_STATES,
  ROOM_STATES,
  type SubjectSnapshot,
} from './types';

/** The previous subject schema version this application can migrate from. */
export const LEGACY_SUBJECT_SCHEMA_VERSION = '1.0.0';

/** Every subject schema version the importer and migration accept. */
export const SUPPORTED_SUBJECT_SCHEMA_VERSIONS: readonly string[] = [
  LEGACY_SUBJECT_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
];

/** Which part of a snapshot a problem was found in. Never a record identity. */
export type SubjectValidationScope =
  | 'document'
  | 'dungeon'
  | 'dungeon-rooms'
  | 'dungeon-edges'
  | 'dungeon-progression'
  | 'room'
  | 'room-validation-state'
  | 'room-attachments'
  | 'version';

/** Sanitized problem codes. No value, text, or identifier is ever reported. */
export type SubjectValidationCode =
  | 'not-an-object'
  | 'missing-dungeon'
  | 'missing-rooms'
  | 'missing-schema-version'
  | 'unsupported-schema-version'
  | 'missing-dungeon-id'
  | 'missing-subject-name'
  | 'missing-root-room-id'
  | 'missing-phase-state'
  | 'unknown-phase-state'
  | 'malformed-room-summaries'
  | 'malformed-room-summary-entry'
  | 'missing-room-payload'
  | 'room-id-mismatch'
  | 'malformed-room-payload'
  | 'malformed-validation-state'
  | 'malformed-room-state'
  | 'malformed-edges'
  | 'malformed-edge-endpoint'
  | 'malformed-progression'
  | 'malformed-attachments'
  | 'malformed-attachment-entry';

export interface SubjectValidationProblem {
  code: SubjectValidationCode;
  scope: SubjectValidationScope;
  /** How many occurrences of this problem were found. */
  count: number;
}

export interface SubjectValidationResult {
  ok: boolean;
  /** Sorted by scope then code so two runs over the same input compare equal. */
  problems: SubjectValidationProblem[];
  /** The detected schema version, or `null` when it is absent/unreadable. */
  schemaVersion: string | null;
}

export interface SubjectValidationOptions {
  /** Additional versions accepted as importable. Defaults to the supported set. */
  supportedVersions?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

/**
 * Compare two dotted numeric versions. Returns a negative number when `a` is
 * older, `0` when equal, a positive number when `a` is newer. A non-numeric
 * segment compares lexically so an unexpected version still orders stably.
 */
export function compareSchemaVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index] ?? '0';
    const rightSegment = right[index] ?? '0';
    const leftNumber = Number.parseInt(leftSegment, 10);
    const rightNumber = Number.parseInt(rightSegment, 10);
    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      if (leftSegment === rightSegment) continue;
      return leftSegment < rightSegment ? -1 : 1;
    }
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  }
  return 0;
}

/** True when `version` is at least `target`. */
export function isSchemaVersionAtLeast(version: string, target: string): boolean {
  return compareSchemaVersions(version, target) >= 0;
}

/** True when the version is one the importer/migration supports. */
export function isSupportedSubjectSchemaVersion(
  version: unknown,
  options: SubjectValidationOptions = {},
): version is string {
  const supported = options.supportedVersions ?? SUPPORTED_SUBJECT_SCHEMA_VERSIONS;
  return typeof version === 'string' && supported.includes(version);
}

function collectProblem(
  accumulator: Map<string, SubjectValidationProblem>,
  code: SubjectValidationCode,
  scope: SubjectValidationScope,
): void {
  const key = `${scope}|${code}`;
  const existing = accumulator.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  accumulator.set(key, { code, scope, count: 1 });
}

function finalizeProblems(accumulator: Map<string, SubjectValidationProblem>): SubjectValidationProblem[] {
  return [...accumulator.values()].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    return a.code < b.code ? -1 : 1;
  });
}

function readSchemaVersion(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (!isRecord(raw.dungeon)) return null;
  const version = raw.dungeon.schemaVersion;
  return typeof version === 'string' ? version : null;
}

/**
 * Validate a subject payload without throwing.
 *
 * This is the validation the migration uses before it stages anything. It
 * reports codes and counts only: a problem never carries the offending value,
 * a room topic, a note, or an identifier.
 */
export function validateSubjectSnapshot(
  raw: unknown,
  options: SubjectValidationOptions = {},
): SubjectValidationResult {
  const problems = new Map<string, SubjectValidationProblem>();
  const schemaVersion = readSchemaVersion(raw);

  if (!isRecord(raw)) {
    collectProblem(problems, 'not-an-object', 'document');
    return { ok: false, problems: finalizeProblems(problems), schemaVersion: null };
  }
  if (!isRecord(raw.dungeon)) {
    collectProblem(problems, 'missing-dungeon', 'document');
  }
  if (!isRecord(raw.rooms)) {
    collectProblem(problems, 'missing-rooms', 'document');
  }
  if (schemaVersion === null) {
    collectProblem(problems, 'missing-schema-version', 'version');
  } else if (!isSupportedSubjectSchemaVersion(schemaVersion, options)) {
    collectProblem(problems, 'unsupported-schema-version', 'version');
  }

  if (isRecord(raw.dungeon)) {
    validateDungeon(raw.dungeon, problems);
  }
  if (isRecord(raw.rooms)) {
    validateRooms(raw.dungeon, raw.rooms, problems);
  }

  return {
    ok: problems.size === 0,
    problems: finalizeProblems(problems),
    schemaVersion,
  };
}

function validateDungeon(dungeon: Record<string, unknown>, problems: Map<string, SubjectValidationProblem>): void {
  if (typeof dungeon.dungeonId !== 'string' || dungeon.dungeonId.length === 0) {
    collectProblem(problems, 'missing-dungeon-id', 'dungeon');
  }
  if (typeof dungeon.subjectName !== 'string' || dungeon.subjectName.length === 0) {
    collectProblem(problems, 'missing-subject-name', 'dungeon');
  }
  if (typeof dungeon.rootRoomId !== 'string' || dungeon.rootRoomId.length === 0) {
    collectProblem(problems, 'missing-root-room-id', 'dungeon');
  }
  if (typeof dungeon.phaseState !== 'string') {
    collectProblem(problems, 'missing-phase-state', 'dungeon');
  } else if (!isOneOf(dungeon.phaseState, PHASE_STATES)) {
    collectProblem(problems, 'unknown-phase-state', 'dungeon');
  }

  if (!Array.isArray(dungeon.rooms)) {
    collectProblem(problems, 'malformed-room-summaries', 'dungeon-rooms');
  } else {
    for (const summary of dungeon.rooms) {
      if (!isRecord(summary) || typeof summary.roomId !== 'string') {
        collectProblem(problems, 'malformed-room-summary-entry', 'dungeon-rooms');
      }
    }
  }

  if (dungeon.edges !== undefined) {
    if (!Array.isArray(dungeon.edges)) {
      collectProblem(problems, 'malformed-edges', 'dungeon-edges');
    } else {
      for (const edge of dungeon.edges) {
        if (!isRecord(edge) || typeof edge.fromRoomId !== 'string' || typeof edge.toRoomId !== 'string') {
          collectProblem(problems, 'malformed-edge-endpoint', 'dungeon-edges');
        } else if (
          edge.relationType !== undefined &&
          !isOneOf(edge.relationType, EDGE_RELATION_TYPES)
        ) {
          collectProblem(problems, 'malformed-edge-endpoint', 'dungeon-edges');
        }
      }
    }
  }

  if (dungeon.progression !== undefined && !isRecord(dungeon.progression)) {
    collectProblem(problems, 'malformed-progression', 'dungeon-progression');
  }
}

function validateRooms(
  dungeon: unknown,
  rooms: Record<string, unknown>,
  problems: Map<string, SubjectValidationProblem>,
): void {
  const summaries = isRecord(dungeon) && Array.isArray(dungeon.rooms) ? dungeon.rooms : null;
  const summaryIds = new Set<string>();

  if (summaries) {
    for (const summary of summaries) {
      if (!isRecord(summary) || typeof summary.roomId !== 'string') continue;
      summaryIds.add(summary.roomId);
      const room = rooms[summary.roomId];
      if (!isRecord(room)) {
        collectProblem(problems, 'missing-room-payload', 'room');
        continue;
      }
      if (room.roomId !== summary.roomId) {
        collectProblem(problems, 'room-id-mismatch', 'room');
      }
    }
  }

  for (const [roomKey, room] of Object.entries(rooms)) {
    if (!isRecord(room)) {
      collectProblem(problems, 'malformed-room-payload', 'room');
      continue;
    }
    if (room.roomId !== roomKey) {
      collectProblem(problems, 'room-id-mismatch', 'room');
    }
    if (typeof room.state === 'string' && !isOneOf(room.state, ROOM_STATES)) {
      collectProblem(problems, 'malformed-room-state', 'room');
    }
    if (!isRecord(room.validationState)) {
      collectProblem(problems, 'malformed-validation-state', 'room-validation-state');
    }
    if (room.attachments !== undefined) {
      if (!Array.isArray(room.attachments)) {
        collectProblem(problems, 'malformed-attachments', 'room-attachments');
      } else {
        for (const attachment of room.attachments) {
          if (
            !isRecord(attachment) ||
            typeof attachment.attachmentId !== 'string' ||
            typeof attachment.sourceType !== 'string'
          ) {
            collectProblem(problems, 'malformed-attachment-entry', 'room-attachments');
          }
        }
      }
    }
  }
}

/**
 * Non-throwing form of {@link assertImportableSubjectSnapshot}.
 *
 * Used by the migration, which must skip a payload the current importer would
 * reject but must not skip a payload the importer accepts. Keeping the two in
 * step is the point: the migration may never drop a subject the learner can open
 * in the current build.
 */
export function isImportableSubjectSnapshot(
  raw: unknown,
  options: SubjectValidationOptions = {},
): boolean {
  try {
    assertImportableSubjectSnapshot(raw, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reproduce the current importer's rejection rules and messages exactly.
 *
 * The Phase 0 characterization tests pin these strings, so the legacy import
 * boundary must keep throwing them verbatim. The storage-v2 migration uses
 * {@link validateSubjectSnapshot} instead, because it reports codes and counts
 * rather than throwing.
 */
export function assertImportableSubjectSnapshot(
  raw: unknown,
  options: SubjectValidationOptions = {},
): SubjectSnapshot {
  if (!isRecord(raw) || !('dungeon' in raw) || !('rooms' in raw)) {
    throw new Error('Invalid subject snapshot format');
  }
  const dungeon = raw.dungeon;
  const rooms = raw.rooms;
  if (!isRecord(dungeon) || !isRecord(rooms)) {
    throw new Error('Invalid subject snapshot format');
  }
  if (typeof dungeon.schemaVersion !== 'string') {
    throw new Error('Invalid subject snapshot format: missing schema version.');
  }

  const supportedVersions = options.supportedVersions ?? SUPPORTED_SUBJECT_SCHEMA_VERSIONS;
  if (!supportedVersions.includes(dungeon.schemaVersion)) {
    throw new Error(
      `Unsupported subject schema version: ${dungeon.schemaVersion}. Expected ${CURRENT_SCHEMA_VERSION} or earlier.`,
    );
  }
  if (
    typeof dungeon.dungeonId !== 'string' ||
    typeof dungeon.subjectName !== 'string' ||
    !Array.isArray(dungeon.rooms)
  ) {
    throw new Error('Invalid subject snapshot format');
  }

  for (const roomSummary of dungeon.rooms) {
    if (!isRecord(roomSummary) || typeof roomSummary.roomId !== 'string') {
      throw new Error('Invalid subject snapshot format: room summary is malformed.');
    }
    const room = rooms[roomSummary.roomId];
    if (!isRecord(room) || room.roomId !== roomSummary.roomId || !isRecord(room.validationState)) {
      throw new Error(`Invalid subject snapshot format: missing room payload for "${roomSummary.roomId}".`);
    }
  }

  return raw as unknown as SubjectSnapshot;
}
