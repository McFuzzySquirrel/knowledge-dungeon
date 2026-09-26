/**
 * The `state.json` document, built from a real generation and read back field by
 * field.
 *
 * Plan section 7.3 fixes what `state.json` must carry: "all subjects,
 * authoritative progression, fish, sessions, preferences, shortcuts, locale, quest
 * state, assistance, custom sprite records, and migration receipts". This module
 * turns that sentence into a document and, more importantly, into a *comparison*
 * that can fail.
 *
 * Why the comparison is the point: a round-trip gate that says "the state came
 * back equal" is worthless if its notion of equality cannot tell a restored state
 * from a lossy one. So {@link compareStateDocument} walks section by section and
 * record by record, and names the exact record and field that differs.
 * `populatedStateRoundTrip.test.ts` then proves the comparator bites by dropping
 * one real field and requiring that the comparator reports it - and only it.
 *
 * The document is built for the gate from the real repository snapshot. When the
 * product lands, its `state.json` is fed to the *same* comparator, so the
 * registered reproduction and the green fixture check cannot disagree about what
 * "equal" means.
 *
 * Privacy: the document is learner data by construction - that is what a backup
 * is - and it never leaves this process except into the fixture archives the gate
 * builds in memory. Nothing here logs, reports, or writes it to disk.
 */

import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import type { GenerationSnapshot } from '@/services/persistence/v2/repository';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
} from '@/services/persistence/v2/schema';
import { CURRENT_SCHEMA_VERSION, DATA_PRODUCT_FORMAT_VERSIONS } from '@/core/validation/persistence/types';
import type { PopulatedDevice } from './populatedDevice';
import { DEVICE_LOCALE, DEVICE_QUEST_STATE } from './populatedDevice';

/** Sections of `state.json`, in the order the plan lists them. */
export const STATE_SECTIONS = [
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

export type StateSection = (typeof STATE_SECTIONS)[number];

/** Keys the document carries outside its record sections. */
export const STATE_DOCUMENT_KEYS = [
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
  'createdAt',
  'locale',
  'questState',
  ...STATE_SECTIONS,
] as const;

/** One difference, named by section, record, and field. Never by value. */
export interface DocumentDifference {
  readonly section: string;
  readonly recordId: string;
  readonly field: string;
}

/** Read the device's active generation and assemble the plan's `state.json`. */
export function buildStateDocument(
  device: PopulatedDevice,
  snapshot: GenerationSnapshot,
  createdAt: string,
): Record<string, unknown> {
  // A real guard, and the reason the device is a parameter: a document built from
  // a generation other than the one the device names would compare a restored state
  // against the wrong source and could report equality that does not exist.
  if (snapshot.generationId !== device.generationId) {
    throw new Error(
      `The state document was built from generation ${snapshot.generationId}, but the device names ${device.generationId}.`,
    );
  }
  const values = (section: StateSection): unknown[] =>
    (snapshot.records as unknown as Record<string, { value: unknown }[]>)[section].map(
      (envelope) => envelope.value,
    );
  return {
    formatVersion: DATA_PRODUCT_FORMAT_VERSIONS.kdbak,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt,
    locale: DEVICE_LOCALE,
    questState: DEVICE_QUEST_STATE,
    subjects: values('subjects'),
    progression: values('progression'),
    sessions: values('sessions'),
    preferences: values('preferences'),
    shortcuts: values('shortcuts'),
    assistance: values('assistance'),
    attachmentMetadata: values('attachmentMetadata'),
    customSprites: values('customSprites'),
    recovery: values('recovery'),
    migrationReceipts: values('migrationReceipts'),
  };
}

/** The id field each section is keyed by, matching the repository's own keys. */
const SECTION_ID_FIELD: Readonly<Record<StateSection, string>> = {
  subjects: 'subjectId',
  progression: 'subjectId',
  sessions: 'sessionId',
  preferences: 'preferenceId',
  shortcuts: 'actionId',
  assistance: 'assistanceId',
  attachmentMetadata: 'attachmentId',
  customSprites: 'spritePath',
  recovery: 'subjectId',
  migrationReceipts: 'receiptId',
};

/** Custom sprites are keyed by `(kind, spritePath)`, so both are compared. */
function customSpriteId(value: unknown): string {
  const record = value as { kind?: string; spritePath?: string };
  return `${String(record.kind)}:${String(record.spritePath)}`;
}

/**
 * Compare a `state.json` document against the device it claims to describe.
 *
 * Returns every difference, named by section, record, and field. An empty result
 * is a claim of semantic equality that the next field-level edit can break.
 */
export function compareStateDocument(
  document: Record<string, unknown>,
  snapshot: GenerationSnapshot,
): DocumentDifference[] {
  const differences: DocumentDifference[] = [];

  for (const key of ['formatVersion', 'storageGenerationFormatVersion', 'subjectSchemaVersion'] as const) {
    const expected =
      key === 'formatVersion'
        ? DATA_PRODUCT_FORMAT_VERSIONS.kdbak
        : key === 'storageGenerationFormatVersion'
          ? STORAGE_V2_GENERATION_FORMAT_VERSION
          : CANONICAL_SUBJECT_SCHEMA_VERSION;
    if (document[key] !== expected) {
      differences.push({ section: 'document', recordId: key, field: 'value' });
    }
  }
  if (document.locale !== DEVICE_LOCALE) {
    differences.push({ section: 'document', recordId: 'locale', field: 'value' });
  }
  if (canonicalJsonStringify(document.questState) !== canonicalJsonStringify(DEVICE_QUEST_STATE)) {
    differences.push({ section: 'document', recordId: 'questState', field: 'value' });
  }

  for (const section of STATE_SECTIONS) {
    const actual = (document[section] ?? []) as Record<string, unknown>[];
    const expectedRecords = (
      snapshot.records as unknown as Record<string, { value: unknown }[]>
    )[section].map((envelope) => envelope.value as Record<string, unknown>);

    if (!Array.isArray(document[section])) {
      differences.push({ section, recordId: '*', field: 'not-an-array' });
      continue;
    }
    const actualById = new Map(
      actual.map((value) => [
        section === 'customSprites' ? customSpriteId(value) : String(value[SECTION_ID_FIELD[section]]),
        value,
      ]),
    );
    const expectedById = new Map(
      expectedRecords.map((value) => [
        section === 'customSprites' ? customSpriteId(value) : String(value[SECTION_ID_FIELD[section]]),
        value,
      ]),
    );

    for (const id of expectedById.keys()) {
      if (!actualById.has(id)) {
        differences.push({ section, recordId: id, field: 'missing-record' });
      }
    }
    for (const id of actualById.keys()) {
      if (!expectedById.has(id)) {
        differences.push({ section, recordId: id, field: 'unexpected-record' });
      }
    }
    for (const [id, expectedValue] of expectedById) {
      const actualValue = actualById.get(id);
      if (actualValue === undefined) continue;
      const actualCanonical = canonicalJsonStringify(actualValue);
      const expectedCanonical = canonicalJsonStringify(expectedValue);
      if (actualCanonical === expectedCanonical) continue;
      // Name the field that moved, so a failure says which one.
      for (const field of new Set([
        ...Object.keys(expectedValue as Record<string, unknown>),
        ...Object.keys(actualValue as Record<string, unknown>),
      ])) {
        if (
          canonicalJsonStringify((expectedValue as Record<string, unknown>)[field]) !==
          canonicalJsonStringify((actualValue as Record<string, unknown>)[field])
        ) {
          differences.push({ section, recordId: id, field });
        }
      }
    }
  }

  return differences;
}

/** Compact, leak-free rendering of a difference list. */
export function describeDocumentDifferences(differences: readonly DocumentDifference[]): string {
  if (differences.length === 0) return 'no differences';
  return differences
    .slice(0, 10)
    .map((difference) => `${difference.section}/${difference.recordId}.${difference.field}`)
    .join('; ');
}

/** One external-only disclosure, with the honest absence of a hash. */
export interface ExternalOnlyDisclosure {
  readonly attachmentId: string;
  readonly contentHash: null;
  readonly reason: string;
  readonly byteLength: null;
}

/**
 * The external-only attachments a document or import result discloses.
 *
 * A disclosure is only honest if it carries **no** hash: an attachment whose
 * bytes are not on the device has no content to hash, and a fabricated digest
 * would misreport what a backup contains (plan section 2.3). `contentHash` is
 * therefore typed as `null`, not `string | null`, so a product that invented one
 * would not typecheck against this gate.
 */
export function externalOnlyDisclosures(
  attachmentMetadata: readonly Record<string, unknown>[],
): ExternalOnlyDisclosure[] {
  return attachmentMetadata
    .filter((record) => record.availability === 'external-only')
    .map((record) => ({
      attachmentId: String(record.attachmentId),
      contentHash: null as null,
      reason: typeof record.reason === 'string' ? record.reason : 'historical-external-url',
      byteLength: null as null,
    }));
}

/** The subject schema version the *current* build writes, for version pins. */
export const CURRENT_SUBJECT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
