/**
 * Independent Phase 5 verification harness.
 *
 * This is written by the *verifier*, not by the implementer, and it deliberately
 * shares no code with `tests/data/support/`. Everything here is built through the
 * real production path (`openStorageV2Repository` -> `stageGeneration` ->
 * `activateGeneration`), and every value is synthetic. The only host named
 * anywhere in this directory is the reserved `example.invalid`.
 *
 * Three properties this harness is built for:
 *
 * 1. **The device fingerprint is total and provably able to move.** It encodes
 *    every `meta` row, every record envelope in every store (key, recordId,
 *    checksum, updatedAt, and the value with binary fields hex-encoded), the
 *    active pointer, and the whole ordered `localStorage` key/value set. Binary
 *    attachment bytes are hex-encoded by *this* file, not by the application's
 *    canonical serializer, so the fingerprint cannot inherit a gap in it.
 * 2. **The comparator is field-by-field and provably able to fail.** A real
 *    difference is a list of paths, not a boolean.
 * 3. **The fixtures are nastier than the rails' own.** Every level carries an
 *    unknown app-owned field, the rooms include an empty subject and a one-room
 *    subject, attachments include a zero-length payload, a payload that is
 *    shared by two records, a payload differing only in its last byte, a large
 *    payload, an external-only record, and a record whose declared hash
 *    disagrees with the bytes on the device.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository, type StorageV2Repository } from '@/services/persistence/v2/repository';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import { sha256Hex } from '@/services/persistence/v2/checksum';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type MigrationReceiptValue,
} from '@/services/persistence/v2/schema';

// ── The real Phase 0 subject fixture ────────────────────────────────────────

export const PHASE0_FIXTURE_PATH = join(
  process.cwd(),
  'tests/fixtures/persistence/subject/subject-1.1.0-full-unknown-fields.json',
);

/** The fixture's own rooms, read at module load. */
export function phase0Fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(PHASE0_FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
}

// ── Distinctive synthetic markers (independent of the rails' marker set) ────

export const VERIFIER_MARKERS = {
  subjectName: 'ZZ-verifier-subject-name-9f2c',
  roomTopic: 'ZZ-verifier-room-topic-4a71',
  noteBody: 'ZZ-verifier-note-body-77bd',
  attachmentFileName: 'zz-verifier-attachment-name-3ce5.png',
  attachmentAltText: 'ZZ-verifier-attachment-alt-text-b204',
  externalUrl: 'https://pictures.example.invalid/zz-verifier-remote.png',
  spriteBody: '<svg data-verifier="ZZ-verifier-sprite-body-e1d7"><path d="M0 0h1v1z"/></svg>',
  recoveryRaw: '{"ZZ-verifier-recovery-raw-6b90": not-valid-json ☃}',
} as const;

/** Every marker, as one list, for a single "none of these appears" assertion. */
export const ALL_VERIFIER_MARKERS: readonly string[] = Object.values(VERIFIER_MARKERS).filter(
  (value) => !value.includes('example.invalid'),
);

// ── Bytes helpers ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

export function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // The test realm's own constructor, so the value is an `ArrayBuffer` here and
  // a structurally-equal one everywhere else.
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

export function fromArrayBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hashOf(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** Node's own SHA-256, so the gate's digest is not the only witness. */
export async function nodeHashOf(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

// ── The device ─────────────────────────────────────────────────────────────

export const VERIFIER_NOW = '2026-09-26T12:00:00.000Z';
export const VERIFIER_RESTORE_NOW = '2026-09-27T12:00:00.000Z';

export const VERIFIER_GENERATION = 'gen-verifier-0001';
export const VERIFIER_PRIOR_GENERATION = 'gen-verifier-0000';

/**
 * A generation label distinct from the default, so a target device never already
 * holds the label an archive names - which is the case the importer's
 * "adopt the archive's own label when it is free" rule is about.
 */
export function otherGenerationLabel(): { generationId: string; priorGenerationId: string } {
  otherLabelCounter += 1;
  return {
    generationId: `gen-verifier-alt-${otherLabelCounter}`,
    priorGenerationId: `gen-verifier-altp-${otherLabelCounter}`,
  };
}

let otherLabelCounter = 0;

export const SUBJECT = {
  /** No rooms at all. */
  empty: 'subject-verifier-empty',
  /** Exactly one room, and nothing else. */
  single: 'subject-verifier-single',
  /** The Phase 0 fixture, re-identified, with every unknown field kept. */
  rich: 'subject-verifier-rich',
  /** Unicode and emoji in the name, the topic, the note, and a tag. */
  unicode: 'subject-verifier-ünïcødé-🚀',
} as const;

export const ROOM_IDS: Readonly<Record<string, string>> = {
  'room-phase0-v110-full-root': 'room-verifier-phase0-root',
  'room-phase0-v110-full-branch': 'room-verifier-phase0-branch',
};

export const ATTACHMENT = {
  /** Real bytes, hash agrees. */
  stored: 'att-verifier-stored',
  /** Byte-for-byte the same payload as {@link ATTACHMENT.stored}. */
  duplicatePayload: 'att-verifier-duplicate',
  /** Differs from {@link ATTACHMENT.stored} only in its last byte. */
  lastByteOnly: 'att-verifier-lastbyte',
  /** Zero-length payload. */
  empty: 'att-verifier-zerolen',
  /** A large payload (256 KiB of a repeating pattern). */
  large: 'att-verifier-large',
  /** `stored` metadata whose declared hash the device's bytes do not satisfy. */
  hashDisagrees: 'att-verifier-hash-disagrees',
  /** A user-supplied external URL, never downloaded. */
  external: 'att-verifier-external',
  /** `external` source type, but a hash is declared and bytes are present. */
  externalWithBytes: 'att-verifier-external-with-bytes',
} as const;

export const SPRITE_PATH = 'ui/villager/verifier-sprite.svg';

export interface VerifierPayloads {
  readonly stored: Uint8Array;
  readonly lastByteOnly: Uint8Array;
  readonly large: Uint8Array;
  readonly hashDisagrees: Uint8Array;
  readonly externalWithBytes: Uint8Array;
}

export interface VerifierDevice {
  readonly repository: StorageV2Repository;
  readonly generationId: string;
  readonly priorGenerationId: string;
  /** Real bytes for the ids the device actually holds. */
  readonly payloadBytes: ReadonlyMap<string, Uint8Array>;
  readonly payloads: VerifierPayloads;
  /** Every record value the device staged, verbatim, before the product saw it. */
  readonly records: GenerationRecordValues;
  /** A second, *empty* device: no attachments, no sprites, no receipts. */
  readonly empty: boolean;
  close(): void;
}

function largePayload(): Uint8Array {
  const size = 256 * 1024;
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) out[index] = (index * 7 + (index >> 11)) & 0xff;
  return out;
}

function richSubject(): Record<string, unknown> {
  const fixture = phase0Fixture();
  const rooms = fixture.rooms as Record<string, Record<string, unknown>>;
  const [firstRoomId] = Object.keys(rooms);
  const reIdentified: Record<string, Record<string, unknown>> = {};
  for (const [roomId, room] of Object.entries(rooms)) {
    reIdentified[ROOM_IDS[roomId] ?? roomId] = {
      ...room,
      roomId: ROOM_IDS[roomId] ?? roomId,
      // One more unknown field, at a level the fixture does not cover.
      verifierRoomField: 'ZZ-verifier-unknown-room-field',
      attachments: room.attachments,
    };
  }
  return {
    subjectId: SUBJECT.rich,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: VERIFIER_NOW,
    updatedAt: VERIFIER_NOW,
    verifierSubjectField: 'ZZ-verifier-unknown-subject-field',
    snapshot: {
      ...fixture,
      // The fixture's own top-level unknown field, plus a verifier one.
      verifierSnapshotField: 'ZZ-verifier-unknown-snapshot-field',
      dungeon: {
        ...(fixture.dungeon as Record<string, unknown>),
        // The room summaries and the root room id are re-identified with the
        // rooms, so the fixture stays internally consistent.
        rootRoomId: ROOM_IDS[String((fixture.dungeon as { rootRoomId: string }).rootRoomId)] ??
          (fixture.dungeon as { rootRoomId: string }).rootRoomId,
        rooms: ((fixture.dungeon as { rooms: Array<Record<string, unknown>> }).rooms ?? []).map((summary) => ({
          ...summary,
          roomId: ROOM_IDS[String(summary.roomId)] ?? String(summary.roomId),
        })),
        verifierDungeonField: 'ZZ-verifier-unknown-dungeon-field',
        edges: [
          {
            fromRoomId: ROOM_IDS[firstRoomId as string] ?? firstRoomId as string,
            toRoomId:
              ROOM_IDS[Object.keys(rooms)[1] ?? (firstRoomId as string)] ??
              (Object.keys(rooms)[1] ?? (firstRoomId as string)),
            kind: 'door',
            verifierEdgeField: 'ZZ-verifier-unknown-edge-field',
          },
        ],
      },
      rooms: reIdentified,
    },
  };
}

function unicodeSubject(): Record<string, unknown> {
  return {
    subjectId: SUBJECT.unicode,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: VERIFIER_NOW,
    updatedAt: VERIFIER_NOW,
    snapshot: {
      dungeon: {
        schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        dungeonId: 'dungeon-verifier-unicode',
        subjectName: 'Ünïcødé Sübject 🚀',
        rootRoomId: 'room-verifier-unicode',
        phaseState: 'ArchaeologistActive',
        rooms: [{ roomId: 'room-verifier-unicode', topic: VERIFIER_MARKERS.roomTopic }],
        verifierDungeonField: 'ZZ-verifier-unknown-dungeon-field',
      },
      rooms: {
        'room-verifier-unicode': {
          roomId: 'room-verifier-unicode',
          topic: VERIFIER_MARKERS.roomTopic,
          createdAt: VERIFIER_NOW,
          updatedAt: VERIFIER_NOW,
          state: 'ArtifactCollected',
          notePath: 'rooms/room-verifier-unicode/notes.md',
          artifactPath: 'rooms/room-verifier-unicode/artifact.md',
          reviewPassCount: 3,
          attachments: [],
          noteText: VERIFIER_MARKERS.noteBody,
          artifactMarkdown: '# Artifact 🗝️\n\nünïcødé artifact ☃',
          validationState: {
            wordCount: 3,
            requiredSectionsPresent: true,
            manualConfirmed: false,
            criterionScores: {
              sectionCompleteness: 4,
              conceptTermCoverage: 3,
              linkReferences: 2,
              recallQuestionQuality: 5,
              clarityReadability: 4,
            },
            failedChecks: ['clarityReadability'],
            qualityBonus: 2,
            finalPass: false,
            verifierValidationField: 'ZZ-verifier-unknown-validation-field',
          },
          sm2QualityResponse: 1,
          sm2EaseFactor: 1.7,
          sm2IntervalDays: 1,
          sm2NextReviewDate: '2026-09-28T00:00:00.000Z',
          sm2ConsecutiveCorrect: 0,
          tags: ['synthetic-tag', 'ZZ-verifier-tag-🚀', 'ünïcødé'],
          verifierRoomField: 'ZZ-verifier-unknown-room-field',
        },
      },
    },
  };
}

function singleRoomSubject(): Record<string, unknown> {
  return {
    subjectId: SUBJECT.single,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: VERIFIER_NOW,
    updatedAt: VERIFIER_NOW,
    snapshot: {
      dungeon: {
        schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        dungeonId: 'dungeon-verifier-single',
        subjectName: 'One Room Subject',
        rootRoomId: 'room-verifier-single',
        phaseState: 'CreatorActive',
        rooms: [{ roomId: 'room-verifier-single', topic: 'The only room' }],
      },
      rooms: {
        'room-verifier-single': {
          roomId: 'room-verifier-single',
          topic: 'The only room',
          createdAt: VERIFIER_NOW,
          updatedAt: VERIFIER_NOW,
          state: 'Created',
          notePath: 'rooms/room-verifier-single/notes.txt',
          artifactPath: 'rooms/room-verifier-single/artifact.md',
          noteText: '',
          artifactMarkdown: null,
          validationState: {
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
          },
          reviewPassCount: 0,
          attachments: [],
        },
      },
    },
  };
}

function emptySubject(): Record<string, unknown> {
  return {
    subjectId: SUBJECT.empty,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: VERIFIER_NOW,
    updatedAt: VERIFIER_NOW,
    snapshot: {
    dungeon: {
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      dungeonId: 'dungeon-verifier-empty',
      subjectName: 'Empty Subject',
      // A subject with no rooms at all: the root room id names nothing, and the
      // room-summary list is empty, which is what a just-created empty subject
      // looks like before anything has been added to it.
      rootRoomId: 'room-verifier-empty-absent',
      phaseState: 'CreatorActive',
      rooms: [],
    },
    rooms: {},
  },
  };
}

function progressionFor(subjectId: string, subjectName: string, seed: number): Record<string, unknown> {
  return {
    subjectId,
    sourceVersion: 3,
    rank: 'scholar',
    xpTotal: 4200 + seed,
    crossSubjectAchievements: ['ach-verifier-first', 'ach-verifier-🚀', 'ach-verifier-ünïcødé'],
    bySubject: {
      [subjectId]: {
        kind: 'canonical-subject-progression',
        subjectId,
        xpTotal: 4200 + seed,
        rank: 'scholar',
        badges: [`badge-verifier-${seed}-a`, `badge-verifier-${seed}-b`],
        inventory: [
          {
            id: `loot-verifier-${seed}`,
            name: `Synthetic Verifier Ledger ${seed}`,
            description: 'An inventory entry, so the list is non-empty.',
            rarity: 'rare',
            acquiredAt: VERIFIER_NOW,
            verifierInventoryField: 'ZZ-verifier-unknown-inventory-field',
          },
        ],
        equippedItems: [
          {
            id: `equip-verifier-${seed}`,
            name: `Synthetic Verifier Lantern ${seed}`,
            description: 'An equipped item, so the equipped slot list is non-empty.',
            rarity: 'epic',
            acquiredAt: VERIFIER_NOW,
            equipSlot: 'weapon',
            equipped: true,
          },
        ],
        collectedNotes: [
          {
            noteId: `note-verifier-${seed}`,
            dungeonId: subjectId,
            roomId: 'room-verifier-unicode',
            topic: VERIFIER_MARKERS.roomTopic,
            floorLabel: 'Floor 1',
            artifactPreview: 'Synthetic preview.',
            noteMarkdown: VERIFIER_MARKERS.noteBody,
            artifactMarkdown: '# Artifact',
            collectedAt: VERIFIER_NOW,
            verifierNoteField: 'ZZ-verifier-unknown-note-field',
          },
        ],
        streakCount: 3,
        subjectsMastered: 1,
        roomsCleared: 2,
        reviewPasses: 5,
        artifacts: 2,
        bossesDefeated: 1,
        fishCollection: [
          {
            id: `fish-verifier-${seed}`,
            name: `Synthetic Verifier Koi ${seed}`,
            rarity: 'epic',
            subjectId,
            subjectName,
            caughtAt: VERIFIER_NOW,
            catalogId: `catalog-verifier-${seed}`,
            verifierFishField: 'ZZ-verifier-unknown-fish-field',
          },
        ],
        verifierProgressionField: 'ZZ-verifier-unknown-progression-field',
      },
    },
  };
}

function receiptFor(generationId: string, previous: string | null): MigrationReceiptValue {
  return {
    receiptId: 'receipt-verifier-0001',
    migrationId: 'legacy-localstorage-to-storage-v2',
    fromStorage: 'legacy-localstorage',
    toStorage: 'storage-v2',
    stagedGenerationId: generationId,
    previousActiveGenerationId: previous,
    status: 'activated',
    createdAt: VERIFIER_NOW,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    subjectSchemaVersions: { [CANONICAL_SUBJECT_SCHEMA_VERSION]: 4 },
    progressionSourceVersions: { '3': 4 },
    recordCounts: {
      meta: 0,
      subjects: 4,
      progression: 4,
      sessions: 2,
      preferences: 3,
      shortcuts: 1,
      assistance: 1,
      attachments: 0,
      customSprites: 0,
      recovery: 1,
      migrationReceipts: 1,
    },
    recordChecksums: {
      meta: sha256Hex(bytesOf('verifier-meta')),
      subjects: sha256Hex(bytesOf('verifier-subjects')),
      progression: sha256Hex(bytesOf('verifier-progression')),
      sessions: sha256Hex(bytesOf('verifier-sessions')),
      preferences: sha256Hex(bytesOf('verifier-preferences')),
      shortcuts: sha256Hex(bytesOf('verifier-shortcuts')),
      assistance: sha256Hex(bytesOf('verifier-assistance')),
      attachments: sha256Hex(bytesOf('verifier-attachments')),
      customSprites: sha256Hex(bytesOf('verifier-sprites')),
      recovery: sha256Hex(bytesOf('verifier-recovery')),
      migrationReceipts: sha256Hex(bytesOf('verifier-receipts')),
    },
    contentChecksum: sha256Hex(bytesOf('verifier-generation')),
  };
}

export interface BuildDeviceOptions {
  /** `true` builds a device with no attachments, sprites, or receipts. */
  readonly empty?: boolean;
  /** A database name, so two devices in one test file never collide. */
  readonly databaseName?: string;
  /** An id factory seed. */
  readonly seed?: string;
  /** The generation labels this device uses, so two devices differ. */
  readonly labels?: { generationId: string; priorGenerationId: string };
}

let databaseCounter = 0;

export async function buildVerifierDevice(
  options: BuildDeviceOptions = {},
): Promise<VerifierDevice> {
  const empty = options.empty === true;
  databaseCounter += 1;
  const databaseName =
    options.databaseName ?? `verifier-phase5-${process.pid}-${databaseCounter}`;
  const labels = options.labels ?? {
    generationId: VERIFIER_GENERATION,
    priorGenerationId: VERIFIER_PRIOR_GENERATION,
  };
  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(VERIFIER_NOW),
    idFactory: createDeterministicIdFactory(options.seed ?? 'verifier'),
  });

  const stored = bytesOf('ZZ-verifier-stored-payload-\u{1F600}');
  const lastByteOnly = stored.slice();
  lastByteOnly[lastByteOnly.length - 1] = (lastByteOnly[lastByteOnly.length - 1] as number) ^ 0xff;
  const large = largePayload();
  const hashDisagrees = bytesOf('ZZ-verifier-bytes-that-do-not-match-the-declared-hash');
  const externalWithBytes = bytesOf('ZZ-verifier-bytes-for-an-external-record');
  const payloads: VerifierPayloads = { stored, lastByteOnly, large, hashDisagrees, externalWithBytes };
  const payloadBytes = new Map<string, Uint8Array>([
    [ATTACHMENT.stored, stored],
    [ATTACHMENT.duplicatePayload, stored],
    [ATTACHMENT.lastByteOnly, lastByteOnly],
    [ATTACHMENT.large, large],
    [ATTACHMENT.hashDisagrees, hashDisagrees],
  ]);

  const subjects: Record<string, unknown>[] = [
    emptySubject(),
    singleRoomSubject(),
    richSubject(),
    unicodeSubject(),
  ];
  const subjectNames: Record<string, string> = {
    [SUBJECT.empty]: 'Empty Subject',
    [SUBJECT.single]: 'One Room Subject',
    [SUBJECT.rich]: VERIFIER_MARKERS.subjectName,
    [SUBJECT.unicode]: 'Ünïcødé Sübject 🚀',
  };

  const records: GenerationRecordValues = {
    subjects: subjects as unknown as GenerationRecordValues['subjects'],
    progression: [
      progressionFor(SUBJECT.empty, subjectNames[SUBJECT.empty] as string, 1),
      progressionFor(SUBJECT.single, subjectNames[SUBJECT.single] as string, 2),
      progressionFor(SUBJECT.rich, subjectNames[SUBJECT.rich] as string, 3),
      progressionFor(SUBJECT.unicode, subjectNames[SUBJECT.unicode] as string, 4),
    ] as unknown as GenerationRecordValues['progression'],
    sessions: [
      {
        sessionId: 'session-verifier-0001',
        subjectId: SUBJECT.rich,
        subjectName: subjectNames[SUBJECT.rich] as string,
        startedAt: VERIFIER_NOW,
        endedAt: null,
        roomsVisited: ['room-verifier-phase0-root'],
        notesSubmitted: 2,
        reviewsCompleted: 5,
        xpEarned: 320,
        eventId: 'event-verifier-0001',
        verifierSessionField: 'ZZ-verifier-unknown-session-field',
      },
      {
        sessionId: 'session-verifier-0002',
        subjectId: SUBJECT.unicode,
        startedAt: VERIFIER_NOW,
        endedAt: VERIFIER_NOW,
        roomsVisited: ['room-verifier-unicode'],
        notesSubmitted: 1,
        reviewsCompleted: 0,
        xpEarned: 0,
        eventId: 'event-verifier-0002',
      },
    ] as GenerationRecordValues['sessions'],
    preferences: [
      { preferenceId: 'locale', value: 'es', updatedAt: VERIFIER_NOW },
      {
        preferenceId: 'questState',
        value: { stage: 3, flags: { seenIntro: true }, verifierQuestField: 'ZZ-verifier-unknown-quest-field' },
        updatedAt: VERIFIER_NOW,
      },
      { preferenceId: 'theme', value: 'cozy', updatedAt: VERIFIER_NOW },
    ] as GenerationRecordValues['preferences'],
    shortcuts: [
      { actionId: 'open-map', labelKey: 'shortcut.map', key: 'm', ctrlKey: false, shiftKey: false },
      { actionId: 'open-help', labelKey: 'shortcut.help', key: 'h', ctrlKey: true, shiftKey: false },
    ] as GenerationRecordValues['shortcuts'],
    assistance: [
      {
        assistanceId: 'assistance-verifier-0001',
        mode: 'gentle',
        signals: { repeatedMisses: 3, timeOnRoom: 41 },
        dismissalCount: 2,
        updatedAt: VERIFIER_NOW,
        verifierAssistanceField: 'ZZ-verifier-unknown-assistance-field',
      },
    ] as unknown as GenerationRecordValues['assistance'],
    attachmentMetadata: [] as GenerationRecordValues['attachmentMetadata'],
    attachmentBlobs: [] as GenerationRecordValues['attachmentBlobs'],
    customSprites: [
      {
        spritePath: SPRITE_PATH,
        kind: 'override',
        // Characters that would need escaping if this body were ever a member name.
        content: `${VERIFIER_MARKERS.spriteBody}<!-- "quoted" 'single' \\backslash/ ../ ..%2f *?<>| : ; -->`,
        updatedAt: VERIFIER_NOW,
        verifierSpriteField: 'ZZ-verifier-unknown-sprite-field',
      },
      {
        spritePath: SPRITE_PATH,
        kind: 'anim',
        // Deliberately not valid JSON, and not valid SVG either.
        content: '{ "frames": [ {"ms":120}, {"ms":120} ',
        updatedAt: VERIFIER_NOW,
      },
      {
        spritePath: SPRITE_PATH,
        kind: 'original',
        content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
        updatedAt: VERIFIER_NOW,
      },
    ] as GenerationRecordValues['customSprites'],
    recovery: [
      {
        kind: 'corrupt',
        subjectId: SUBJECT.rich,
        raw: VERIFIER_MARKERS.recoveryRaw,
        capturedAt: VERIFIER_NOW,
        verifierRecoveryField: 'ZZ-verifier-unknown-recovery-field',
      },
      {
        kind: 'unindexed-subject',
        subjectId: 'subject-verifier-unindexed',
        raw: '{"rooms":{"a":{"topic":"ZZ-verifier-unindexed-room"}}}',
        capturedAt: VERIFIER_NOW,
      },
    ] as GenerationRecordValues['recovery'],
    migrationReceipts: [receiptFor(labels.generationId, null)] as GenerationRecordValues['migrationReceipts'],
  };

  if (!empty) {
    const metadata: AttachmentMetadataRecordValue[] = [
      {
        attachmentId: ATTACHMENT.stored,
        subjectId: SUBJECT.rich,
        roomId: 'room-verifier-phase0-root',
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: hashOf(stored),
        fileName: VERIFIER_MARKERS.attachmentFileName,
        altText: VERIFIER_MARKERS.attachmentAltText,
        addedAt: VERIFIER_NOW,
        verifierAttachmentField: 'ZZ-verifier-unknown-attachment-field',
      } as AttachmentMetadataRecordValue,
      {
        attachmentId: ATTACHMENT.duplicatePayload,
        subjectId: SUBJECT.rich,
        roomId: 'room-verifier-phase0-branch',
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: hashOf(stored),
        addedAt: VERIFIER_NOW,
      },
      {
        attachmentId: ATTACHMENT.lastByteOnly,
        subjectId: SUBJECT.unicode,
        roomId: 'room-verifier-unicode',
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: hashOf(lastByteOnly),
        addedAt: VERIFIER_NOW,
      },
      {
        attachmentId: ATTACHMENT.large,
        subjectId: SUBJECT.rich,
        roomId: 'room-verifier-phase0-root',
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: hashOf(large),
        addedAt: VERIFIER_NOW,
      },
      {
        attachmentId: ATTACHMENT.hashDisagrees,
        subjectId: SUBJECT.rich,
        roomId: 'room-verifier-phase0-branch',
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        // Declared hash of *other* bytes. The device has bytes for this id; they
        // are simply not the bytes the record claims.
        contentHash: hashOf(bytesOf('ZZ-verifier-some-other-bytes-entirely')),
        addedAt: VERIFIER_NOW,
      },
      {
        attachmentId: ATTACHMENT.external,
        subjectId: SUBJECT.unicode,
        roomId: 'room-verifier-unicode',
        sourceType: 'external',
        mimeType: 'image/jpeg',
        availability: 'external-only',
        contentHash: null,
        externalUrl: VERIFIER_MARKERS.externalUrl,
        fileName: 'zz-verifier-remote.jpg',
        addedAt: VERIFIER_NOW,
      },
      {
        // `external` source type, bytes present on the device. Whether the bytes
        // are carried is a decision the exporter makes; the gate measures it.
        attachmentId: ATTACHMENT.externalWithBytes,
        subjectId: SUBJECT.rich,
        roomId: 'room-verifier-phase0-root',
        sourceType: 'external',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: hashOf(externalWithBytes),
        addedAt: VERIFIER_NOW,
      },
    ];
    const blob = (attachmentId: string, bytes: Uint8Array, hash: string): AttachmentBlobRecordValue => ({
      attachmentId,
      contentHash: hash,
      bytes: toArrayBuffer(bytes),
      byteLength: bytes.byteLength,
      storedAt: VERIFIER_NOW,
    });
    records.attachmentMetadata = metadata as GenerationRecordValues['attachmentMetadata'];
    records.attachmentBlobs = [
      blob(ATTACHMENT.stored, stored, hashOf(stored)),
      blob(ATTACHMENT.duplicatePayload, stored, hashOf(stored)),
      blob(ATTACHMENT.lastByteOnly, lastByteOnly, hashOf(lastByteOnly)),
      blob(ATTACHMENT.large, large, hashOf(large)),
      blob(ATTACHMENT.hashDisagrees, hashDisagrees, hashOf(bytesOf('ZZ-verifier-some-other-bytes-entirely'))),
      blob(ATTACHMENT.externalWithBytes, externalWithBytes, hashOf(externalWithBytes)),
    ] as GenerationRecordValues['attachmentBlobs'];
  } else {
    records.customSprites = [] as GenerationRecordValues['customSprites'];
    records.recovery = [] as GenerationRecordValues['recovery'];
    records.migrationReceipts = [] as GenerationRecordValues['migrationReceipts'];
  }

  // A prior generation, so "the previous generation is retained" is a claim about
  // a generation that exists rather than about nothing.
  await repository.stageGeneration({ generationId: labels.priorGenerationId, source: 'legacy-migration', records: emptyRecords() });
  await repository.activateGeneration(labels.priorGenerationId);
  await repository.stageGeneration({ generationId: labels.generationId, source: 'legacy-migration', records });
  await repository.activateGeneration(labels.generationId);

  const report = await repository.validateGeneration(labels.generationId);
  if (!report.ok) {
    throw new Error(
      `verifier device fixture does not validate: ${JSON.stringify(report.problems.slice(0, 6))}`,
    );
  }

  seedLegacyStorage();

  return {
    repository,
    generationId: labels.generationId,
    priorGenerationId: labels.priorGenerationId,
    payloadBytes,
    payloads,
    records,
    empty,
    close: () => repository.close(),
  };
}

export function emptyRecords(): GenerationRecordValues {
  return {
    subjects: [],
    progression: [],
    sessions: [],
    preferences: [],
    shortcuts: [],
    assistance: [],
    attachmentMetadata: [],
    attachmentBlobs: [],
    customSprites: [],
    recovery: [],
    migrationReceipts: [],
  } as GenerationRecordValues;
}

export const LEGACY_KEYS: ReadonlyArray<[string, string]> = [
  ['knowledge-dungeon:subjects', JSON.stringify([{ subjectId: SUBJECT.rich, name: VERIFIER_MARKERS.subjectName }])],
  ['knowledge-dungeon:locale', 'es'],
  ['kd-backup-subject:subject-verifier-rich', VERIFIER_MARKERS.recoveryRaw],
  ['knowledge-dungeon:questState', JSON.stringify({ stage: 3, flags: { seenIntro: true } })],
  ['knowledge-dungeon:preferences', JSON.stringify({ theme: 'cozy' })],
];

export function seedLegacyStorage(): void {
  resetLegacyStorage();
  for (const [key, value] of LEGACY_KEYS) window.localStorage.setItem(key, value);
}

export function resetLegacyStorage(): void {
  window.localStorage.clear();
}

// ── The device fingerprint ─────────────────────────────────────────────────

export interface DeviceFingerprint {
  readonly digest: string;
  readonly activeGenerationId: string | null;
  readonly generationIds: readonly string[];
  readonly recordCount: number;
  /** `[store, recordId, key, sha256-of-this-harness's-own-encoding-of-the-value]`. */
  readonly records: ReadonlyArray<readonly [string, string, string, string]>;
  /** Every `meta` row, so a descriptor or pointer edit is visible. */
  readonly meta: ReadonlyArray<readonly [string, string]>;
  /** The ordered `localStorage` key/value set. */
  readonly legacy: ReadonlyArray<readonly [string, string]>;
}

/**
 * A total encoding of a value, written here rather than borrowed.
 *
 * `ArrayBuffer` and every typed-array view are hex-encoded, so a *byte* change
 * in an attachment blob moves this digest. The application's own canonical
 * serializer does not do that (an `ArrayBuffer` has no enumerable own keys), and
 * a verifier that reused it would inherit that gap.
 */
export function encodeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'string') return `s:${JSON.stringify(value)}`;
  if (type === 'bigint' || type === 'symbol' || type === 'function') return `${type}:${String(value)}`;
  if (isArrayBuffer(value)) return `ab:${hexOf(new Uint8Array(value as ArrayBuffer))}`;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return `view:${hexOf(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength))}`;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => encodeValue(entry)).join(',')}]`;
  const object = value as Record<string, unknown>;
  const parts = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeValue(object[key])}`);
  return `{${parts.join(',')}}`;
}

export async function captureDevice(repository: StorageV2Repository): Promise<DeviceFingerprint> {
  const activeGenerationId = await repository.readActiveGenerationId();
  const descriptors = await repository.listGenerations();
  const generationIds = descriptors.map((descriptor) => descriptor.generationId).sort();
  const records: Array<readonly [string, string, string, string]> = [];
  const meta: Array<readonly [string, string]> = [];

  for (const generationId of generationIds) {
    const snapshot = await repository.readRecords(generationId);
    const values = snapshot.records as unknown as Record<string, Array<{ key: string; recordId: string; value: unknown }>>;
    for (const store of Object.keys(values).sort()) {
      for (const envelope of values[store] ?? []) {
        records.push([store, envelope.recordId, envelope.key, encodeValue(envelope.value)]);
      }
    }
  }

  // Read the `meta` object store directly, so a change to a descriptor or to the
  // pointer that the descriptor list does not surface is still visible.
  const rawMeta = await readMetaStore(repository.databaseName);
  for (const [key, value] of rawMeta) meta.push([key, encodeValue(value)]);

  const legacy: Array<readonly [string, string]> = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index) as string;
    legacy.push([key, window.localStorage.getItem(key) ?? '']);
  }

  const digest = sha256Hex(bytesOf(encodeValue({ records, meta, legacy, activeGenerationId })));
  return {
    digest,
    activeGenerationId,
    generationIds,
    recordCount: records.length,
    records,
    meta,
    legacy,
  };
}

async function readMetaStore(databaseName: string): Promise<Array<[string, unknown]>> {
  const handle = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const out: Array<[string, unknown]> = [];
    const tx = handle.transaction('meta', 'readonly');
    const request = tx.objectStore('meta').getAll();
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const rows = request.result as Array<{ recordId: string; value: unknown }>;
    for (const row of rows) out.push([row.recordId, row.value]);
    return out.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  } finally {
    handle.close();
  }
}

// ── The field-by-field comparator ──────────────────────────────────────────

/** One concrete difference between two values, as a JSON-pointer-ish path. */
export interface FieldDifference {
  readonly path: string;
  readonly left: string;
  readonly right: string;
}

/**
 * Compare two values field by field.
 *
 * Deliberately *not* the application's canonical serializer: a verifier that
 * reused the thing it is verifying could only ever agree with itself. Keys are
 * compared as sets, arrays as ordered sequences, and binary as hex.
 */
export function diffValues(left: unknown, right: unknown, path = '$'): FieldDifference[] {
  // Binary first. An `ArrayBuffer` is an `object` with no enumerable own keys, so
  // a naive object walk would call two different byte strings equal. (The first
  // version of this comparator did exactly that, and its own control caught it.)
  if (isBinary(left) || isBinary(right)) {
    if (isBinary(left) && isBinary(right) && describe(left) === describe(right)) return [];
    return [{ path, left: describe(left), right: describe(right) }];
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    if (Object.is(left, right)) return [];
    return [{ path, left: describe(left), right: describe(right) }];
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return [{ path, left: describe(left), right: describe(right) }];
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return [{ path: `${path}.length`, left: String(left.length), right: String(right.length) }];
    }
    return left.flatMap((entry, index) => diffValues(entry, right[index], `${path}[${index}]`));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = [...new Set([...Object.keys(leftRecord), ...Object.getOwnPropertyNames(leftRecord)])].sort();
  const rightKeys = [...new Set([...Object.keys(rightRecord), ...Object.getOwnPropertyNames(rightRecord)])].sort();
  const out: FieldDifference[] = [];
  for (const key of new Set([...leftKeys, ...rightKeys])) {
    if (!Object.hasOwn(leftRecord, key) || !Object.hasOwn(rightRecord, key)) {
      out.push({
        path: `${path}.${key}`,
        left: Object.hasOwn(leftRecord, key) ? 'present' : 'absent',
        right: Object.hasOwn(rightRecord, key) ? 'present' : 'absent',
      });
      continue;
    }
    out.push(...diffValues(leftRecord[key], rightRecord[key], `${path}.${key}`));
  }
  return out;
}

/**
 * Cross-realm-safe `instanceof ArrayBuffer`.
 *
 * A structural check, not `instanceof`, because a buffer created by a
 * `TextEncoder` from another realm is not an `ArrayBuffer` of *this* realm. That
 * is the same cross-realm trap the repository already recorded for Node 20, and a
 * verifier that used `instanceof` would silently stop seeing attachment bytes.
 */
function isArrayBuffer(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function isBinary(value: unknown): boolean {
  return isArrayBuffer(value) || ArrayBuffer.isView(value);
}

function describe(value: unknown): string {
  if (isArrayBuffer(value)) return `ab:${hexOf(new Uint8Array(value as ArrayBuffer))}`;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return `view:${hexOf(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength))}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return encodeValue(value);
}
