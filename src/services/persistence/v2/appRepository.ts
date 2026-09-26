/**
 * Application-level writes against the active storage-v2 generation.
 *
 * The repository is a transaction API over records; this module is the app's
 * vocabulary for it. Every function here takes an explicit repository rather than
 * reaching for a module-level handle, so the routing decision stays in one place
 * (`repositorySelection.ts`) and a test can drive any of them against a temporary
 * database.
 *
 * Two invariants hold for all of it:
 *
 * 1. **Never open storage-v2 when it is not selected.** The functions require a
 *    repository, so the only way to reach them is for a caller to have one, and
 *    the default `legacy` build never has one.
 * 2. **Never block a synchronous caller.** `publish*` writes are asynchronous and
 *    the stores' actions are synchronous, so the stores fire them through
 *    {@link fireAndForget}, which records a sanitized failure instead of dropping
 *    it on the floor.
 *
 * Renderer-neutral: no renderer import, no network, no clock read except the
 * caller-supplied `now`.
 */

import {
  CANONICAL_PROGRESSION_VERSION,
  normalizeProgressionRecord,
} from '@/core/progression/canonicalProgression';
import type { SubjectSnapshot } from '@/core/validation/persistence';

import { ensureInitialGeneration, INITIAL_GENERATION_ID } from './appState';
import type { StorageV2Repository } from './repository';
import type {
  PreferenceRecordValue,
  ProgressionRecordValue,
  SessionRecordValue,
  ShortcutRecordValue,
  SubjectRecordValue,
} from './schema';
import { CANONICAL_SUBJECT_SCHEMA_VERSION } from './schema';
import type { PersistedSessionRecord, PersistedShortcutBinding } from './appState';

/** Mints a loot/gear id the same way the progression store does. */
function randomPersistedId(prefix: 'loot' | 'gear'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The active generation, creating the initial one when the device has none.
 *
 * A device that has never been migrated and never been written has no generation
 * to write into, so the first write creates one. That is a real, visible
 * generation in the registry, not a hidden one.
 */
export async function activeGenerationForWrite(
  repository: StorageV2Repository,
  now: string,
): Promise<string> {
  return ensureInitialGeneration(repository, { generationId: INITIAL_GENERATION_ID, now });
}

/** Subject ids in the active generation, in record-id order. */
export async function readSubjectIdsFromActiveGeneration(
  repository: StorageV2Repository,
): Promise<string[]> {
  const active = await repository.readActiveGenerationId();
  if (active === null) return [];
  const records = (await repository.readRecords(active)).records.subjects;
  return records
    .map((envelope) => envelope.recordId)
    .sort((left, right) => (left < right ? -1 : 1));
}

/** One subject snapshot from the active generation, or `null` when absent. */
export async function readSubjectFromActiveGeneration(
  repository: StorageV2Repository,
  subjectId: string,
): Promise<SubjectSnapshot | null> {
  const active = await repository.readActiveGenerationId();
  if (active === null) return null;
  const records = (await repository.readRecords(active)).records.subjects;
  const envelope = records.find((entry) => entry.recordId === subjectId);
  if (envelope === undefined) return null;
  return (envelope.value as SubjectRecordValue).snapshot;
}

/** Write one subject snapshot into the active generation. */
export async function writeSubjectToActiveGeneration(
  repository: StorageV2Repository,
  subjectId: string,
  snapshot: SubjectSnapshot,
  now: string,
): Promise<void> {
  const generationId = await activeGenerationForWrite(repository, now);
  const record: SubjectRecordValue = {
    subjectId,
    // The record always declares the canonical subject schema, which is what
    // `validateSubjectRecord` checks. A `1.0.0` snapshot reaching this point is
    // migrated on the way in by `importSubjectFromJson`, exactly as before.
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot,
    createdAt: snapshot.dungeon.createdAt || now,
    updatedAt: snapshot.dungeon.updatedAt || now,
  };
  await repository.putRecords(generationId, { subjects: [record] });
}

/** Remove one subject, its progression, and its attachment metadata. */
export async function deleteSubjectFromActiveGeneration(
  repository: StorageV2Repository,
  subjectId: string,
): Promise<void> {
  const active = await repository.readActiveGenerationId();
  if (active === null) return;
  const records = (await repository.readRecords(active)).records;
  const attachmentIds = records.attachmentMetadata
    .filter((envelope) => (envelope.value as { subjectId?: string }).subjectId === subjectId)
    .map((envelope) => envelope.recordId.replace(/^meta:/, ''));
  await repository.deleteRecords(active, {
    subjects: [subjectId],
    progression: [subjectId],
    ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
  });
}

/**
 * Publish the progression envelope, one canonical record per subject.
 *
 * The envelope is normalized through the same function the migration and the
 * store use, so the persisted records are the one canonical representation rather
 * than a second dialect of the same data.
 *
 * **The version is stamped here, not trusted from the caller.** The parameter is
 * `unknown`, which is the point: this is the only place that can guarantee the
 * payload is read as the shape it is. `normalizeProgressionRecord` decides between
 * "a map of per-subject records" and "one flat record" by reading
 * `envelope.version`, so an unversioned `{ bySubject, crossSubjectAchievements }`
 * is filed as ONE zeroed record under the legacy bucket, with the real per-subject
 * values buried in that record's `extraFields` where no reader looks. Because
 * `putRecords` merges, that stray record then survives every later write and every
 * reload hydrates a phantom subject - and the learner's real progression is never
 * durable in the authoritative store.
 *
 * So this function is canonicalising: it stamps the current version itself rather
 * than requiring every caller to remember. A future caller cannot get this wrong.
 * A genuinely flat payload (no `bySubject`) still normalizes through the v1 path,
 * because the version is only ever *added*, so stamping cannot promote a flat
 * record into a by-subject one.
 *
 * On `sourceVersion`: it is provenance - the shape this function *read* - so after
 * stamping it is always {@link CANONICAL_PROGRESSION_VERSION}, including for a
 * record that originally arrived as a v1 flat key. That is the correct value and
 * nothing is lost: the original shape is recorded once, by the migration, in
 * `report.progressionSourceVersions`. Proving that a v1 payload arrived as v1 is
 * the migration's job; proving that what was just persisted is current-shaped is
 * this function's.
 */
export async function publishProgressionToActiveGeneration(
  repository: StorageV2Repository,
  envelope: unknown,
  now: string,
): Promise<void> {
  const generationId = await activeGenerationForWrite(repository, now);
  const canonical = normalizeProgressionRecord(
    { ...(isRecord(envelope) ? envelope : {}), version: CANONICAL_PROGRESSION_VERSION },
    { createId: randomPersistedId },
  );
  const progression: ProgressionRecordValue[] = Object.entries(canonical.bySubject)
    .map(([subjectId, subject]) => ({
      subjectId,
      sourceVersion: canonical.sourceVersion,
      rank: subject.rank,
      xpTotal: subject.xpTotal,
      bySubject: { [subjectId]: { ...subject } },
      crossSubjectAchievements: [...canonical.crossSubjectAchievements],
    }))
    .sort((left, right) => (left.subjectId < right.subjectId ? -1 : 1));
  await repository.putRecords(generationId, { progression });
}

/** Publish the preferences payload under the `graphics` preference id. */
export async function publishPreferencesToActiveGeneration(
  repository: StorageV2Repository,
  value: unknown,
  now: string,
): Promise<void> {
  const generationId = await activeGenerationForWrite(repository, now);
  const record: PreferenceRecordValue = { preferenceId: 'graphics', value, updatedAt: now };
  await repository.putRecords(generationId, { preferences: [record] });
}

/** Publish every shortcut binding. */
export async function publishShortcutsToActiveGeneration(
  repository: StorageV2Repository,
  bindings: readonly PersistedShortcutBinding[],
  now: string,
): Promise<void> {
  const generationId = await activeGenerationForWrite(repository, now);
  const shortcuts: ShortcutRecordValue[] = bindings.map((binding) => ({
    actionId: binding.labelKey,
    labelKey: binding.labelKey,
    key: binding.key,
    ctrlKey: binding.ctrlKey,
    shiftKey: binding.shiftKey,
  }));
  await repository.putRecords(generationId, { shortcuts });
}

/** Publish one finished study session. */
export async function publishSessionToActiveGeneration(
  repository: StorageV2Repository,
  session: PersistedSessionRecord,
  now: string,
): Promise<void> {
  const generationId = await activeGenerationForWrite(repository, now);
  const record: SessionRecordValue = {
    sessionId: session.sessionId,
    subjectId: session.subjectId,
    // Preserved so a session still hydrates its name if the subject record goes
    // away; a live subject's current name always wins on read.
    subjectName: session.subjectName,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    roomsVisited: [...session.roomsVisited],
    notesSubmitted: session.notesSubmitted,
    reviewsCompleted: session.reviewsCompleted,
    xpEarned: session.xpEarned,
    // Derived from the session's own identity and start time, so re-publishing
    // the same session is the same record and a replay is a no-op.
    eventId: `${session.sessionId}:${session.startedAt}`,
  };
  await repository.putRecords(generationId, { sessions: [record] });
}
