/**
 * A byte-for-byte fingerprint of everything a failed import must not change.
 *
 * Phase 5's most important exit criterion is "Corrupt archives never replace
 * current data", and the plan's non-goal is "No deletion of existing user data
 * during import failure". A claim like that is only worth anything if the
 * comparison it rests on can actually fail, so this module is built to be
 * falsified:
 *
 * - {@link captureDeviceState} reads *every* generation, *every* record
 *   envelope - including the envelope's own `recordId`, `checksum`, and
 *   `updatedAt` - the active-generation pointer, every descriptor, and the whole
 *   ordered legacy `localStorage` key set with its values.
 * - {@link fingerprintOf} reduces that to one digest, so "unchanged" is a
 *   byte-for-byte statement rather than a field-by-field paraphrase.
 * - {@link diffDeviceStates} names exactly what moved, so a failure says *which*
 *   record and *which* field rather than just "different".
 * - {@link mutateActiveSubject} deliberately changes one stored value. The
 *   corruption suite runs it as a **positive control**: if a single edited field
 *   did not change the fingerprint and produce a diff, then the fifteen
 *   "unchanged" assertions would be unfalsifiable and the gate would be
 *   decorative.
 *
 * Nothing here writes learner data anywhere, and the diff strings carry store
 * names, record ids, and field names only - never a value.
 */

import { canonicalJsonStringify, checksumValue } from '@/services/persistence/v2/checksum';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { StorageRecordEnvelope } from '@/services/persistence/v2/schema';
import { platformSha256, utf8 } from './hashes';

/** One stored record, flattened for comparison. */
export interface FlatRecord {
  readonly store: string;
  readonly recordId: string;
  readonly generationId: string;
  readonly checksum: string | null;
  readonly updatedAt: string;
  /** Canonical JSON of the value: key order and whitespace independent. */
  readonly canonicalValue: string;
}

/** One generation descriptor, flattened. */
export interface FlatDescriptor {
  readonly generationId: string;
  readonly status: string;
  readonly source: string;
  readonly generationFormatVersion: number;
  readonly subjectSchemaVersion: string;
  readonly contentChecksum: string;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly canonicalValue: string;
}

/** Everything a failed import must leave alone. */
export interface DeviceState {
  readonly activeGenerationId: string | null;
  readonly generationIds: readonly string[];
  readonly descriptors: readonly FlatDescriptor[];
  readonly records: readonly FlatRecord[];
  /** Ordered `[key, value]` pairs: the legacy key set, byte for byte. */
  readonly legacyEntries: readonly (readonly [string, string])[];
  /** Per-store record counts, asserted rather than derived from the arrays. */
  readonly recordCounts: Readonly<Record<string, number>>;
}

const STORE_ORDER: readonly string[] = [
  'subjects',
  'progression',
  'sessions',
  'preferences',
  'shortcuts',
  'assistance',
  'attachmentMetadata',
  'attachmentBlobs',
  'customSprites',
  'recovery',
  'migrationReceipts',
];

function flatten(
  store: string,
  envelopes: readonly StorageRecordEnvelope<unknown>[],
): FlatRecord[] {
  return envelopes
    .map((envelope) => ({
      store,
      recordId: envelope.recordId,
      generationId: envelope.generationId,
      checksum: envelope.checksum,
      updatedAt: envelope.updatedAt,
      canonicalValue: canonicalJsonStringify(envelope.value),
    }))
    .sort((left, right) => (left.recordId < right.recordId ? -1 : 1));
}

function countsOf(records: readonly FlatRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const store of STORE_ORDER) counts[store] = 0;
  for (const record of records) {
    counts[record.store] = (counts[record.store] ?? 0) + 1;
  }
  return counts;
}

/** Reads the full device state. Never writes. */
export async function captureDeviceState(
  repository: StorageV2Repository,
): Promise<DeviceState> {
  const descriptors = (await repository.listGenerations()).map((descriptor) => ({
    generationId: descriptor.generationId,
    status: descriptor.status,
    source: descriptor.source,
    generationFormatVersion: descriptor.generationFormatVersion,
    subjectSchemaVersion: descriptor.subjectSchemaVersion,
    contentChecksum: descriptor.contentChecksum,
    recordCounts: { ...descriptor.recordCounts },
    canonicalValue: canonicalJsonStringify(descriptor),
  }));
  descriptors.sort((left, right) =>
    left.generationId < right.generationId ? -1 : 1,
  );

  const records: FlatRecord[] = [];
  for (const descriptor of descriptors) {
    const snapshot = await repository.readRecords(descriptor.generationId);
    for (const store of STORE_ORDER) {
      records.push(
        ...flatten(
          store,
          (snapshot.records as unknown as Record<string, StorageRecordEnvelope<unknown>[]>)[store] ?? [],
        ),
      );
    }
  }
  records.sort((left, right) => {
    const leftKey = `${left.generationId}/${left.store}/${left.recordId}`;
    const rightKey = `${right.generationId}/${right.store}/${right.recordId}`;
    return leftKey < rightKey ? -1 : 1;
  });

  const storage = window.localStorage;
  const legacyEntries: [string, string][] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    legacyEntries.push([key, storage.getItem(key) as string]);
  }

  return {
    activeGenerationId: await repository.readActiveGenerationId(),
    generationIds: descriptors.map((descriptor) => descriptor.generationId),
    descriptors,
    records,
    legacyEntries,
    recordCounts: countsOf(records),
  };
}

/**
 * One digest over the whole state.
 *
 * Built from the canonical serializations, so it is independent of JavaScript
 * key order and of how the reader happened to enumerate anything. Two states
 * with the same digest are the same bytes; a difference anywhere changes it.
 */
export function fingerprintOf(state: DeviceState): string {
  const lines: string[] = [
    `activeGeneration=${state.activeGenerationId ?? 'none'}`,
    ...state.descriptors.map(
      (descriptor) => `descriptor ${descriptor.generationId} ${descriptor.canonicalValue}`,
    ),
    ...state.records.map(
      (record) =>
        `record ${record.generationId} ${record.store} ${record.recordId} ` +
        `checksum=${record.checksum ?? 'none'} updatedAt=${record.updatedAt} value=${record.canonicalValue}`,
    ),
    ...state.legacyEntries.map(([key, value]) => `legacy ${key}=${value}`),
  ];
  return platformSha256(utf8(lines.join('\n')));
}

/** One difference, named by store, record id, and field. Never by value. */
export interface StateDifference {
  readonly kind: 'pointer' | 'descriptor' | 'record' | 'legacy-key' | 'legacy-value';
  readonly where: string;
  readonly field: string;
}

function recordKey(record: FlatRecord): string {
  return `${record.generationId}/${record.store}/${record.recordId}`;
}

/** Exactly what differs between two captured states. Empty means identical. */
export function diffDeviceStates(before: DeviceState, after: DeviceState): StateDifference[] {
  const differences: StateDifference[] = [];

  if (before.activeGenerationId !== after.activeGenerationId) {
    differences.push({ kind: 'pointer', where: 'meta/activeGeneration', field: 'activeGeneration' });
  }

  const beforeDescriptors = new Map(before.descriptors.map((entry) => [entry.generationId, entry]));
  const afterDescriptors = new Map(after.descriptors.map((entry) => [entry.generationId, entry]));
  for (const generationId of new Set([...beforeDescriptors.keys(), ...afterDescriptors.keys()])) {
    const left = beforeDescriptors.get(generationId);
    const right = afterDescriptors.get(generationId);
    if (left === undefined) {
      differences.push({ kind: 'descriptor', where: generationId, field: 'added' });
      continue;
    }
    if (right === undefined) {
      differences.push({ kind: 'descriptor', where: generationId, field: 'removed' });
      continue;
    }
    for (const field of [
      'status',
      'source',
      'generationFormatVersion',
      'subjectSchemaVersion',
      'contentChecksum',
    ] as const) {
      if (left[field] !== right[field]) {
        differences.push({ kind: 'descriptor', where: generationId, field });
      }
    }
    if (canonicalJsonStringify(left.recordCounts) !== canonicalJsonStringify(right.recordCounts)) {
      differences.push({ kind: 'descriptor', where: generationId, field: 'recordCounts' });
    }
  }

  const beforeRecords = new Map(before.records.map((record) => [recordKey(record), record]));
  const afterRecords = new Map(after.records.map((record) => [recordKey(record), record]));
  for (const key of new Set([...beforeRecords.keys(), ...afterRecords.keys()])) {
    const left = beforeRecords.get(key);
    const right = afterRecords.get(key);
    if (left === undefined) {
      differences.push({ kind: 'record', where: key, field: 'added' });
      continue;
    }
    if (right === undefined) {
      differences.push({ kind: 'record', where: key, field: 'removed' });
      continue;
    }
    if (left.checksum !== right.checksum) {
      differences.push({ kind: 'record', where: key, field: 'checksum' });
    }
    if (left.updatedAt !== right.updatedAt) {
      differences.push({ kind: 'record', where: key, field: 'updatedAt' });
    }
    if (left.canonicalValue !== right.canonicalValue) {
      differences.push({ kind: 'record', where: key, field: 'value' });
    }
  }

  const beforeLegacy = new Map(before.legacyEntries);
  const afterLegacy = new Map(after.legacyEntries);
  for (const key of new Set([...beforeLegacy.keys(), ...afterLegacy.keys()])) {
    const left = beforeLegacy.get(key);
    const right = afterLegacy.get(key);
    if (left === undefined) {
      differences.push({ kind: 'legacy-key', where: key, field: 'added' });
      continue;
    }
    if (right === undefined) {
      differences.push({ kind: 'legacy-key', where: key, field: 'removed' });
      continue;
    }
    if (left !== right) {
      differences.push({ kind: 'legacy-value', where: key, field: 'value' });
    }
  }

  return differences;
}

/** Compact, leak-free rendering of a difference list. */
export function describeDifferences(differences: readonly StateDifference[]): string {
  if (differences.length === 0) return 'no differences';
  return differences
    .slice(0, 10)
    .map((difference) => `${difference.kind} ${difference.where} ${difference.field}`)
    .join('; ');
}

/**
 * Deliberately change one stored value.
 *
 * The positive control for every "nothing changed" assertion in this suite. It
 * rewrites one subject record through the real repository, which recomputes that
 * record's checksum and the generation's roll-up, so a fingerprint that fails to
 * move after this would be measuring nothing at all.
 */
export async function mutateActiveSubject(
  repository: StorageV2Repository,
  generationId: string,
  subjectId: string,
): Promise<void> {
  const snapshot = await repository.readRecords(generationId);
  const envelope = snapshot.records.subjects.find(
    (entry) => entry.value.subjectId === subjectId,
  );
  if (envelope === undefined) throw new Error(`No subjects record for ${subjectId}.`);

  const value = structuredClone(envelope.value) as unknown as Record<string, unknown>;
  const snapshotValue = value.snapshot as Record<string, unknown>;
  const dungeon = snapshotValue.dungeon as Record<string, unknown>;
  dungeon.updatedAt = '2099-01-01T00:00:00.000Z';

  // The repository recomputes the envelope checksum and the generation roll-up,
  // so a mutation it silently ignored would leave the fingerprint unmoved and
  // make every "nothing changed" assertion unfalsifiable. Refuse to continue if
  // the value did not actually change.
  if (checksumValue(value) === envelope.checksum) {
    throw new Error('The positive-control mutation did not change the record value.');
  }

  await repository.putRecords(generationId, { subjects: [value as never] });
}
