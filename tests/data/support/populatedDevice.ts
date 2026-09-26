/**
 * A realistic, populated storage-v2 generation for the Phase 5 data-product gate.
 *
 * Phase 5 exit criterion 1 is "A populated storage-v2 state exports and restores
 * with semantic equality", so the fixture has to be *populated* in the sense the
 * plan means: every store the plan's section 7.3 lists must carry real records,
 * including the awkward ones - unknown app-owned fields at every level, an
 * external-only attachment with no bytes, a custom sprite whose three records
 * share one path, a recovery record, and a migration receipt.
 *
 * Everything is built through the **real** production path: the records go
 * through `openStorageV2Repository`, `stageGeneration`, and `activateGeneration`,
 * so the descriptor, the per-record checksums, and the per-store roll-up
 * checksums are computed by the application rather than asserted by the test. The
 * suite then calls `validateGeneration` and requires it to be clean, which is
 * what makes "realistic" a measured property and not a claim: a fixture with a
 * dangling relationship, a wrong count, or a mismatched content hash would fail
 * its own validation.
 *
 * Legacy `localStorage` is seeded with the same subject set, so "a failed import
 * leaves the legacy key set byte-for-byte unchanged" is an assertion about real
 * key/value bytes rather than about an empty store.
 *
 * Privacy: every value is synthetic and self-describing. The learner-content
 * marker is planted on purpose (see `./marker`) so the absence assertions in the
 * privacy gates cannot be satisfied by an empty surface. The only host named
 * anywhere is the reserved `example.invalid`.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalProgressionShapeFor } from './progressionShape';
import {
  createDeterministicIdFactory,
  fixedClock,
} from '@/services/persistence/v2/database';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import type { RankTier } from '@/core/progression/types';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type AssistanceRecordValue,
  type CustomSpriteRecordValue,
  type MigrationReceiptValue,
  type PreferenceRecordValue,
  type ProgressionRecordValue,
  type RecoveryRecordValue,
  type SessionRecordValue,
  type ShortcutRecordValue,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import {
  MARKER_ARTIFACT_BODY,
  MARKER_ATTACHMENT_ALT_TEXT,
  MARKER_ATTACHMENT_FILE_NAME,
  MARKER_NOTE_BODY,
  MARKER_ROOM_TOPIC,
  MARKER_SPRITE_BODY,
  MARKER_SUBJECT_NAME,
} from './marker';
import { platformSha256 } from './hashes';

// ── Fixture path ───────────────────────────────────────────────────────────

/**
 * The real Phase 0/3 subject fixture this gate re-identifies.
 *
 * Declared before anything that reads it: the branch room id below is read out
 * of this file at module load, so a declaration order that put the path later
 * would fail before a single test ran.
 */
const SUBJECT_FIXTURE_PATH = join(
  process.cwd(),
  'tests/fixtures/persistence/subject/subject-1.1.0-full-unknown-fields.json',
);

// ── Fixed identities and clock ─────────────────────────────────────────────

/** Injected clock, so every record's `updatedAt` is deterministic. */
export const DEVICE_NOW = '2026-09-26T00:00:00.000Z';

/** The generation this fixture stages and activates. */
export const POPULATED_GENERATION_ID = 'gen-data-gate-populated';

/** The generation the fixture writes first, then supersedes, for rollback. */
export const PRIOR_GENERATION_ID = 'gen-data-gate-prior';

export const SUBJECT_IDS = {
  alpha: 'subject-data-gate-alpha',
  beta: 'subject-data-gate-beta',
  gamma: 'subject-data-gate-gamma',
} as const;

/**
 * The second room id in the real fixture.
 *
 * `reidentify` renames only the fixture's *first* room, so the branch room keeps
 * the id the fixture already gave it. Reading that id from the fixture rather
 * than inventing one is what keeps the alpha subject structurally consistent:
 * the attachment metadata, the session's `roomsVisited`, and the room that
 * actually exists all name the same room, so the storage-v2 relationship
 * validator has nothing to complain about.
 */
const FIXTURE_SECOND_ROOM_ID: string = (() => {
  const rooms = Object.keys(baseFixture().rooms);
  return rooms[1] ?? (rooms[0] as string);
})();

export const ROOM_IDS = {
  alphaRoot: 'room-data-gate-alpha-root',
  alphaBranch: FIXTURE_SECOND_ROOM_ID,
  betaRoot: 'room-data-gate-beta-root',
  gammaRoot: 'room-data-gate-gamma-root',
} as const;

export const ATTACHMENT_IDS = {
  /** Shares its bytes with {@link ATTACHMENT_IDS.storedTwo}: one member. */
  storedOne: 'att-data-gate-stored-one',
  storedTwo: 'att-data-gate-stored-two',
  storedThree: 'att-data-gate-stored-three',
  externalOne: 'att-data-gate-external-one',
} as const;

export const SPRITE_PATH = 'characters/synthetic/warden.svg';

/** The reserved host, and the only URL in this suite. */
export const EXTERNAL_ATTACHMENT_URL = 'https://example.invalid/data-gate-external.png';

/** The locale this device is set to. */
export const DEVICE_LOCALE = 'en-GB';

/** Quest state, which the plan lists as its own state.json section. */
export const DEVICE_QUEST_STATE = {
  questId: 'quest-data-gate-synthetic',
  stage: 'artifact-review',
  stepsCompleted: 4,
  stepsTotal: 6,
  lastCheckpointAt: '2026-09-20T12:00:00.000Z',
} as const;

// ── Synthetic binary payloads ──────────────────────────────────────────────

/** A complete 1x1 PNG, byte for byte. Synthetic and self-describing. */
const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

/** A second, different payload, so content addressing has two distinct keys. */
const SYNTHETIC_PNG_VARIANT: readonly number[] = [...SYNTHETIC_PNG.slice(0, -1), 0x83];

/** The one device-local payload that carries the marker in its filename. */
const SYNTHETIC_MARKER_PNG: readonly number[] = [
  ...SYNTHETIC_PNG.slice(0, -4),
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x83,
];

/**
 * A payload produced from a real `Blob`, not from a bare array.
 *
 * The exit criterion is about *bytes*, and a `Blob` is how a learner-supplied
 * image actually reaches this application. Round-tripping a `Blob`'s
 * `arrayBuffer()` is a different code path from round-tripping a `Uint8Array`,
 * and only one of them is the real one.
 */
export async function blobPayload(
  bytes: readonly number[],
  type: string,
): Promise<{ readonly bytes: Uint8Array; readonly contentHash: string }> {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  const buffer = await blob.arrayBuffer();
  const view = new Uint8Array(buffer);
  return { bytes: view, contentHash: platformSha256(view) };
}

// ── Subject snapshots ──────────────────────────────────────────────────────

/**
 * The real Phase 0/3 fixture, re-identified for this gate.
 *
 * It is used rather than a hand-written subject because it carries unknown
 * app-owned fields at five levels (`unknownTopLevelField`, `fixtureDungeonField`,
 * `fixtureRoomField`, `fixtureValidationField`, `fixtureAttachmentField`), and
 * "the import must preserve unknown app-owned fields" can only be tested against
 * a snapshot that actually has some.
 */
function baseFixture(): { dungeon: Record<string, unknown>; rooms: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(SUBJECT_FIXTURE_PATH, 'utf8')) as {
    dungeon: Record<string, unknown>;
    rooms: Record<string, Record<string, unknown>>;
  };
}

/** Re-points a fixture snapshot at one of this gate's subject/room ids. */
function reidentify(
  source: { dungeon: Record<string, unknown>; rooms: Record<string, Record<string, unknown>> },
  options: {
    readonly subjectId: string;
    readonly subjectName: string;
    readonly roomId: string;
    readonly topic: string;
    readonly noteText: string;
    readonly artifactMarkdown: string;
    readonly phaseState: string;
    readonly biome: string;
    readonly tags: readonly string[];
  },
): SubjectSnapshot {
  const dungeon = source.dungeon;
  const rooms = source.rooms;
  const firstRoomId = Object.keys(rooms)[0] as string;

  // Every identifier the rename touches is updated together, because the shared
  // subject validator compares the room's own `roomId`, the `rooms` map key, the
  // dungeon's room list, the root pointer, the edges, and the tag index. Renaming
  // only the room record would produce a subject no implementation can migrate
  // with "no data loss".
  for (const summary of (dungeon.rooms as { roomId: string }[])) {
    if (summary.roomId === firstRoomId) summary.roomId = options.roomId;
  }
  if (dungeon.rootRoomId === firstRoomId) dungeon.rootRoomId = options.roomId;
  for (const edge of (dungeon.edges as { fromRoomId: string; toRoomId: string }[])) {
    if (edge.fromRoomId === firstRoomId) edge.fromRoomId = options.roomId;
    if (edge.toRoomId === firstRoomId) edge.toRoomId = options.roomId;
  }
  for (const roomIds of Object.values((dungeon.tagIndex ?? {}) as Record<string, string[]>)) {
    for (let index = 0; index < roomIds.length; index += 1) {
      if (roomIds[index] === firstRoomId) roomIds[index] = options.roomId;
    }
  }
  const renamedRooms: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(rooms)) {
    renamedRooms[key === firstRoomId ? options.roomId : key] = value;
  }

  const room = renamedRooms[options.roomId] as Record<string, unknown>;
  room.roomId = options.roomId;
  room.topic = options.topic;
  room.noteText = options.noteText;
  room.artifactMarkdown = options.artifactMarkdown;
  room.notePath = `rooms/${options.roomId}/notes.md`;
  room.artifactPath = `rooms/${options.roomId}/artifact.md`;
  room.tags = [...options.tags];

  dungeon.dungeonId = options.subjectId;
  dungeon.subjectName = options.subjectName;
  dungeon.phaseState = options.phaseState;
  dungeon.biome = options.biome;
  dungeon.tagIndex = { [options.tags[0] as string]: [options.roomId] };

  // Every other top-level key is carried through untouched. The fixture declares
  // `unknownTopLevelField` for exactly this reason, and an unknown field that the
  // fixture itself dropped would make the gate's preservation claim untestable.
  return {
    ...source,
    dungeon: dungeon as unknown as SubjectSnapshot['dungeon'],
    rooms: renamedRooms as unknown as SubjectSnapshot['rooms'],
  } as unknown as SubjectSnapshot;
}

// ── The populated device ───────────────────────────────────────────────────

export interface PopulatedDevice {
  readonly repository: StorageV2Repository;
  readonly databaseName: string;
  readonly generationId: string;
  readonly priorGenerationId: string;
  /** The record values the generation was staged from, in staging order. */
  readonly staged: GenerationRecordValues;
  /** Real payload bytes, keyed by the attachment that owns them. */
  readonly payloadBytes: ReadonlyMap<string, Uint8Array>;
  /** Payload bytes shared by two attachment ids, for content addressing. */
  readonly duplicatePayloadAttachmentIds: readonly string[];
  /** The legacy key set a real device of this shape would hold. */
  readonly legacyKeys: ReadonlyMap<string, string>;
  /** Per-store record counts the gate asserts against. */
  readonly expectedRecordCounts: Readonly<Record<string, number>>;
}

/** Every subject record, in a fixed order. */
function subjectRecords(): SubjectRecordValue[] {
  const alpha = reidentify(baseFixture(), {
    subjectId: SUBJECT_IDS.alpha,
    subjectName: MARKER_SUBJECT_NAME,
    roomId: ROOM_IDS.alphaRoot,
    topic: MARKER_ROOM_TOPIC,
    noteText: MARKER_NOTE_BODY,
    artifactMarkdown: MARKER_ARTIFACT_BODY,
    phaseState: 'ScribeComplete',
    biome: 'cozy-hearth',
    tags: ['synthetic-tag', 'data-gate-tag'],
  });
  const beta = reidentify(baseFixture(), {
    subjectId: SUBJECT_IDS.beta,
    subjectName: 'Synthetic Data Gate Subject Beta',
    roomId: ROOM_IDS.betaRoot,
    topic: 'Synthetic Beta Root Topic',
    noteText: 'Synthetic beta note body.',
    artifactMarkdown: '# Synthetic beta artifact\n',
    phaseState: 'ArchaeologistActive',
    biome: 'cozy-library',
    tags: ['synthetic-tag'],
  });
  const gamma = reidentify(baseFixture(), {
    subjectId: SUBJECT_IDS.gamma,
    subjectName: 'Synthetic Data Gate Subject Gamma',
    roomId: ROOM_IDS.gammaRoot,
    topic: 'Synthetic Gamma Root Topic',
    noteText: 'Synthetic gamma note body.',
    artifactMarkdown: '# Synthetic gamma artifact\n',
    phaseState: 'CreatorComplete',
    biome: 'cozy-meadow',
    tags: ['data-gate-tag'],
  });

  // The alpha subject owns the marker's attachment, and shares one payload with
  // `att-data-gate-stored-two` so content addressing has something to collapse.
  // Every call above passes a *fresh* fixture read, so no two subjects can share a
  // mutated object.
  //
  // Each room keeps the fixture's own attachment and *adds* this gate's, because
  // the fixture's attachment carries the fifth unknown-field site
  // (`fixtureAttachmentField`) and replacing the array would delete it - which is
  // exactly the loss this gate claims the product must not make.
  const alphaRoot = alpha.rooms[ROOM_IDS.alphaRoot] as unknown as {
    attachments: Record<string, unknown>[];
  };
  const alphaBranch = alpha.rooms[ROOM_IDS.alphaBranch] as unknown as {
    attachments: Record<string, unknown>[];
  };
  alphaRoot.attachments = [
    ...alphaRoot.attachments,
    {
      attachmentId: ATTACHMENT_IDS.storedOne,
      sourceType: 'local',
      fileName: MARKER_ATTACHMENT_FILE_NAME,
      mimeType: 'image/png',
      altText: MARKER_ATTACHMENT_ALT_TEXT,
      addedAt: DEVICE_NOW,
    },
  ];
  alphaBranch.attachments = [
    ...alphaBranch.attachments,
    {
      attachmentId: ATTACHMENT_IDS.storedTwo,
      sourceType: 'local',
      fileName: 'synthetic-data-gate-second-copy.png',
      mimeType: 'image/png',
      altText: 'synthetic alt text for the duplicate payload',
      addedAt: DEVICE_NOW,
    },
  ];

  const betaRoot = beta.rooms[ROOM_IDS.betaRoot] as unknown as {
    attachments: Record<string, unknown>[];
  };
  betaRoot.attachments = [
    ...betaRoot.attachments,
    {
      attachmentId: ATTACHMENT_IDS.externalOne,
      sourceType: 'external',
      fileName: 'synthetic-data-gate-external.png',
      mimeType: 'image/png',
      externalUrl: EXTERNAL_ATTACHMENT_URL,
      altText: 'synthetic external alt text',
      addedAt: DEVICE_NOW,
    },
  ];

  const gammaRoot = gamma.rooms[ROOM_IDS.gammaRoot] as unknown as {
    attachments: Record<string, unknown>[];
  };
  gammaRoot.attachments = [
    ...gammaRoot.attachments,
    {
      attachmentId: ATTACHMENT_IDS.storedThree,
      sourceType: 'local',
      fileName: 'synthetic-data-gate-variant.png',
      mimeType: 'image/png',
      altText: 'synthetic alt text for the variant payload',
      addedAt: DEVICE_NOW,
    },
  ];

  const stamp = (subjectId: string, snapshot: SubjectSnapshot): SubjectRecordValue => ({
    subjectId,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot,
    createdAt: '2026-01-04T03:04:05.000Z',
    updatedAt: DEVICE_NOW,
  });

  return [
    stamp(SUBJECT_IDS.alpha, alpha),
    stamp(SUBJECT_IDS.beta, beta),
    stamp(SUBJECT_IDS.gamma, gamma),
  ];
}

/** One progression record per subject, with the full canonical payload. */
function progressionRecords(): ProgressionRecordValue[] {
  // `rank` is the engine's own tier vocabulary, so the values are the real ones
  // rather than invented strings: a progression record whose rank the engine would
  // re-derive differently is not a realistic fixture.
  const shapes: ReadonlyArray<{
    readonly subjectId: string;
    readonly subjectName: string;
    readonly xpTotal: number;
    readonly rank: RankTier;
    readonly badges: number;
    readonly fish: number;
    readonly reviews: number;
  }> = [
    {
      subjectId: SUBJECT_IDS.alpha,
      subjectName: MARKER_SUBJECT_NAME,
      xpTotal: 1480,
      rank: 'Scholar',
      badges: 7,
      fish: 3,
      reviews: 5,
    },
    {
      subjectId: SUBJECT_IDS.beta,
      subjectName: 'Synthetic Data Gate Subject Beta',
      xpTotal: 620,
      rank: 'Novice',
      badges: 3,
      fish: 1,
      reviews: 2,
    },
    {
      subjectId: SUBJECT_IDS.gamma,
      subjectName: 'Synthetic Data Gate Subject Gamma',
      xpTotal: 90,
      rank: 'Novice',
      badges: 0,
      fish: 0,
      reviews: 0,
    },
  ];
  return shapes.map((shape) => ({
    subjectId: shape.subjectId,
    sourceVersion: 3 as const,
    rank: shape.rank,
    xpTotal: shape.xpTotal,
    bySubject: {
      [shape.subjectId]: canonicalProgressionShapeFor({
        subjectId: shape.subjectId,
        subjectName: shape.subjectName,
        xpTotal: shape.xpTotal,
        rank: shape.rank,
        badgeCount: shape.badges,
        fishCount: shape.fish,
        reviewPasses: shape.reviews,
      }),
    },
    crossSubjectAchievements: ['achievement-data-gate-first-subject', 'achievement-data-gate-fishing'],
  }));
}

/** Four sessions, with the opaque event id that makes replay idempotent. */
function sessionRecords(): SessionRecordValue[] {
  const base = {
    startedAt: '2026-09-18T09:00:00.000Z',
    endedAt: '2026-09-18T09:42:00.000Z',
    notesSubmitted: 2,
    reviewsCompleted: 1,
    xpEarned: 120,
  };
  return [
    {
      sessionId: 'session-data-gate-0001',
      subjectId: SUBJECT_IDS.alpha,
      eventId: 'event-data-gate-0001',
      ...base,
      roomsVisited: [ROOM_IDS.alphaRoot, ROOM_IDS.alphaBranch],
    },
    {
      sessionId: 'session-data-gate-0002',
      subjectId: SUBJECT_IDS.alpha,
      eventId: 'event-data-gate-0002',
      startedAt: '2026-09-19T18:30:00.000Z',
      endedAt: '2026-09-19T19:05:00.000Z',
      roomsVisited: [ROOM_IDS.alphaRoot],
      notesSubmitted: 1,
      reviewsCompleted: 2,
      xpEarned: 180,
    },
    {
      sessionId: 'session-data-gate-0003',
      subjectId: SUBJECT_IDS.beta,
      eventId: 'event-data-gate-0003',
      ...base,
      roomsVisited: [ROOM_IDS.betaRoot],
    },
    {
      sessionId: 'session-data-gate-0004',
      subjectId: SUBJECT_IDS.gamma,
      eventId: 'event-data-gate-0004',
      startedAt: '2026-09-21T07:15:00.000Z',
      endedAt: null,
      roomsVisited: [],
      notesSubmitted: 0,
      reviewsCompleted: 0,
      xpEarned: 0,
    },
  ];
}

/** Preferences, locale, and quest state, as three real preference records. */
function preferenceRecords(): PreferenceRecordValue[] {
  return [
    {
      preferenceId: 'graphics',
      value: { graphicsMode: 'rpg', colorTheme: 'aurora', activeSpritePack: null },
      updatedAt: DEVICE_NOW,
    },
    { preferenceId: 'locale', value: DEVICE_LOCALE, updatedAt: DEVICE_NOW },
    { preferenceId: 'questState', value: DEVICE_QUEST_STATE, updatedAt: DEVICE_NOW },
  ];
}

function shortcutRecords(): ShortcutRecordValue[] {
  return [
    { actionId: 'toggle-map', labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false },
    { actionId: 'toggle-help', labelKey: 'shortcuts.toggleHelp', key: '/', ctrlKey: false, shiftKey: false },
    {
      actionId: 'toggle-info-panel',
      labelKey: 'shortcuts.toggleInfoPanel',
      key: 'i',
      ctrlKey: true,
      shiftKey: false,
    },
  ];
}

function assistanceRecord(): AssistanceRecordValue {
  return {
    assistanceId: 'assistance-data-gate-0001',
    mode: 'gentle',
    signals: { hintRequests: 4, validationRetries: 2, idleSeconds: 310 },
    dismissalCount: 1,
    updatedAt: DEVICE_NOW,
  };
}

/** Three custom-sprite records sharing one path, which is the real shape. */
function customSpriteRecords(): CustomSpriteRecordValue[] {
  return [
    { spritePath: SPRITE_PATH, kind: 'override', content: MARKER_SPRITE_BODY, updatedAt: DEVICE_NOW },
    {
      spritePath: SPRITE_PATH,
      kind: 'anim',
      content: JSON.stringify(
        {
          schema: 'data-gate-anim-1',
          frames: [
            { name: 'idle-0', durationMs: 420 },
            { name: 'idle-1', durationMs: 380 },
            { name: 'idle-2', durationMs: 460 },
          ],
          loop: true,
        },
        null,
        2,
      ),
      updatedAt: DEVICE_NOW,
    },
    {
      spritePath: SPRITE_PATH,
      kind: 'original',
      content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
      updatedAt: DEVICE_NOW,
    },
  ];
}

/** A backup record and an unindexed-subject record, the two real kinds here. */
function recoveryRecords(): RecoveryRecordValue[] {
  return [
    {
      kind: 'backup',
      subjectId: SUBJECT_IDS.gamma,
      raw: '{"synthetic":"data-gate-recovery-backup-payload"}',
      capturedAt: DEVICE_NOW,
    },
    {
      kind: 'unindexed-subject',
      subjectId: 'subject-data-gate-unindexed',
      raw: '{"synthetic":"data-gate-unindexed-subject-payload"}',
      capturedAt: DEVICE_NOW,
    },
  ];
}

function migrationReceipt(generationId: string): MigrationReceiptValue {
  return {
    receiptId: 'receipt-data-gate-0001',
    migrationId: 'legacy-localstorage-to-storage-v2',
    fromStorage: 'legacy-localstorage',
    toStorage: 'storage-v2',
    stagedGenerationId: generationId,
    previousActiveGenerationId: null,
    status: 'activated',
    createdAt: DEVICE_NOW,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    subjectSchemaVersions: { [CANONICAL_SUBJECT_SCHEMA_VERSION]: 3 },
    progressionSourceVersions: { '3': 3 },
    recordCounts: {
      meta: 0,
      subjects: 3,
      progression: 3,
      sessions: 4,
      preferences: 3,
      shortcuts: 3,
      assistance: 1,
      attachments: 6,
      customSprites: 3,
      recovery: 2,
      migrationReceipts: 1,
    },
    recordChecksums: {
      meta: '',
      subjects: '',
      progression: '',
      sessions: '',
      preferences: '',
      shortcuts: '',
      assistance: '',
      attachments: '',
      customSprites: '',
      recovery: '',
      migrationReceipts: '',
    },
    contentChecksum: '0'.repeat(64),
  };
}

/** Attachment metadata and blob records, with the real payload bytes. */
function attachmentRecords(payloads: {
  readonly one: Uint8Array;
  readonly oneHash: string;
  readonly three: Uint8Array;
  readonly threeHash: string;
}): {
  readonly metadata: AttachmentMetadataRecordValue[];
  readonly blobs: AttachmentBlobRecordValue[];
} {
  const stored = (
    attachmentId: string,
    subjectId: string,
    roomId: string,
    fileName: string,
    contentHash: string,
  ): AttachmentMetadataRecordValue => ({
    attachmentId,
    subjectId,
    roomId,
    sourceType: 'local',
    mimeType: 'image/png',
    availability: 'stored',
    contentHash,
    fileName,
    altText: 'synthetic attachment alt text',
    addedAt: DEVICE_NOW,
  });

  const metadata: AttachmentMetadataRecordValue[] = [
    stored(
      ATTACHMENT_IDS.storedOne,
      SUBJECT_IDS.alpha,
      ROOM_IDS.alphaRoot,
      MARKER_ATTACHMENT_FILE_NAME,
      payloads.oneHash,
    ),
    stored(
      ATTACHMENT_IDS.storedTwo,
      SUBJECT_IDS.alpha,
      ROOM_IDS.alphaBranch,
      'synthetic-data-gate-second-copy.png',
      payloads.oneHash,
    ),
    stored(
      ATTACHMENT_IDS.storedThree,
      SUBJECT_IDS.gamma,
      ROOM_IDS.gammaRoot,
      'synthetic-data-gate-variant.png',
      payloads.threeHash,
    ),
    {
      // No bytes, no hash, and a user-supplied URL that is never dereferenced.
      attachmentId: ATTACHMENT_IDS.externalOne,
      subjectId: SUBJECT_IDS.beta,
      roomId: ROOM_IDS.betaRoot,
      sourceType: 'external',
      mimeType: 'image/png',
      availability: 'external-only',
      contentHash: null,
      fileName: 'synthetic-data-gate-external.png',
      externalUrl: EXTERNAL_ATTACHMENT_URL,
      altText: 'synthetic external alt text',
      addedAt: DEVICE_NOW,
    },
  ];

  const blobFor = (attachmentId: string, bytes: Uint8Array, contentHash: string): AttachmentBlobRecordValue => ({
    attachmentId,
    contentHash,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    byteLength: bytes.length,
    storedAt: DEVICE_NOW,
  });

  return {
    metadata,
    blobs: [
      blobFor(ATTACHMENT_IDS.storedOne, payloads.one, payloads.oneHash),
      blobFor(ATTACHMENT_IDS.storedTwo, payloads.one, payloads.oneHash),
      blobFor(ATTACHMENT_IDS.storedThree, payloads.three, payloads.threeHash),
    ],
  };
}

/** The legacy key set a device of this shape really holds. */
function legacyKeys(subjects: readonly SubjectRecordValue[]): Map<string, string> {
  const keys = new Map<string, string>();
  keys.set(
    'knowledge-dungeon:v1:subjects',
    JSON.stringify(subjects.map((subject) => subject.subjectId)),
  );
  for (const subject of subjects) {
    keys.set(`knowledge-dungeon:v1:subject:${subject.subjectId}`, JSON.stringify(subject.snapshot));
  }
  keys.set('knowledge-dungeon:v1:activeSubjectId', SUBJECT_IDS.alpha);
  keys.set(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({
      version: 3,
      bySubject: Object.fromEntries(
        progressionRecords().map((record) => [record.subjectId, record.bySubject[record.subjectId]]),
      ),
      crossSubjectAchievements: ['achievement-data-gate-first-subject'],
    }),
  );
  keys.set(
    'knowledge-dungeon:session:preferences',
    JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'aurora', activeSpritePack: null }),
  );
  keys.set(
    'knowledge-dungeon:session:shortcuts',
    JSON.stringify(
      shortcutRecords().map((shortcut) => ({
        labelKey: shortcut.labelKey,
        key: shortcut.key,
        ctrlKey: shortcut.ctrlKey,
        shiftKey: shortcut.shiftKey,
      })),
    ),
  );
  keys.set(
    'knowledge-dungeon:v1:sessions',
    JSON.stringify(
      sessionRecords().map((session) => ({
        sessionId: session.sessionId,
        subjectId: session.subjectId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        roomsVisited: session.roomsVisited,
        notesSubmitted: session.notesSubmitted,
        reviewsCompleted: session.reviewsCompleted,
        xpEarned: session.xpEarned,
      })),
    ),
  );
  keys.set('knowledge-dungeon:locale', DEVICE_LOCALE);
  return keys;
}

/**
 * Stage and activate a realistic populated generation, and seed the legacy keys.
 *
 * One call per test, with a unique database name, because IndexedDB is
 * per-database and `fake-indexeddb` keeps every open database alive for the
 * lifetime of the test file.
 */
export async function createPopulatedDevice(
  databaseName: string,
): Promise<PopulatedDevice> {
  const { bytes: pngBytes, contentHash: pngHash } = await blobPayload(SYNTHETIC_PNG, 'image/png');
  const { bytes: variantBytes, contentHash: variantHash } = await blobPayload(
    SYNTHETIC_PNG_VARIANT,
    'image/png',
  );
  // The marker payload is intentionally *not* stored on this device: the marker
  // has to appear in a filename, not in bytes the gate then compares.
  void SYNTHETIC_MARKER_PNG;

  const subjects = subjectRecords();
  const progression = progressionRecords();
  const sessions = sessionRecords();
  const preferences = preferenceRecords();
  const shortcuts = shortcutRecords();
  const assistance = [assistanceRecord()];
  const customSprites = customSpriteRecords();
  const recovery = recoveryRecords();
  const attachments = attachmentRecords({
    one: pngBytes,
    oneHash: pngHash,
    three: variantBytes,
    threeHash: variantHash,
  });

  const staged: GenerationRecordValues = {
    subjects,
    progression,
    sessions,
    preferences,
    shortcuts,
    assistance,
    attachmentMetadata: attachments.metadata,
    attachmentBlobs: attachments.blobs,
    customSprites,
    recovery,
    migrationReceipts: [migrationReceipt(POPULATED_GENERATION_ID)],
  };

  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(DEVICE_NOW),
    idFactory: createDeterministicIdFactory('data-gate'),
  });

  // A prior generation, activated and then superseded, so "the previous
  // generation is retained for rollback" has something real to retain.
  await repository.stageGeneration({
    generationId: PRIOR_GENERATION_ID,
    source: 'legacy-migration',
    records: { subjects: [subjects[0] as SubjectRecordValue] },
  });
  await repository.activateGeneration(PRIOR_GENERATION_ID);

  await repository.stageGeneration({
    generationId: POPULATED_GENERATION_ID,
    source: 'local-edit',
    parentGenerationId: PRIOR_GENERATION_ID,
    records: staged,
  });
  await repository.activateGeneration(POPULATED_GENERATION_ID);

  const keys = legacyKeys(subjects);
  for (const [key, value] of keys) window.localStorage.setItem(key, value);

  return {
    repository,
    databaseName,
    generationId: POPULATED_GENERATION_ID,
    priorGenerationId: PRIOR_GENERATION_ID,
    staged,
    payloadBytes: new Map([
      [ATTACHMENT_IDS.storedOne, pngBytes],
      [ATTACHMENT_IDS.storedTwo, pngBytes],
      [ATTACHMENT_IDS.storedThree, variantBytes],
    ]),
    duplicatePayloadAttachmentIds: [ATTACHMENT_IDS.storedOne, ATTACHMENT_IDS.storedTwo],
    legacyKeys: keys,
    expectedRecordCounts: {
      meta: 0,
      subjects: 3,
      progression: 3,
      sessions: 4,
      preferences: 3,
      shortcuts: 3,
      assistance: 1,
      attachments: 7,
      customSprites: 3,
      recovery: 2,
      migrationReceipts: 1,
    },
  };
}

/** Clears the legacy store. IndexedDB is per-database, so it needs no reset. */
export function resetLegacyStorage(): void {
  window.localStorage.clear();
}
