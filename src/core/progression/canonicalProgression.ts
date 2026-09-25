/**
 * The single canonical progression representation.
 *
 * Plan section 7.2 step 5 requires progression versions 1, 2, and 3 to normalize
 * into ONE canonical representation. The progression store and the storage-v2
 * migration must both call the normalizer declared here, so a given persisted
 * payload always produces identical canonical output regardless of which path
 * reads it.
 *
 * This module is pure and renderer-neutral. It never touches `localStorage`,
 * `IndexedDB`, the real clock, or `Math.random()`. Every source of
 * nondeterminism is injected by the caller:
 *
 * - the active subject id (which decides where an unversioned v1 record lands),
 * - the identifier factory used when a malformed record is missing an id.
 *
 * Differences from the previous in-store normalizer, both deliberate and
 * covered by tests:
 * - unknown app-owned fields are retained under `extraFields` instead of being
 *   dropped (plan section 7.3 "must preserve unknown app-owned fields");
 * - `rank` is always derived from `xpTotal` instead of trusting a stored value
 *   (already the case in the store, now stated in the canonical contract).
 */

import { assignRankTier } from './progressionEngine';
import type { RankTier } from './types';
import { EQUIP_SLOTS, type EquipSlot, type EquippableLootItem } from './lootSystem';
import { deserializeFishCollection } from '@/core/fishing/fishCollectionService';
import type { FishEntry } from '@/core/fishing/fishingTypes';

/**
 * Bucket used for an unversioned (v1) flat record when no subject is active.
 * The name is the current store's literal and is part of the persisted
 * contract, so it is declared here once and reused by the migration path.
 */
export const LEGACY_PROGRESSION_SUBJECT_ID = '__legacy__';

/** Persisted envelope version this canonical shape serializes to. */
export const CANONICAL_PROGRESSION_VERSION = 3;

/** Serialized payload marker; lets a reader tell canonical output from v1/v2. */
export const CANONICAL_PROGRESSION_KIND = 'knowledge-dungeon-canonical-progression';

/** Deterministic ISO timestamp used when a record omits a date. */
export const CANONICAL_EPOCH_ISO = new Date(0).toISOString();

/** Reserved key holding preserved unknown app-owned fields inside a record. */
export const CANONICAL_UNKNOWN_FIELDS_KEY = 'extraFields';

export interface CanonicalLootItem {
  id: string;
  name: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic';
  acquiredAt: string;
}

export type CanonicalEquippedItem = EquippableLootItem;

export interface CanonicalCollectedNote {
  noteId: string;
  dungeonId: string;
  roomId: string;
  topic: string;
  floorLabel: string;
  artifactPreview: string;
  noteMarkdown: string;
  artifactMarkdown: string;
  collectedAt: string;
}

/** A loot entry exactly as it is stored; `undefined` means "not provided". */
export type PartialEquippedItem = Omit<EquippableLootItem, 'equipSlot' | 'equipped'> & {
  equipSlot?: EquipSlot;
  equipped?: boolean;
};

/**
 * Canonical per-subject progression.
 *
 * The known fields are listed explicitly so the normalizer can recognize and
 * separate them from unknown app-owned fields. Adding a known field means
 * adding it here and to {@link CANONICAL_SUBJECT_PROGRESSION_KEYS}.
 */
export interface CanonicalSubjectProgression {
  subjectId: string;
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: CanonicalLootItem[];
  equippedItems: CanonicalEquippedItem[];
  collectedNotes: CanonicalCollectedNote[];
  streakCount: number;
  subjectsMastered: number;
  roomsCleared: number;
  reviewPasses: number;
  artifacts: number;
  bossesDefeated: number;
  /**
   * Fish caught in this subject.
   *
   * Deserialized with `deserializeFishCollection`, which preserves an existing
   * `catalogId` and never invents one, so a collection round trip is lossless
   * and the store's observable state is unchanged. Call
   * `toCanonicalFishCollection` to resolve catalog identity for storage,
   * backup, or migration output; the canonical fish contract is
   * `CanonicalFishEntry`.
   */
  fishCollection: FishEntry[];
  /** Unknown app-owned fields, preserved verbatim. */
  extraFields: Record<string, unknown>;
}

/**
 * Write shape accepted by {@link canonicalProgressionToRecord} and
 * {@link toLegacyV3ProgressionRecord}.
 *
 * Identical to the canonical value except that the two canonical-only fields
 * are optional, so a caller may serialize a record it did not normalize (the
 * store builds records incrementally) without fabricating them.
 */
export type CanonicalSubjectProgressionWriteShape = Omit<
  CanonicalSubjectProgression,
  'subjectId' | 'extraFields'
> & {
  subjectId?: string;
  extraFields?: Record<string, unknown>;
};

/**
 * The per-subject record keys the current `localStorage` v3 payload has always
 * carried, in the order it has always written them.
 *
 * This list is the legacy mirror's contract. It is deliberately *not* the
 * canonical key set: `subjectId` and `extraFields` are canonical-only and must
 * never reach the legacy key, because the pre-phase build does not write them
 * and Phase 3's rollback is a source revert.
 */
export const LEGACY_V3_SUBJECT_PROGRESSION_KEYS = [
  'xpTotal',
  'rank',
  'badges',
  'inventory',
  'equippedItems',
  'collectedNotes',
  'streakCount',
  'subjectsMastered',
  'roomsCleared',
  'reviewPasses',
  'artifacts',
  'bossesDefeated',
  'fishCollection',
] as const;

/** Envelope keys the current `localStorage` v3 payload has always carried. */
export const LEGACY_V3_PROGRESSION_KEYS = [
  'version',
  'bySubject',
  'crossSubjectAchievements',
] as const;

/** The persisted envelope version the legacy mirror writes. */
export const LEGACY_V3_PROGRESSION_VERSION = 3;

export interface CanonicalProgression {
  /** Shape version detected on the input: 0 when unversioned (v1). */
  sourceVersion: 0 | 1 | 2 | 3;
  /** Active subject resolved by the caller; never read from storage here. */
  activeSubjectId: string | null;
  /**
   * Bucket an unversioned v1 flat record was filed under, or `null` for a
   * by-subject payload. Kept separate from `activeSubjectId` so the routed
   * bucket and the real active subject are never conflated.
   */
  legacyBucketSubjectId: string | null;
  bySubject: Record<string, CanonicalSubjectProgression>;
  crossSubjectAchievements: string[];
  /** Unknown app-owned fields on the envelope, preserved verbatim. */
  extraFields: Record<string, unknown>;
}

export interface CanonicalProgressionOptions {
  /**
   * Injected active subject id. `null` or blank routes an unversioned v1 record
   * into the `__legacy__` bucket, matching current behavior.
   */
  activeSubjectId?: string | null;
  /**
   * Injected identifier factory for records that are missing an id. The store
   * passes the same `Math.random`-derived shape it used before, so existing
   * persisted output is unchanged; the migration passes a seeded counter.
   */
  createId?: (prefix: 'loot' | 'gear') => string;
}

/**
 * Known keys of a per-subject record, plus the reserved unknown-field carrier.
 * Anything outside this set is preserved as an app-owned field.
 */
export const CANONICAL_SUBJECT_PROGRESSION_KEYS: readonly string[] = [
  'subjectId',
  'xpTotal',
  'rank',
  'badges',
  'inventory',
  'equippedItems',
  'collectedNotes',
  'streakCount',
  'subjectsMastered',
  'roomsCleared',
  'reviewPasses',
  'artifacts',
  'bossesDefeated',
  'fishCollection',
  CANONICAL_UNKNOWN_FIELDS_KEY,
];

/** Known keys of the progression envelope. */
export const CANONICAL_PROGRESSION_KEYS: readonly string[] = [
  'kind',
  'version',
  'sourceVersion',
  'activeSubjectId',
  'legacyBucketSubjectId',
  'bySubject',
  'crossSubjectAchievements',
  CANONICAL_UNKNOWN_FIELDS_KEY,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEquipSlot(value: unknown): value is EquipSlot {
  return typeof value === 'string' && (EQUIP_SLOTS as readonly string[]).includes(value);
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === 'number' ? Math.max(0, Math.trunc(value)) : 0;
}

function toEpochIso(value: unknown): string {
  return typeof value === 'string' ? value : CANONICAL_EPOCH_ISO;
}

function toStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

function pickUnknownFields(
  record: Record<string, unknown>,
  knownKeys: readonly string[],
): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (knownKeys.includes(key)) continue;
    if (value === undefined) continue;
    unknown[key] = value;
  }
  return unknown;
}

function mergeUnknownFields(
  carried: Record<string, unknown>,
  residual: Record<string, unknown>,
): Record<string, unknown> {
  return { ...carried, ...residual };
}

function extractCarriedUnknownFields(record: Record<string, unknown>): Record<string, unknown> {
  const carried = record[CANONICAL_UNKNOWN_FIELDS_KEY];
  return isRecord(carried) ? carried : {};
}

/**
 * Normalize a collection of unknown loot entries.
 *
 * Exported so the storage-v2 validation path can report counts without
 * re-implementing the rules.
 */
export function normalizeCanonicalLootItems(
  raw: unknown,
  createId: (prefix: 'loot' | 'gear') => string,
): CanonicalLootItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : createId('loot'),
      name: typeof entry.name === 'string' ? entry.name : 'Unknown artifact',
      description: typeof entry.description === 'string' ? entry.description : '',
      rarity: entry.rarity === 'rare' || entry.rarity === 'epic' ? entry.rarity : 'common',
      acquiredAt: toEpochIso(entry.acquiredAt),
    }));
}

/** Normalize equipped gear, preserving the current default-slot behavior. */
export function normalizeCanonicalEquippedItems(
  raw: unknown,
  createId: (prefix: 'loot' | 'gear') => string,
): CanonicalEquippedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : createId('gear'),
      name: typeof entry.name === 'string' ? entry.name : 'Unknown gear',
      description: typeof entry.description === 'string' ? entry.description : '',
      rarity: entry.rarity === 'rare' || entry.rarity === 'epic' ? entry.rarity : 'common',
      acquiredAt: toEpochIso(entry.acquiredAt),
      equipSlot: isEquipSlot(entry.equipSlot) ? entry.equipSlot : 'accessory',
      qualityBonus: typeof entry.qualityBonus === 'number' ? entry.qualityBonus : undefined,
      xpMultiplier: typeof entry.xpMultiplier === 'number' ? entry.xpMultiplier : undefined,
      xpBonus: typeof entry.xpBonus === 'number' ? entry.xpBonus : undefined,
      streakBonus: typeof entry.streakBonus === 'number' ? entry.streakBonus : undefined,
      equipped: typeof entry.equipped === 'boolean' ? entry.equipped : false,
    }));
}

/** Normalize collected artifact notes, including the legacy `artifactPreview` fallback. */
export function normalizeCanonicalCollectedNotes(raw: unknown): CanonicalCollectedNote[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((entry) => ({
      noteId: typeof entry.noteId === 'string' ? entry.noteId : '',
      dungeonId: typeof entry.dungeonId === 'string' ? entry.dungeonId : '',
      roomId: typeof entry.roomId === 'string' ? entry.roomId : '',
      topic: typeof entry.topic === 'string' ? entry.topic : 'Collected note',
      floorLabel: typeof entry.floorLabel === 'string' ? entry.floorLabel : 'Unknown floor',
      artifactPreview: typeof entry.artifactPreview === 'string' ? entry.artifactPreview : '',
      noteMarkdown: typeof entry.noteMarkdown === 'string' ? entry.noteMarkdown : '',
      artifactMarkdown:
        typeof entry.artifactMarkdown === 'string'
          ? entry.artifactMarkdown
          : typeof entry.artifactPreview === 'string'
            ? entry.artifactPreview
            : 'Artifact note collected.',
      collectedAt: toEpochIso(entry.collectedAt),
    }))
    .filter((entry) => entry.noteId.length > 0);
}

/**
 * Normalize one subject progression record.
 *
 * `subjectId` is the caller's key for the record; it is written into the
 * canonical value so a serialized record is self-describing.
 */
export function normalizeCanonicalSubjectProgression(
  raw: unknown,
  subjectId: string,
  createId: (prefix: 'loot' | 'gear') => string,
): CanonicalSubjectProgression {
  const record = isRecord(raw) ? raw : {};
  const xpTotal = toNonNegativeInt(record.xpTotal);
  const carried = extractCarriedUnknownFields(record);
  return {
    subjectId,
    xpTotal,
    // Derived, never trusted from storage.
    rank: assignRankTier(xpTotal),
    badges: toStringArray(record.badges),
    inventory: normalizeCanonicalLootItems(record.inventory, createId),
    equippedItems: normalizeCanonicalEquippedItems(record.equippedItems, createId),
    collectedNotes: normalizeCanonicalCollectedNotes(record.collectedNotes),
    streakCount: toNonNegativeInt(record.streakCount),
    subjectsMastered: toNonNegativeInt(record.subjectsMastered),
    roomsCleared: toNonNegativeInt(record.roomsCleared),
    reviewPasses: toNonNegativeInt(record.reviewPasses),
    artifacts: toNonNegativeInt(record.artifacts),
    bossesDefeated: toNonNegativeInt(record.bossesDefeated),
    fishCollection: deserializeFishCollection(record.fishCollection),
    extraFields: mergeUnknownFields(
      carried,
      pickUnknownFields(record, CANONICAL_SUBJECT_PROGRESSION_KEYS),
    ),
  };
}

function defaultCreateId(prefix: 'loot' | 'gear'): string {
  // Only reached when a caller supplies no factory. Deterministic by design:
  // the storage-v2 path must never mint random ids.
  return `${prefix}-undetermined`;
}

/** The canonical state for a device that has no readable progression. */
export function emptyCanonicalProgression(): CanonicalProgression {
  return {
    sourceVersion: 0,
    activeSubjectId: null,
    legacyBucketSubjectId: null,
    bySubject: {},
    crossSubjectAchievements: [],
    extraFields: {},
  };
}

/**
 * A default per-subject record, with the canonical-only fields absent.
 *
 * Built by running the normalizer over an empty payload and then projecting it
 * onto the legacy key set, so a fresh subject and a migrated one cannot drift
 * apart. `subjectId` is deliberately absent: a default record is a template, not
 * a record for a specific subject, and stamping one with a foreign id is how a
 * new subject ends up persisted with the wrong identity.
 */
export function makeDefaultSubjectProgression(): CanonicalSubjectProgressionWriteShape {
  const record = normalizeProgressionRecord({}).bySubject[LEGACY_PROGRESSION_SUBJECT_ID];
  // An unversioned payload always lands in the legacy bucket, so this is
  // present. The guard makes a broken invariant loud instead of silently
  // writing a half-empty record into a learner's progression.
  if (record === undefined) {
    throw new Error('canonical progression default record is missing.');
  }
  return projectToLegacyV3SubjectRecord(record) as CanonicalSubjectProgressionWriteShape;
}

/**
 * Project one canonical record onto the legacy v3 record shape.
 *
 * Emits exactly {@link LEGACY_V3_SUBJECT_PROGRESSION_KEYS}, in that order, so a
 * record with no unknown app-owned field serializes byte-identically to what the
 * pre-phase build wrote. Preserved unknown fields are **flattened** after the
 * known keys: that is an additive superset, so the pre-phase reader ignores them,
 * and they survive a read-modify-write cycle without a wrapper key the
 * pre-phase reader would misparse.
 */
function projectToLegacyV3SubjectRecord(
  record: CanonicalSubjectProgressionWriteShape,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of LEGACY_V3_SUBJECT_PROGRESSION_KEYS) {
    projected[key] = record[key];
  }
  for (const [key, value] of Object.entries(record.extraFields ?? {})) {
    if ((LEGACY_V3_SUBJECT_PROGRESSION_KEYS as readonly string[]).includes(key)) continue;
    projected[key] = value;
  }
  return projected;
}

export interface LegacyV3ProgressionRecord {
  version: number;
  bySubject: Record<string, Record<string, unknown>>;
  crossSubjectAchievements: string[];
}

/**
 * Serialize to the **legacy v3 `localStorage` shape** the current build writes.
 *
 * This is the mirror format, not the storage-v2 format. It exists so the
 * progression store can keep writing exactly what it wrote before this phase:
 * the same three envelope keys, the same thirteen record keys in the same order,
 * and no canonical-only field. Use
 * {@link canonicalProgressionToRecord} / {@link serializeCanonicalProgression}
 * for storage-v2, which is the only place the canonical form is written.
 *
 * The subject identity always comes from the `bySubject` map key. A `subjectId`
 * stored inside a record is never read.
 */
export function toLegacyV3ProgressionRecord(input: {
  bySubject: Readonly<Record<string, CanonicalSubjectProgressionWriteShape>>;
  crossSubjectAchievements: readonly string[];
}): LegacyV3ProgressionRecord {
  const bySubject: Record<string, Record<string, unknown>> = {};
  for (const [subjectId, record] of Object.entries(input.bySubject)) {
    bySubject[subjectId] = projectToLegacyV3SubjectRecord(record);
  }
  return {
    version: LEGACY_V3_PROGRESSION_VERSION,
    bySubject,
    crossSubjectAchievements: [...input.crossSubjectAchievements],
  };
}

/**
 * Normalize any persisted progression payload (v1 flat, v2 by-subject, or v3
 * by-subject) into the single canonical representation.
 */
export function normalizeProgressionRecord(
  raw: unknown,
  options: CanonicalProgressionOptions = {},
): CanonicalProgression {
  const createId = options.createId ?? defaultCreateId;
  const envelope = isRecord(raw) ? raw : {};
  const rawVersion = envelope.version;
  const sourceVersion: 0 | 1 | 2 | 3 =
    rawVersion === 3 ? 3 : rawVersion === 2 ? 2 : rawVersion === 1 ? 1 : 0;
  const hasBySubject =
    (sourceVersion === 2 || sourceVersion === 3) && isRecord(envelope.bySubject);

  const crossSubjectAchievements =
    sourceVersion === 3 ? toStringArray(envelope.crossSubjectAchievements) : [];

  if (hasBySubject) {
    const bySubjectRecord = envelope.bySubject as Record<string, unknown>;
    const bySubject: Record<string, CanonicalSubjectProgression> = {};
    for (const [subjectId, subjectProgression] of Object.entries(bySubjectRecord)) {
      bySubject[subjectId] = normalizeCanonicalSubjectProgression(
        subjectProgression,
        subjectId,
        createId,
      );
    }
    return {
      sourceVersion,
      activeSubjectId: normalizeActiveSubjectId(options.activeSubjectId),
      legacyBucketSubjectId: null,
      bySubject,
      crossSubjectAchievements,
      extraFields: mergeUnknownFields(
        extractCarriedUnknownFields(envelope),
        pickUnknownFields(envelope, CANONICAL_PROGRESSION_KEYS),
      ),
    };
  }

  // Unversioned (v1) or malformed by-subject payload: treat the envelope as a
  // single flat record and route it to the active subject, exactly as the
  // current store does.
  const activeSubjectId = normalizeActiveSubjectId(options.activeSubjectId);
  const subjectId = activeSubjectId && activeSubjectId.length > 0
    ? activeSubjectId
    : LEGACY_PROGRESSION_SUBJECT_ID;
  return {
    sourceVersion,
    activeSubjectId,
    legacyBucketSubjectId: subjectId,
    bySubject: {
      [subjectId]: normalizeCanonicalSubjectProgression(envelope, subjectId, createId),
    },
    crossSubjectAchievements,
    extraFields: mergeUnknownFields(
      extractCarriedUnknownFields(envelope),
      pickUnknownFields(envelope, CANONICAL_PROGRESSION_KEYS),
    ),
  };
}

function normalizeActiveSubjectId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
}

/**
 * Serialize a canonical progression payload.
 *
 * The output is the current v3 persisted shape plus a `kind` marker and the
 * preserved unknown fields, so a reader can tell canonical output apart from a
 * hand-written v1/v2 payload.
 *
 * Round-trip contract, precisely: the **per-subject records and the preserved
 * unknown fields are an exact round trip**. The envelope's provenance fields are
 * NOT: `deserializeCanonicalProgression` re-derives `sourceVersion` from the
 * written `version`, and `activeSubjectId` / `legacyBucketSubjectId` come from
 * the caller's options rather than the payload, so they come back as a
 * normalized v3 pair (see `LEGACY_PROGRESSION_V3_*` for the mirror contract).
 * Callers that need the provenance preserved must carry it themselves.
 */
export function serializeCanonicalProgression(canonical: CanonicalProgression): string {
  return JSON.stringify(canonicalProgressionToRecord(canonical));
}

/** The plain-object form of a canonical payload (the serializer's input). */
export function canonicalProgressionToRecord(
  canonical: Omit<CanonicalProgression, 'bySubject'> & {
    bySubject: Readonly<Record<string, CanonicalSubjectProgressionWriteShape>>;
  },
): Record<string, unknown> {
  const bySubject: Record<string, unknown> = {};
  for (const [subjectId, subject] of Object.entries(canonical.bySubject)) {
    bySubject[subjectId] = {
      ...subject,
      [CANONICAL_UNKNOWN_FIELDS_KEY]: subject.extraFields ?? {},
    };
  }
  return {
    kind: CANONICAL_PROGRESSION_KIND,
    version: CANONICAL_PROGRESSION_VERSION,
    sourceVersion: canonical.sourceVersion,
    activeSubjectId: canonical.activeSubjectId,
    legacyBucketSubjectId: canonical.legacyBucketSubjectId,
    bySubject,
    crossSubjectAchievements: [...canonical.crossSubjectAchievements],
    [CANONICAL_UNKNOWN_FIELDS_KEY]: canonical.extraFields,
  };
}

/**
 * Read a serialized payload back into canonical form.
 *
 * Accepts a payload this module serialized and any legacy v1/v2/v3 payload, so
 * one function serves the store, the migration, and a reader of either format.
 *
 * Round trip is exact for records and preserved unknown fields; the envelope's
 * provenance fields are re-derived, as documented on
 * {@link serializeCanonicalProgression}.
 */
export function deserializeCanonicalProgression(
  raw: string | unknown,
  options: CanonicalProgressionOptions = {},
): CanonicalProgression {
  if (typeof raw !== 'string') return normalizeProgressionRecord(raw, options);
  try {
    return normalizeProgressionRecord(JSON.parse(raw) as unknown, options);
  } catch {
    // Unreadable JSON yields the canonical empty state, which is what the
    // progression store has always done with a corrupt payload.
    return emptyCanonicalProgression();
  }
}

/** Convenience wrapper for a single subject's canonical record. */
export function readCanonicalSubjectProgression(
  canonical: CanonicalProgression,
  subjectId: string,
): CanonicalSubjectProgression | null {
  return canonical.bySubject[subjectId] ?? null;
}
