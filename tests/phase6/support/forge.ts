/**
 * Independent Phase 6 verification harness - device forge.
 *
 * Written by the *verifier*. This file and everything else under `tests/phase6/`
 * shares **no code and no helper** with `tests/data/support/`. It does not import
 * `nastySubject.ts`, `subjectArchive.ts`, `deviceState.ts`, `populatedDevice.ts`,
 * `hostileZip.ts`, `importGraph.ts`, or any other implementer-owned fixture, and
 * it re-derives its own fingerprint rather than calling `captureDeviceState`.
 *
 * Everything is built through the **real** production path -
 * `openStorageV2Repository`, `stageGeneration`, `activateGeneration` - so a gate
 * here measures the product against a real storage-v2 generation rather than
 * against a mock. The IndexedDB substrate is `fake-indexeddb`, and that limit is
 * stated in the report rather than hidden: no gate here claims browser evidence.
 *
 * The device is deliberately nastier than a real one in ways that are all
 * *reachable states* rather than impossible ones:
 *
 * - three subjects, so "unrelated subject" has something to be;
 * - **two subjects share one attachment's bytes** (one content hash, two
 *   attachment ids), so a replace that destroys by content hash instead of by
 *   attachment id is visible;
 * - **one progression record holds two subjects' `bySubject` data**, which is
 *   what the storage-v2 record key (`record.subjectId`) permits and what the
 *   legacy `localStorage` v3 shape actually wrote;
 * - a room whose `topic`, a tag, a `biome`, and an edge `relationType` are each
 *   *exactly* a room id, so a value sweep that is too eager corrupts content and
 *   a protected set that is too small corrupts content;
 * - `notePath` / `artifactPath` carrying the room id as a whole segment;
 * - an undeclared field holding a room id as a **value** (must be swept) and an
 *   undeclared field holding a room id as an **object key** (the class the module
 *   header says the residual count covers);
 * - prose that merely *mentions* a room id, which must survive verbatim;
 * - a subject whose `snapshot.dungeon.dungeonId` disagrees with its `subjectId`,
 *   because `migrations.ts` treats `dungeonId` as the authoritative subject id
 *   and the remap table does not mention the field;
 * - every device-global store populated, plus a migration receipt, plus ordered
 *   legacy `localStorage`.
 *
 * Privacy: every string here is synthetic and self-describing. The reserved
 * `example.invalid` host is never used and no real host, path, or credential
 * appears. Marker strings are prefixed `ZX` so a scan can find them by shape.
 */

import 'fake-indexeddb/auto';

import { createHash } from 'node:crypto';

import {
  createDeterministicIdFactory,
  fixedClock,
} from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
// `GenerationRecordValues` is declared in `validation.ts`; `repository.ts` imports it
// but does not re-export it, so naming it through `repository` silently yields `any`
// and every downstream inference in these gates goes with it.
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  LEGACY_MIGRATION_ID,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  type AssistanceRecordValue,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type CustomSpriteRecordValue,
  type MigrationReceiptValue,
  type PreferenceRecordValue,
  type ProgressionRecordValue,
  type RecoveryRecordValue,
  type SessionRecordValue,
  type ShortcutRecordValue,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';

// ── Privacy markers ─────────────────────────────────────────────────────────

/**
 * The planted marker strings.
 *
 * One per place learner content can reach a report: a subject name, a room topic,
 * note text, an attachment file name, alt text, and a tag. A gate asserts none of
 * them appears in a manifest, a member path, a file name, an error detail, a
 * disclosure string, or an import/export report.
 */
export const MARKERS = {
  subjectName: 'ZX-MARKER-SUBJECT-NAME',
  roomTopic: 'ZX-MARKER-ROOM-TOPIC',
  noteText: 'ZX-MARKER-NOTE-TEXT',
  fileName: 'ZX-MARKER-FILE-NAME.png',
  altText: 'ZX-MARKER-ALT-TEXT',
  tag: 'ZX-MARKER-TAG',
} as const;

export const ALL_MARKERS: readonly string[] = Object.values(MARKERS);

// ── The device's shape ──────────────────────────────────────────────────────

/** Subject ids. `ALPHA` is the one under test; the other two are the bystanders. */
export const ALPHA = 'subj-alpha-0001';
export const BETA = 'subj-beta-0002';
export const GAMMA = 'subj-gamma-0003';

/** Room ids for `ALPHA`. The first is also the string several other fields use. */
export const R_ROOT = 'rm-alpha-root';
export const R_SIDE = 'rm-alpha-side';
export const R_DEEP = 'rm-alpha-deep';

/** An attachment id on `ALPHA`, and the one on `BETA` that shares its bytes. */
export const ATT_ALPHA = 'att-alpha-0001';
export const ATT_BETA_SHARED = 'att-beta-0001';
export const ATT_EXTERNAL = 'att-alpha-0002';

export const FIXED_NOW = '2026-02-03T04:05:06.000Z';
export const OTHER_NOW = '2026-02-04T05:06:07.000Z';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export interface ForgedDevice {
  readonly repository: StorageV2Repository;
  readonly databaseName: string;
  /** The active generation the export reads. */
  readonly generationId: string;
  readonly priorGenerationId: string;
  /** Bytes `ALPHA`'s stored attachment resolves to, for the export's payload map. */
  readonly sharedBytes: Uint8Array;
  readonly expected: GenerationRecordValues;
  /** The content hash both `ATT_ALPHA` and `ATT_BETA_SHARED` point at. */
  readonly sharedContentHash: string;
}

// ── A byte-exact canonical serializer, written here rather than imported ────

/**
 * Canonical JSON with binary values spelled in base64, so a fingerprint covers
 * attachment *bytes* and not just record metadata.
 *
 * Written here rather than imported from the product's `checksum.ts` so that a
 * bug in the product's own serializer cannot make a fingerprint agree with a
 * corrupt device - and, as it turns out, so that this one can be *stricter*: the
 * product's serializer has no `ArrayBuffer` branch at all, and this harness had
 * to add a realm-agnostic one. `instanceof` is not enough here: a value read back
 * out of `fake-indexeddb` is an `ArrayBuffer` from another realm, so
 * `value instanceof ArrayBuffer` is `false` for it and an `instanceof`-only
 * fingerprint silently reports `{}` for every attachment on the device. That is
 * recorded as a harness finding in `tests/phase6/checksumCoverage.test.ts`, and
 * it is why this function duck-types instead.
 */
export function forgeCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'undefined') return '"__undefined__"';
  const binary = asBinary(value);
  if (binary !== null) return `"b64:${binary}"`;
  if (Array.isArray(value)) return `[${value.map(forgeCanonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    // `Object.prototype.toJSON` is honoured by JSON.stringify but not here, and a
    // record that defines one is exactly the shape a hostile archive produces.
    if (typeof record.toJSON === 'function') {
      return forgeCanonical((record.toJSON as () => unknown)());
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${forgeCanonical(record[key])}`).join(',')}}`;
  }
  return `"__${typeof value}__"`;
}

/**
 * Base64 for any binary value, or `null` when it is not one.
 *
 * Realm-agnostic on purpose: `Object.prototype.toString` reports the internal
 * slot, which survives a realm boundary, where `instanceof` does not.
 */
export function asBinary(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object ArrayBuffer]') {
    return Buffer.from(new Uint8Array(value as ArrayBuffer)).toString('base64');
  }
  if (tag === '[object SharedArrayBuffer]') {
    return Buffer.from(new Uint8Array(value as ArrayBufferLike)).toString('base64');
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).toString('base64');
  }
  return null;
}

/** SHA-256 of a string, hex. */
export function forgeSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 of raw bytes, hex - the same rule the product's `sha256Hex` uses. */
export function forgeSha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(value)).digest('hex');
}

// ── The fingerprint ─────────────────────────────────────────────────────────

export interface ForgeFingerprint {
  /** One digest over everything below. */
  readonly digest: string;
  readonly activeGenerationId: string | null;
  readonly generationIds: readonly string[];
  /** `descriptor` per generation, in sorted generation order. */
  readonly descriptors: Readonly<Record<string, string>>;
  /** `store recordId generationId checksum updatedAt canonicalValue` lines. */
  readonly records: readonly string[];
  /** Ordered `[key, value]` pairs from legacy `localStorage`. */
  readonly legacy: readonly string[];
  /** Every raw IndexedDB object-store key currently present, per store. */
  readonly rawStoreKeys: Readonly<Record<string, readonly string[]>>;
  /** Per-store record counts, recomputed rather than read from a descriptor. */
  readonly counts: Readonly<Record<string, number>>;
  /** Byte totals for the attachment blob store, so a swapped blob is visible. */
  readonly blobBytes: number;
}

/**
 * Fingerprint the whole device: the pointer, every generation, every record
 * envelope *and its value's bytes*, every descriptor, the ordered legacy
 * `localStorage`, and the raw IndexedDB keys of every object store.
 *
 * The raw keys matter because a generation-scoped store holds records under
 * `[generationId, recordId]`; an import that wrote into the *active* generation
 * in place would leave the previous generation's fingerprint untouched and only
 * the new generation changed - so both are read.
 */
export async function fingerprintDevice(
  repository: StorageV2Repository,
  databaseName: string,
): Promise<ForgeFingerprint> {
  const activeGenerationId = await repository.readActiveGenerationId();
  const known = new Set<string>();
  if (activeGenerationId !== null) known.add(activeGenerationId);

  // Every generation the registry knows about, discovered through the descriptor
  // records rather than through an API that might filter.
  const generations = await listAllGenerationIds(repository, databaseName);
  for (const id of generations) known.add(id);

  const descriptors: Record<string, string> = {};
  const recordLines: string[] = [];
  const counts: Record<string, number> = {};
  let blobBytes = 0;

  for (const generationId of [...known].sort()) {
    const generation = await repository.readGeneration(generationId);
    descriptors[generationId] = forgeCanonical(generation);
    const snapshot = await repository.readRecords(generationId);
    const stores = snapshot.records as unknown as Record<string, Array<{ recordId: string; generationId: string; checksum: string | null; updatedAt: string; value: unknown }>>;
    for (const store of Object.keys(stores).sort()) {
      const entries = stores[store] ?? [];
      counts[store] = (counts[store] ?? 0) + entries.length;
      for (const entry of entries) {
        recordLines.push(
          `${store} ${entry.recordId} ${entry.generationId} ${entry.checksum ?? ''} ${entry.updatedAt} ${forgeCanonical(entry.value)}`,
        );
        if (store === 'attachmentBlobs') {
          const bytes = (entry.value as { bytes?: ArrayBuffer }).bytes;
          if (bytes) blobBytes += bytes.byteLength;
        }
      }
    }
  }
  recordLines.sort();

  const legacy = readLegacyEntries();
  const rawStoreKeys = await readRawStoreKeys(databaseName);
  const digest = forgeSha256(
    forgeCanonical({
      activeGenerationId,
      generationIds: [...known].sort(),
      descriptors,
      records: recordLines,
      legacy,
      rawStoreKeys,
      counts,
      blobBytes,
    }),
  );

  return {
    digest,
    activeGenerationId,
    generationIds: [...known].sort(),
    descriptors,
    records: recordLines,
    legacy,
    rawStoreKeys,
    counts,
    blobBytes,
  };
}

/** Ordered legacy `localStorage`, byte for byte, keys sorted. */
export function readLegacyEntries(): string[] {
  const store = globalThis.localStorage;
  const out: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index) as string;
    out.push(`${key} ${store.getItem(key) ?? ''}`);
  }
  return out.sort();
}

/**
 * Every generation id that has *any* record under it, including orphans.
 *
 * An abandoned staged generation has no descriptor, so the descriptor scan alone
 * cannot see it - and "a failed import discards the staged generation, leaving
 * nothing behind" is exactly the claim that needs the orphan view.
 */
export async function listAllGenerationIds(
  repository: StorageV2Repository,
  databaseName: string,
): Promise<string[]> {
  void repository;
  const { listMetaRecordIds, listAllRecordGenerations } = await import('./rawIdb');
  const [described, recorded] = await Promise.all([
    listMetaRecordIds(databaseName),
    listAllRecordGenerations(databaseName),
  ]);
  return [...new Set([...described, ...recorded])].sort();
}

/** The raw key list of every object store, read straight out of IndexedDB. */
export async function readRawStoreKeys(databaseName: string): Promise<Record<string, readonly string[]>> {
  const { listEveryStoreKey } = await import('./rawIdb');
  return listEveryStoreKey(databaseName);
}

/** Compare two fingerprints and name what moved, without copying any value. */
export function diffFingerprints(
  before: ForgeFingerprint,
  after: ForgeFingerprint,
): { readonly digestChanged: boolean; readonly lines: readonly string[] } {
  const lines: string[] = [];
  if (before.activeGenerationId !== after.activeGenerationId) {
    lines.push(`activeGenerationId: ${String(before.activeGenerationId)} -> ${String(after.activeGenerationId)}`);
  }
  const beforeRecords = new Set(before.records);
  const afterRecords = new Set(after.records);
  for (const line of after.records) {
    if (!beforeRecords.has(line)) lines.push(`+ ${firstThree(line)}`);
  }
  for (const line of before.records) {
    if (!afterRecords.has(line)) lines.push(`- ${firstThree(line)}`);
  }
  const beforeLegacy = new Set(before.legacy);
  const afterLegacy = new Set(after.legacy);
  for (const line of after.legacy) if (!beforeLegacy.has(line)) lines.push(`+ legacy ${line.split(' ')[0]}`);
  for (const line of before.legacy) if (!afterLegacy.has(line)) lines.push(`- legacy ${line.split(' ')[0]}`);
  for (const generationId of new Set([...before.generationIds, ...after.generationIds])) {
    if (before.descriptors[generationId] === after.descriptors[generationId]) continue;
    const left = before.descriptors[generationId] ?? '<absent>';
    const right = after.descriptors[generationId] ?? '<absent>';
    lines.push(`~ descriptor ${generationId}: ${shortSource(left)} -> ${shortSource(right)}`);
  }
  return { digestChanged: before.digest !== after.digest, lines };
}

/** The identifying prefix of a record line: store, recordId, generationId. */
function firstThree(line: string): string {
  return line.split(' ').slice(0, 3).join(' ');
}

/** A descriptor's `source` and `status`, so a diff says what happened. */
function shortSource(canonical: string): string {
  const source = /"source":"([^"]*)"/.exec(canonical)?.[1] ?? '?';
  const status = /"status":"([^"]*)"/.exec(canonical)?.[1] ?? '?';
  return `${source}/${status}`;
}

// ── The record builders ─────────────────────────────────────────────────────

function emptyValidationState(): Record<string, unknown> {
  return {
    wordCount: 0,
    requiredSectionsPresent: false,
    manualConfirmed: false,
    criterionScores: {
      sectionCompleteness: 0,
      conceptTermCoverage: 0,
      linkReferences: 0,
      recallQuestionQuality: 0,
      clarityReadability: 0,
    },
    failedChecks: [],
    qualityBonus: 0,
    finalPass: false,
  };
}

function room(args: {
  roomId: string;
  topic: string;
  notePath?: string;
  artifactPath?: string;
  noteText?: string;
  artifactMarkdown?: string | null;
  tags?: string[];
  attachments?: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    roomId: args.roomId,
    topic: args.topic,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    state: 'ArtifactCollected',
    notePath: args.notePath ?? `rooms/${args.roomId}/notes.txt`,
    artifactPath: args.artifactPath ?? `rooms/${args.roomId}/artifact.md`,
    noteText: args.noteText ?? '',
    artifactMarkdown: args.artifactMarkdown ?? null,
    validationState: emptyValidationState(),
    reviewPassCount: 1,
    sm2QualityResponse: 4,
    sm2EaseFactor: 2.5,
    sm2IntervalDays: 6,
    sm2NextReviewDate: '2026-03-01T00:00:00.000Z',
    sm2ConsecutiveCorrect: 2,
    tags: args.tags ?? [],
    attachments: args.attachments ?? [],
    ...(args.extra ?? {}),
  };
}

/**
 * `ALPHA`: the subject under test.
 *
 * Every line below is a deliberate attack on the remap policy. The comments name
 * the expected outcome so a failure says which assumption broke.
 */
export function alphaSubject(): SubjectRecordValue {
  const rooms: Record<string, unknown> = {
    // The root room's TOPIC is exactly its own room id. `topic` is a protected text
    // field, so this must survive verbatim - a room topic that happens to equal a
    // room id is the learner's own words.
    [R_ROOT]: room({
      roomId: R_ROOT,
      topic: R_ROOT,
      noteText: `Prose mentioning ${R_SIDE} in a sentence. ${MARKERS.noteText}`,
      artifactMarkdown: `## Artifact\n\n${MARKERS.noteText}\n`,
      tags: [R_SIDE, MARKERS.tag],
      attachments: [
        { attachmentId: ATT_ALPHA, sourceType: 'local', fileName: MARKERS.fileName, mimeType: 'image/png', addedAt: FIXED_NOW },
        { attachmentId: ATT_EXTERNAL, sourceType: 'external', fileName: MARKERS.fileName, mimeType: 'image/png', externalUrl: 'https://example.invalid/ZX.png', altText: MARKERS.altText, addedAt: FIXED_NOW },
      ],
      extra: {
        // UNDECLARED, room id as a VALUE: the whole-token sweep must rewrite it.
        forgeField: {
          lastVisitedRoomId: R_SIDE,
          // A PATH with the room id as a whole segment: must be rewritten.
          breadcrumb: `dungeon/${R_ROOT}/rooms/${R_SIDE}`,
          // PROSE mentioning a room id as a substring: must survive verbatim and
          // be counted in the residual.
          summary: `First reach ${R_SIDE} before the boss room.`,
        },
        // UNDECLARED, room id as an OBJECT KEY: the module header says the
        // residual count covers this class. Object keys are never swept, so this
        // line is the test of that claim.
        forgeLinksByRoom: {
          [R_SIDE]: { kind: 'neighbour', href: `rooms/${R_SIDE}` },
        },
      },
    }),
    [R_SIDE]: room({
      roomId: R_SIDE,
      topic: MARKERS.roomTopic,
      // An artifact path that embeds the room id twice, in two segments.
      notePath: `rooms/${R_ROOT}/notes-${R_SIDE}.txt`,
      artifactPath: `rooms/${R_SIDE}/nested/${R_ROOT}/artifact.md`,
    }),
    [R_DEEP]: room({
      roomId: R_DEEP,
      topic: 'Boss chamber',
      notePath: `rooms/${R_DEEP}/notes.txt`,
      artifactPath: `rooms/${R_DEEP}/artifact.md`,
    }),
  };

  const dungeon: Record<string, unknown> = {
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    // `dungeonId` is the AUTHORITATIVE subject id in the migration path
    // (`migrations.ts`: `snapshot.dungeon.dungeonId || subject.subjectId`), and it
    // is not in the remap module's declared table. Here it agrees with
    // `subjectId`, so a whole-token sweep rewrites it by coincidence.
    dungeonId: ALPHA,
    subjectName: MARKERS.subjectName,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: R_ROOT,
    rooms: [
      { roomId: R_ROOT, topic: R_ROOT, status: 'ArtifactCollected' },
      { roomId: R_SIDE, topic: MARKERS.roomTopic, status: 'ArtifactCollected' },
      { roomId: R_DEEP, topic: 'Boss chamber', status: 'Created' },
    ],
    edges: [
      { fromRoomId: R_ROOT, toRoomId: R_SIDE, relationType: 'prerequisite', createdAt: FIXED_NOW, createdByPhase: 'Creation' },
      { fromRoomId: R_SIDE, toRoomId: R_DEEP, relationType: 'prerequisite', createdAt: FIXED_NOW, createdByPhase: 'Creation' },
      // An edge whose relationType is exactly a room id: a fixed-vocabulary field
      // colliding with an id. It must NOT be rewritten.
      { fromRoomId: R_DEEP, toRoomId: R_ROOT, relationType: R_ROOT, createdAt: FIXED_NOW, createdByPhase: 'Creation' },
    ],
    progression: { xpTotal: 40, rank: 'Scholar', badges: [R_ROOT, MARKERS.tag] },
    // A biome equal to a room id: must NOT be rewritten.
    biome: R_ROOT,
    // The tag index. Its KEYS are tag names (one of which is a room id and must
    // survive); its VALUES are room ids and must be rewritten.
    tagIndex: {
      [R_ROOT]: [R_ROOT, R_SIDE],
      [MARKERS.tag]: [R_DEEP],
    },
  };

  return {
    subjectId: ALPHA,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot: { dungeon, rooms },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } as unknown as SubjectRecordValue;
}

/** `ALPHA` with `dungeonId` deliberately disagreeing with `subjectId`. */
export function alphaSubjectWithStaleDungeonId(): SubjectRecordValue {
  const subject = alphaSubject();
  const snapshot = subject.snapshot as unknown as Record<string, unknown>;
  const dungeon = snapshot.dungeon as Record<string, unknown>;
  return {
    ...subject,
    snapshot: { ...snapshot, dungeon: { ...dungeon, dungeonId: 'subj-alpha-0001-legacy-dungeon' } },
  } as unknown as SubjectRecordValue;
}

/** A second subject that holds the same attachment *bytes* as `ALPHA`. */
export function betaSubject(): SubjectRecordValue {
  const roomId = 'rm-beta-only';
  return {
    subjectId: BETA,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot: {
      dungeon: {
        schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        dungeonId: BETA,
        subjectName: 'Bystander beta',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        phaseState: 'ArchaeologistActive',
        rootRoomId: roomId,
        rooms: [{ roomId, topic: 'Beta only', status: 'Created' }],
        edges: [],
        progression: { xpTotal: 5, rank: 'Novice', badges: [] },
      },
      rooms: {
        [roomId]: room({
          roomId,
          topic: 'Beta only',
          attachments: [
            { attachmentId: ATT_BETA_SHARED, sourceType: 'local', fileName: 'shared.png', mimeType: 'image/png', addedAt: FIXED_NOW },
          ],
        }),
      },
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } as unknown as SubjectRecordValue;
}

/** A third subject, so "unrelated" is plural. */
export function gammaSubject(): SubjectRecordValue {
  const roomId = 'rm-gamma-only';
  return {
    subjectId: GAMMA,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot: {
      dungeon: {
        schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        dungeonId: GAMMA,
        subjectName: 'Bystander gamma',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        phaseState: 'ArchaeologistActive',
        rootRoomId: roomId,
        rooms: [{ roomId, topic: 'Gamma only', status: 'Created' }],
        edges: [],
        progression: { xpTotal: 0, rank: 'Novice', badges: [] },
      },
      rooms: { [roomId]: room({ roomId, topic: 'Gamma only' }) },
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } as unknown as SubjectRecordValue;
}

/**
 * `ALPHA`'s progression record - which also holds `BETA`'s data.
 *
 * Two subjects sharing one progression record is not a fabrication: the storage-v2
 * record key is `record.subjectId`, and the canonical v3 shape is a single
 * `bySubject` map that a legacy install wrote with every subject in it. This is
 * the state that decides whether a replace of `ALPHA` can destroy `BETA`'s
 * progression.
 */
export function alphaProgressionSharingBeta(): ProgressionRecordValue {
  return {
    subjectId: ALPHA,
    sourceVersion: 3,
    rank: 'Scholar',
    xpTotal: 40,
    bySubject: {
      [ALPHA]: {
        xpTotal: 40,
        rank: 'Scholar',
        roomsCleared: 2,
        reviewPasses: 3,
        streakCount: 4,
        collectedNotes: [
          { noteId: 'note-alpha-0001', dungeonId: ALPHA, roomId: R_ROOT, collectedAt: FIXED_NOW, artifactTitle: 'Root note' },
          { noteId: 'note-alpha-0002', dungeonId: ALPHA, roomId: R_SIDE, collectedAt: FIXED_NOW, artifactTitle: 'Side note' },
        ],
        fishCollection: [
          { id: 'fish-alpha-0001', name: 'Pike', rarity: 'common', subjectId: ALPHA, subjectName: MARKERS.subjectName, caughtAt: FIXED_NOW },
          { id: 'fish-alpha-0002', name: 'Eel', rarity: 'rare', subjectId: ALPHA, subjectName: MARKERS.subjectName, caughtAt: FIXED_NOW },
        ],
        inventory: [{ id: 'loot-alpha-0001', name: 'Charm', slot: 'amulet' }],
        equippedItems: [{ id: 'loot-alpha-0002', name: 'Ring', slot: 'finger' }],
        badges: [R_ROOT, MARKERS.tag],
      },
      // BETA's progression, living inside ALPHA's record.
      [BETA]: {
        xpTotal: 11,
        rank: 'Novice',
        roomsCleared: 1,
        reviewPasses: 0,
        streakCount: 1,
        collectedNotes: [{ noteId: 'note-beta-0001', dungeonId: BETA, roomId: 'rm-beta-only', collectedAt: FIXED_NOW, artifactTitle: 'Beta note' }],
        fishCollection: [
          { id: 'fish-beta-0001', name: 'Carp', rarity: 'common', subjectId: BETA, subjectName: 'Bystander beta', caughtAt: FIXED_NOW },
        ],
        inventory: [],
        equippedItems: [],
        badges: [],
      },
    },
    crossSubjectAchievements: ['forge-achievement-one'],
  } as unknown as ProgressionRecordValue;
}

/** `GAMMA`'s own progression record, keyed on its own subject id. */
export function gammaProgression(): ProgressionRecordValue {
  return {
    subjectId: GAMMA,
    sourceVersion: 3,
    rank: 'Novice',
    xpTotal: 0,
    bySubject: {
      [GAMMA]: {
        xpTotal: 0,
        rank: 'Novice',
        roomsCleared: 0,
        reviewPasses: 0,
        streakCount: 0,
        collectedNotes: [],
        fishCollection: [],
        inventory: [],
        equippedItems: [],
        badges: [],
      },
    },
    crossSubjectAchievements: [],
  } as unknown as ProgressionRecordValue;
}

/** Two of `ALPHA`'s sessions, one of them mentioning a room id in prose. */
export function alphaSessions(): SessionRecordValue[] {
  return [
    {
      sessionId: 'sess-alpha-0001',
      subjectId: ALPHA,
      startedAt: FIXED_NOW,
      endedAt: OTHER_NOW,
      roomsVisited: [R_ROOT, R_SIDE],
      notesSubmitted: 1,
      reviewsCompleted: 2,
      xpEarned: 15,
      eventId: 'forge-event-0001',
    },
    {
      sessionId: 'sess-alpha-0002',
      subjectId: ALPHA,
      subjectName: MARKERS.subjectName,
      startedAt: OTHER_NOW,
      endedAt: null,
      roomsVisited: [R_DEEP],
      notesSubmitted: 0,
      reviewsCompleted: 0,
      xpEarned: 0,
      eventId: 'forge-event-0002',
      // A session that is `ALPHA`'s by `subjectId` but records a room that is not
      // in the subject. The export filter is by subject, not by room.
      forgeNote: `Visited ${R_ROOT} twice.`,
    },
  ] as unknown as SessionRecordValue[];
}

/** `BETA`'s session: a session belonging to another subject. */
export function betaSession(): SessionRecordValue {
  return {
    sessionId: 'sess-beta-0001',
    subjectId: BETA,
    startedAt: FIXED_NOW,
    endedAt: OTHER_NOW,
    roomsVisited: ['rm-beta-only'],
    notesSubmitted: 3,
    reviewsCompleted: 1,
    xpEarned: 30,
    eventId: 'forge-event-0003',
  } as unknown as SessionRecordValue;
}

export function alphaAssistance(): AssistanceRecordValue[] {
  return [
    {
      assistanceId: 'assist-alpha-0001',
      mode: 'gentle',
      signals: { hintsShown: 4, timeouts: 1 },
      dismissalCount: 2,
      updatedAt: FIXED_NOW,
    },
  ];
}

export function betaAssistance(): AssistanceRecordValue[] {
  return [
    {
      assistanceId: 'assist-beta-0001',
      mode: 'standard',
      signals: { hintsShown: 9, timeouts: 3 },
      dismissalCount: 0,
      updatedAt: FIXED_NOW,
    },
  ];
}

/** `ALPHA`'s attachment metadata, plus `BETA`'s copy of the shared bytes. */
export function forgeAttachmentMetadata(sharedContentHash: string): AttachmentMetadataRecordValue[] {
  return [
    {
      attachmentId: ATT_ALPHA,
      subjectId: ALPHA,
      roomId: R_ROOT,
      sourceType: 'local',
      mimeType: 'image/png',
      availability: 'stored',
      contentHash: sharedContentHash,
      fileName: MARKERS.fileName,
      altText: MARKERS.altText,
      addedAt: FIXED_NOW,
    },
    {
      attachmentId: ATT_EXTERNAL,
      subjectId: ALPHA,
      roomId: R_SIDE,
      sourceType: 'external',
      mimeType: 'image/png',
      availability: 'external-only',
      contentHash: null,
      fileName: MARKERS.fileName,
      externalUrl: 'https://example.invalid/ZX-external.png',
      altText: MARKERS.altText,
      addedAt: FIXED_NOW,
    },
    {
      attachmentId: ATT_BETA_SHARED,
      subjectId: BETA,
      roomId: 'rm-beta-only',
      sourceType: 'local',
      mimeType: 'image/png',
      availability: 'stored',
      contentHash: sharedContentHash,
      fileName: 'shared.png',
      addedAt: FIXED_NOW,
    },
  ] as unknown as AttachmentMetadataRecordValue[];
}

export function forgeAttachmentBlobs(
  sharedContentHash: string,
  sharedBytes: Uint8Array,
): AttachmentBlobRecordValue[] {
  return [
    {
      attachmentId: ATT_ALPHA,
      contentHash: sharedContentHash,
      bytes: sharedBytes.slice().buffer as ArrayBuffer,
      byteLength: sharedBytes.byteLength,
      storedAt: FIXED_NOW,
    },
    {
      attachmentId: ATT_BETA_SHARED,
      contentHash: sharedContentHash,
      bytes: sharedBytes.slice().buffer as ArrayBuffer,
      byteLength: sharedBytes.byteLength,
      storedAt: FIXED_NOW,
    },
  ] as unknown as AttachmentBlobRecordValue[];
}

export function forgePreferences(): PreferenceRecordValue[] {
  return [
    { preferenceId: 'preference-theme', value: 'cozy', updatedAt: FIXED_NOW },
    { preferenceId: 'preference-locale', value: 'en-GB', updatedAt: FIXED_NOW },
  ] as unknown as PreferenceRecordValue[];
}

export function forgeShortcuts(): ShortcutRecordValue[] {
  return [
    { actionId: 'action-open-map', labelKey: 'shortcut.openMap', key: 'm', ctrlKey: true, shiftKey: false },
  ] as unknown as ShortcutRecordValue[];
}

export function forgeCustomSprites(): CustomSpriteRecordValue[] {
  return [
    { spritePath: 'actors/wizard.svg', kind: 'override', content: '<svg xmlns="http://www.w3.org/2000/svg"/>', updatedAt: FIXED_NOW },
  ] as unknown as CustomSpriteRecordValue[];
}

export function forgeRecovery(): RecoveryRecordValue[] {
  return [
    { kind: 'backup', subjectId: ALPHA, raw: '{"halfWritten":true}', capturedAt: FIXED_NOW },
  ] as unknown as RecoveryRecordValue[];
}

export function forgeReceipt(generationId: string): MigrationReceiptValue {
  const storeNames = [
    'meta',
    'subjects',
    'progression',
    'sessions',
    'preferences',
    'shortcuts',
    'assistance',
    'attachments',
    'customSprites',
    'recovery',
    'migrationReceipts',
  ] as const;
  const recordCounts = {} as Record<string, number>;
  const recordChecksums = {} as Record<string, string>;
  for (const name of storeNames) {
    recordCounts[name] = 0;
    recordChecksums[name] = forgeSha256(`forge-receipt-${name}`);
  }
  return {
    receiptId: 'forge-receipt-0001',
    migrationId: LEGACY_MIGRATION_ID,
    fromStorage: 'legacy-localstorage',
    toStorage: 'storage-v2',
    stagedGenerationId: generationId,
    previousActiveGenerationId: 'forge-prior-0000',
    status: 'activated',
    createdAt: FIXED_NOW,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    subjectSchemaVersions: { [CANONICAL_SUBJECT_SCHEMA_VERSION]: 3 },
    progressionSourceVersions: { '3': 2 },
    recordCounts,
    recordChecksums,
    contentChecksum: forgeSha256('forge-receipt-checksum'),
  } as unknown as MigrationReceiptValue;
}

// ── Assembling the device ───────────────────────────────────────────────────

let databaseCounter = 0;

export function resetLegacyStorageForge(): void {
  globalThis.localStorage.clear();
}

/** Options for the forge, so one gate can vary one thing. */
export interface ForgeOptions {
  /** Replace `ALPHA`'s progression with a record that holds only `ALPHA`. */
  readonly isolateProgression?: boolean;
  /** Give `ALPHA` a `dungeonId` that disagrees with its `subjectId`. */
  readonly staleDungeonId?: boolean;
  /** Omit the `assistance` store entirely. */
  readonly noAssistance?: boolean;
}

export interface ForgedDeviceExtras {
  readonly sharedBytes: Uint8Array;
  readonly sharedContentHash: string;
  readonly expected: GenerationRecordValues;
}

export function forgeRecordValues(
  options: ForgeOptions = {},
): ForgedDeviceExtras {
  const sharedBytes = utf8('forge-shared-image-bytes-ZX');
  const sharedContentHash = forgeSha256Bytes(sharedBytes);
  const alpha = options.staleDungeonId === true ? alphaSubjectWithStaleDungeonId() : alphaSubject();
  const progression = options.isolateProgression === true
    ? (alphaProgressionSharingBeta() as ProgressionRecordValue & { bySubject: Record<string, unknown> })
    : alphaProgressionSharingBeta();
  if (options.isolateProgression === true) {
    const bySubject = progression.bySubject as unknown as Record<string, unknown>;
    delete bySubject[BETA];
  }
  const expected: GenerationRecordValues = {
    subjects: [alpha, betaSubject(), gammaSubject()],
    progression: [progression, gammaProgression()],
    sessions: [...alphaSessions(), betaSession()],
    preferences: forgePreferences(),
    shortcuts: forgeShortcuts(),
    assistance: options.noAssistance === true ? [] : [...alphaAssistance(), ...betaAssistance()],
    attachmentMetadata: forgeAttachmentMetadata(sharedContentHash),
    attachmentBlobs: forgeAttachmentBlobs(sharedContentHash, sharedBytes),
    customSprites: forgeCustomSprites(),
    recovery: forgeRecovery(),
    migrationReceipts: [],
  };
  return { sharedBytes, sharedContentHash, expected };
}

/**
 * Build the device: a prior generation, then the active one, then the legacy
 * mirror the app still writes.
 *
 * Non-vacuity is enforced here rather than assumed: the forged generation is
 * validated through the repository's own `validateGeneration`, and a fixture that
 * the repository would refuse would make every gate built on it meaningless.
 */
export async function forgeDevice(options: ForgeOptions = {}): Promise<ForgedDevice> {
  databaseCounter += 1;
  const databaseName = `forge-phase6-${databaseCounter}-${process.pid}`;
  resetLegacyStorageForge();
  const { sharedBytes, sharedContentHash, expected } = forgeRecordValues(options);
  const priorGenerationId = 'forge-prior-0000';
  const generationId = 'forge-active-0001';

  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(FIXED_NOW),
    idFactory: createDeterministicIdFactory('forge'),
  });

  await repository.stageGeneration({
    generationId: priorGenerationId,
    source: 'legacy-migration',
    records: { subjects: [expected.subjects[0] as SubjectRecordValue] },
  });
  await repository.activateGeneration(priorGenerationId);

  const withReceipt: GenerationRecordValues = {
    ...expected,
    migrationReceipts: [forgeReceipt(generationId)],
  };
  await repository.stageGeneration({
    generationId,
    source: 'legacy-migration',
    parentGenerationId: priorGenerationId,
    records: withReceipt,
  });
  await repository.activateGeneration(generationId);

  // The legacy mirror the app keeps writing while the Phaser fallback exists.
  const legacy = globalThis.localStorage;
  legacy.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([ALPHA, BETA, GAMMA]));
  for (const subject of expected.subjects) {
    legacy.setItem(`knowledge-dungeon:v1:subject:${subject.subjectId}`, JSON.stringify(subject.snapshot));
  }
  legacy.setItem('knowledge-dungeon:v1:activeSubjectId', ALPHA);
  legacy.setItem('knowledge-dungeon:locale', 'en-GB');
  legacy.setItem('knowledge-dungeon:v1:progression', JSON.stringify({ version: 3, bySubject: {}, crossSubjectAchievements: [] }));

  const validation = await repository.validateGeneration(generationId);
  if (!validation.ok) {
    throw new Error(
      `the forged device does not validate: ${validation.problems
        .map((problem) => `${problem.severity}:${problem.scope}:${problem.code}:${problem.count}`)
        .join(',')}`,
    );
  }

  return {
    repository,
    databaseName,
    generationId,
    priorGenerationId,
    sharedBytes,
    sharedContentHash,
    expected: withReceipt,
  };
}

/**
 * The **active** generation's record values.
 *
 * Reads the pointer first, not a remembered id: an import activates a new
 * generation, so a gate that kept reading the id it forged at setup time would be
 * measuring the generation the import replaced.
 */
export async function readActiveValues(device: ForgedDevice): Promise<GenerationRecordValues> {
  const active = await device.repository.readActiveGenerationId();
  if (active === null) throw new Error('no active generation');
  return readValuesOf(device, active);
}

/** One named generation's record values, for rollback-path assertions. */
export async function readValuesOf(
  device: ForgedDevice,
  generationId: string,
): Promise<GenerationRecordValues> {
  const snapshot = await device.repository.readRecords(generationId);
  return {
    subjects: snapshot.records.subjects.map((entry) => entry.value),
    progression: snapshot.records.progression.map((entry) => entry.value),
    sessions: snapshot.records.sessions.map((entry) => entry.value),
    preferences: snapshot.records.preferences.map((entry) => entry.value),
    shortcuts: snapshot.records.shortcuts.map((entry) => entry.value),
    assistance: snapshot.records.assistance.map((entry) => entry.value),
    attachmentMetadata: snapshot.records.attachmentMetadata.map((entry) => entry.value),
    attachmentBlobs: snapshot.records.attachmentBlobs.map((entry) => entry.value),
    customSprites: snapshot.records.customSprites.map((entry) => entry.value),
    recovery: snapshot.records.recovery.map((entry) => entry.value),
    migrationReceipts: snapshot.records.migrationReceipts.map((entry) => entry.value),
  };
}
