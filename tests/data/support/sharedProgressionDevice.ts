/**
 * A device whose **progression record is shared**, built for the implementer's own
 * Phase 6 gates.
 *
 * ## Why this fixture exists rather than being folded into `nastySubject.ts`
 *
 * The shape under test is a device where **one** `ProgressionRecordValue` carries
 * **two** subjects' learner state in its `bySubject` map, because that is what the
 * canonical v3 `localStorage` writer produced: one envelope, `bySubject` filled with
 * every subject on the device, and `normalizeProgressionRecord` preserving every key
 * it finds. `ProgressionRecordValue` is keyed by `record.subjectId`, so that record
 * is *nominally* one subject's and is really a container for several.
 *
 * The adversarial-value fixture (`nastySubject.ts`) gives every record its own key,
 * which is the *tidy* shape and therefore the wrong fixture for this defect. This one
 * deliberately reproduces the untidy one, and it also carries the three id-reference
 * hazards the reviewer reported, because all of them are properties of the same
 * record: a `dungeonId` that disagrees with the record's own `subjectId`, an
 * attachment `relativePath` that names a room id, and an undeclared object **key**
 * holding a room id.
 *
 * Every constant here is synthetic and the fixture is fully deterministic: a fixed
 * clock, a seeded counter id factory, and no wall clock, no randomness, and no
 * network anywhere in its construction.
 */

import { STORAGE_V2_GENERATION_FORMAT_VERSION } from '@/services/persistence/v2/schema';
import { openStorageV2Repository, type StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  createDeterministicIdFactory,
  fixedClock,
} from '@/services/persistence/v2/database';
import { sha256Hex } from '@/services/persistence/v2/checksum';
import type { AssistanceRecordValue, ProgressionRecordValue, SubjectRecordValue } from '@/services/persistence/v2/schema';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';
import { otherSubjectSnapshot, resetLegacyStorage, NASTY_DEVICE_NOW } from './nastySubject';

/** The fixed clock every record in this fixture is stamped with. */
export const SHARED_NOW = NASTY_DEVICE_NOW;

// ── Identities ─────────────────────────────────────────────────────────────

/** The subject an export names, and the one a replace replaces. */
export const SHARED_SUBJECT_ID = 'subject-shared-0001';

/**
 * A bystander whose learner state lives **only** in
 * {@link sharedProgressionRecord}'s `bySubject` map.
 *
 * No record of its own exists. That is deliberate: it makes the measurement
 * unambiguous. If the shared entry survives, the bystander is intact; if it is
 * destroyed, the bystander has **no progression anywhere on the device** and the
 * only thing left of it is a subject record - which is exactly the state the
 * reviewer described, and exactly what a per-store record count cannot see.
 */
export const SHARED_BYSTANDER_ID = 'subject-shared-0002';

/**
 * A third subject, unrelated to the export, with a progression record of its own.
 *
 * It is the control for the merge: the replace must leave this record and its
 * subject byte-identical, and its presence means the merge has to *choose* which
 * records to touch rather than having only one candidate.
 */
export const SHARED_UNRELATED_ID = 'subject-shared-0003';

export const SHARED_GENERATION_ID = 'gen-data-gate-shared';
export const SHARED_PRIOR_GENERATION_ID = 'gen-data-gate-shared-prior';

/** The bystander's own room, so a lost entry names a room that still exists. */
export const BYSTANDER_ROOM_ID = 'room-shared-bystander';

/** The exported subject's room, the one every `relativePath` and key hazard names. */
export const SUBJECT_ROOM_ID = 'room-shared-root';

/**
 * A `dungeonId` that disagrees with the record's own `subjectId`.
 *
 * `subjectPersistence.ts` mints `dungeonId` with `generateId('subject')` and
 * `subjectActivation.ts` reads it as the active subject, so the two normally agree.
 * A record that disagrees is a shape the validator does not refuse and a hand-made
 * archive can carry, and no mapping can be minted for it: the value names no subject
 * the archive declares.
 */
export const STALE_DUNGEON_ID = `${SHARED_SUBJECT_ID}-legacy-dungeon`;

/** The exact path shape `electron/main.ts` writes into the `userData` tree. */
export const ROOM_RELATIVE_PATH = `rooms/${SUBJECT_ROOM_ID}/attachments/att-shared-0001.png`;

/** The bystander's fish and note identifiers, which must survive byte for byte. */
export const BYSTANDER_FISH_ID = 'fish-shared-bystander-0001';
export const BYSTANDER_NOTE_ID = 'note-shared-bystander-0001';

/** The exported subject's own fish and note identifiers, which a copy remaps. */
export const SHARED_OWN_FISH_ID = 'fish-shared-own-0001';
export const SHARED_OWN_NOTE_ID = 'note-shared-own-0001';

export const SHARED_ATTACHMENT_ID = 'att-shared-0001';

/**
 * An id this device minted for a **different** subject, so a device-wins rule is
 * observable rather than asserted.
 */
export const ASSISTANCE_ID_OWN = 'assistance-shared-own-0001';
export const ASSISTANCE_ID_BYSTANDER = 'assistance-shared-bystander-0001';

/** A small, deterministic payload. Not a real image; no fixture here decodes bytes. */
export function sharedPayload(): { bytes: Uint8Array; contentHash: string } {
  const bytes = new TextEncoder().encode('knowledge-dungeon shared-progression fixture payload');
  return { bytes, contentHash: sha256Hex(bytes) };
}

// ── The snapshots ──────────────────────────────────────────────────────────

function stamp(subjectId: string, snapshot: SubjectSnapshot): SubjectRecordValue {
  return {
    subjectId,
    schemaVersion: '1.1.0',
    snapshot: snapshot as unknown as SubjectRecordValue['snapshot'],
    createdAt: NASTY_DEVICE_NOW,
    updatedAt: NASTY_DEVICE_NOW,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
  } as SubjectRecordValue;
}

/**
 * The bystander's subject record.
 *
 * Reuses the adversarial fixture's second snapshot because it is already known to
 * pass `validateSubjectSnapshot`, and this fixture's subject is about the
 * **progression record**, not about snapshot hazards. Renaming its root room would
 * change a constant the reused snapshot hard-codes, so the room id it declares is
 * read back out of the snapshot rather than assumed.
 */
export function bystanderSubject(): SubjectRecordValue {
  return stamp(SHARED_BYSTANDER_ID, otherSubjectSnapshot());
}

/** The bystander's room id, read from the reused snapshot rather than assumed. */
export function bystanderSnapshotRoomId(): string {
  const snapshot = otherSubjectSnapshot() as unknown as {
    rooms: Record<string, unknown>;
  };
  return Object.keys(snapshot.rooms)[0] as string;
}

/** The unrelated control subject's snapshot, built the same way as the exported one. */
export function unrelatedSubjectSnapshot(): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      // Agrees with its own record, unlike the exported subject's stale id. A merge
      // that rewrote `dungeonId` unconditionally would be visible here as a
      // difference, so this is the control for that rule.
      dungeonId: SHARED_UNRELATED_ID,
      subjectName: 'Unrelated control subject',
      createdAt: NASTY_DEVICE_NOW,
      updatedAt: NASTY_DEVICE_NOW,
      phaseState: 'ArchaeologistActive',
      rootRoomId: 'room-shared-unrelated-root',
      rooms: [{ roomId: 'room-shared-unrelated-root', topic: 'Unrelated root', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 3, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-shared-unrelated-root': {
        roomId: 'room-shared-unrelated-root',
        topic: 'Unrelated root',
        createdAt: NASTY_DEVICE_NOW,
        updatedAt: NASTY_DEVICE_NOW,
        state: 'Created',
        notePath: 'rooms/room-shared-unrelated-root/notes.txt',
        artifactPath: 'rooms/room-shared-unrelated-root/artifact.md',
        noteText: '',
        artifactMarkdown: null,
        validationState: {},
        reviewPassCount: 0,
        attachments: [],
      },
    },
  } as unknown as SubjectSnapshot;
}

/**
 * The exported subject's snapshot, carrying all three id-reference hazards.
 *
 * The hazards are *declared* values on top of a snapshot that already validates:
 *
 * - `dungeonId` disagrees with the record's own `subjectId`;
 * - the root room's attachment carries a `relativePath` naming that room;
 * - an **undeclared** field maps that room id as an object **key**.
 */
export function sharedSubjectSnapshot(): SubjectSnapshot {
  const snapshot = {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: STALE_DUNGEON_ID,
      subjectName: 'Shared progression subject',
      createdAt: NASTY_DEVICE_NOW,
      updatedAt: NASTY_DEVICE_NOW,
      phaseState: 'ArchaeologistActive',
      rootRoomId: SUBJECT_ROOM_ID,
      rooms: [{ roomId: SUBJECT_ROOM_ID, topic: 'The shared root room', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 7, rank: 'Novice', badges: [] },
    },
    rooms: {
      [SUBJECT_ROOM_ID]: {
        roomId: SUBJECT_ROOM_ID,
        topic: 'The shared root room',
        createdAt: NASTY_DEVICE_NOW,
        updatedAt: NASTY_DEVICE_NOW,
        state: 'Created',
        notePath: `rooms/${SUBJECT_ROOM_ID}/notes.txt`,
        artifactPath: `rooms/${SUBJECT_ROOM_ID}/artifact.md`,
        noteText: '',
        artifactMarkdown: null,
        validationState: {},
        reviewPassCount: 0,
        attachments: [
          {
            attachmentId: SHARED_ATTACHMENT_ID,
            sourceType: 'local',
            fileName: 'att-shared-0001.png',
            mimeType: 'image/png',
            // The hazard: a real path shape that names the room id, into a directory
            // this copy did not move.
            relativePath: ROOM_RELATIVE_PATH,
            addedAt: NASTY_DEVICE_NOW,
          },
        ],
        // The hazard: an undeclared field whose **key** is a room id. Object keys are
        // never swept and never counted, and the module header says so.
        sharedLinksByRoom: {
          [SUBJECT_ROOM_ID]: { href: 'x' },
        },
        // The hazard: prose that merely *mentions* the room id. Carried verbatim and
        // counted, which is the disclosed residual.
        sharedSummary: `Progress lives in ${SUBJECT_ROOM_ID}.`,
      },
    },
  } as unknown as SubjectSnapshot;
  return snapshot;
}

// ── The shared progression record ──────────────────────────────────────────

function perSubject(
  subjectId: string,
  subjectName: string,
  fishId: string,
  noteId: string,
  xpTotal: number,
): Record<string, unknown> {
  return {
    subjectId,
    xpTotal,
    rank: 'Novice',
    badges: [],
    inventory: [],
    equippedItems: [],
    collectedNotes: [
      {
        noteId,
        title: `A note for ${subjectName}`,
        dungeonId: subjectId,
        roomId: subjectId === SHARED_SUBJECT_ID ? SUBJECT_ROOM_ID : BYSTANDER_ROOM_ID,
        collectedAt: NASTY_DEVICE_NOW,
      },
    ],
    streakCount: 0,
    subjectsMastered: 0,
    roomsCleared: 1,
    reviewPasses: 0,
    artifacts: 0,
    bossesDefeated: 0,
    fishCollection: [
      {
        id: fishId,
        name: 'Carp',
        rarity: 'common',
        subjectId,
        subjectName,
        caughtAt: NASTY_DEVICE_NOW,
      },
    ],
    extraFields: { retainedUnknownField: `retain-me-${subjectId}` },
  };
}

/**
 * **The** record: one `ProgressionRecordValue` carrying both subjects.
 *
 * Its own scalar fields describe the exported subject, because that is the subject
 * the record is keyed on and the shape the legacy writer produced. The bystander
 * exists only as a `bySubject` key, which is precisely the state that made the
 * original `destroyedRecordCounts` blind: one record, two subjects, and a count that
 * can only say "one record".
 */
export function sharedProgressionRecord(): ProgressionRecordValue {
  return {
    subjectId: SHARED_SUBJECT_ID,
    sourceVersion: 3,
    rank: 'Novice',
    xpTotal: 7,
    bySubject: {
      [SHARED_SUBJECT_ID]: perSubject(
        SHARED_SUBJECT_ID,
        'Shared progression subject',
        SHARED_OWN_FISH_ID,
        SHARED_OWN_NOTE_ID,
        7,
      ),
      [SHARED_BYSTANDER_ID]: perSubject(
        SHARED_BYSTANDER_ID,
        'Bystander subject',
        BYSTANDER_FISH_ID,
        BYSTANDER_NOTE_ID,
        41,
      ),
    },
    crossSubjectAchievements: ['achievement-shared-0001'],
  };
}

/**
 * A progression record of its own, for the unrelated control subject.
 *
 * The bystander deliberately has **no** record of its own; see
 * {@link SHARED_BYSTANDER_ID}.
 */
export function unrelatedProgressionRecord(): ProgressionRecordValue {
  return {
    subjectId: SHARED_UNRELATED_ID,
    sourceVersion: 3,
    rank: 'Novice',
    xpTotal: 3,
    bySubject: {
      [SHARED_UNRELATED_ID]: perSubject(
        SHARED_UNRELATED_ID,
        'Unrelated control subject',
        'fish-shared-unrelated-0001',
        'note-shared-unrelated-0001',
        3,
      ),
    },
    crossSubjectAchievements: [],
  };
}

function assistance(): AssistanceRecordValue[] {
  return [
    {
      assistanceId: ASSISTANCE_ID_OWN,
      mode: 'gentle',
      signals: { hintsShown: 3 },
      dismissalCount: 0,
      updatedAt: NASTY_DEVICE_NOW,
    },
    {
      assistanceId: ASSISTANCE_ID_BYSTANDER,
      mode: 'gentle',
      signals: { hintsShown: 9 },
      dismissalCount: 2,
      updatedAt: NASTY_DEVICE_NOW,
    },
  ];
}

function attachmentRecords(payload: { bytes: Uint8Array; contentHash: string }): {
  metadata: GenerationRecordValues['attachmentMetadata'];
  blobs: GenerationRecordValues['attachmentBlobs'];
} {
  return {
    metadata: [
      {
        attachmentId: SHARED_ATTACHMENT_ID,
        subjectId: SHARED_SUBJECT_ID,
        roomId: SUBJECT_ROOM_ID,
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: payload.contentHash,
        fileName: 'att-shared-0001.png',
        addedAt: NASTY_DEVICE_NOW,
      },
    ],
    blobs: [
      {
        attachmentId: SHARED_ATTACHMENT_ID,
        contentHash: payload.contentHash,
        bytes: payload.bytes.slice().buffer as ArrayBuffer,
        byteLength: payload.bytes.byteLength,
        storedAt: NASTY_DEVICE_NOW,
      },
    ],
  };
}

export interface SharedProgressionDevice {
  readonly repository: StorageV2Repository;
  readonly databaseName: string;
  readonly generationId: string;
  readonly priorGenerationId: string;
  readonly subjectId: string;
  readonly bystanderId: string;
  /** The unrelated control subject: a record the merge must not touch at all. */
  readonly unrelatedId: string;
  readonly payloadBytes: ReadonlyMap<string, Uint8Array>;
  readonly staged: GenerationRecordValues;
  /**
   * The bystander's entry as it stands **inside the shared record**, read straight
   * off the staged values. A gate compares against this after an import, so a
   * regression names the field that changed rather than "something about beta".
   */
  readonly bystanderEntryBefore: Record<string, unknown>;
  /** The exported subject's own entry inside the shared record. */
  readonly ownEntryBefore: Record<string, unknown>;
  /** The unrelated subject's whole record, for a byte-for-byte before/after. */
  readonly unrelatedRecordBefore: ProgressionRecordValue;
  readonly expectedRecordCounts: Readonly<Record<string, number>>;
}

/**
 * Stage and activate the shared-progression device, with a prior generation so
 * retention has something to retain.
 *
 * The fixture validates itself before it returns, exactly as the adversarial one
 * does: a gate built on a device the repository refuses would be measuring nothing.
 */
export async function createSharedProgressionDevice(
  databaseName: string,
): Promise<SharedProgressionDevice> {
  resetLegacyStorage();
  const payload = sharedPayload();
  const subjects = [
    stamp(SHARED_SUBJECT_ID, sharedSubjectSnapshot()),
    bystanderSubject(),
    stamp(SHARED_UNRELATED_ID, unrelatedSubjectSnapshot()),
  ];
  const shared = sharedProgressionRecord();
  const unrelated = unrelatedProgressionRecord();
  const attachments = attachmentRecords(payload);

  const staged: GenerationRecordValues = {
    subjects,
    // TWO progression records. One holds the exported subject **and** the bystander;
    // one holds the unrelated control subject. The bystander has no record of its
    // own, so a destroyed shared entry is total loss rather than a duplicate.
    progression: [shared, unrelated],
    sessions: [],
    preferences: [],
    shortcuts: [],
    assistance: assistance(),
    attachmentMetadata: attachments.metadata,
    attachmentBlobs: attachments.blobs,
    customSprites: [],
    recovery: [],
    migrationReceipts: [],
  };

  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(NASTY_DEVICE_NOW),
    idFactory: createDeterministicIdFactory('shared'),
  });

  await repository.stageGeneration({
    generationId: SHARED_PRIOR_GENERATION_ID,
    source: 'legacy-migration',
    records: { subjects: [subjects[0] as SubjectRecordValue] },
  });
  await repository.activateGeneration(SHARED_PRIOR_GENERATION_ID);

  await repository.stageGeneration({
    generationId: SHARED_GENERATION_ID,
    source: 'local-edit',
    parentGenerationId: SHARED_PRIOR_GENERATION_ID,
    records: staged,
  });
  await repository.activateGeneration(SHARED_GENERATION_ID);

  const sharedBySubject = shared.bySubject as Record<string, Record<string, unknown>>;
  const validation = await repository.validateGeneration(SHARED_GENERATION_ID);
  if (!validation.ok) {
    throw new Error(
      `The shared-progression fixture does not validate: ${validation.problems
        .map((problem) => `${problem.severity}:${problem.scope}:${problem.code}:${problem.count}`)
        .join(',')}`,
    );
  }

  return {
    repository,
    databaseName,
    generationId: SHARED_GENERATION_ID,
    priorGenerationId: SHARED_PRIOR_GENERATION_ID,
    subjectId: SHARED_SUBJECT_ID,
    bystanderId: SHARED_BYSTANDER_ID,
    unrelatedId: SHARED_UNRELATED_ID,
    payloadBytes: new Map([[SHARED_ATTACHMENT_ID, payload.bytes]]),
    staged,
    bystanderEntryBefore: sharedBySubject[SHARED_BYSTANDER_ID] as Record<string, unknown>,
    ownEntryBefore: sharedBySubject[SHARED_SUBJECT_ID] as Record<string, unknown>,
    unrelatedRecordBefore: unrelated,
    expectedRecordCounts: {
      meta: 0,
      subjects: 3,
      progression: 2,
      sessions: 0,
      preferences: 0,
      shortcuts: 0,
      assistance: 2,
      attachments: 2,
      customSprites: 0,
      recovery: 0,
      migrationReceipts: 0,
    },
  };
}

/**
 * Rewrite an archive's `progression.json` so it holds **only** the exported subject's
 * own entry, and repair every checksum so the archive stays *consistently* valid.
 *
 * This is what a device that never shared a record would have written, and it is the
 * ordinary cross-device case: the archive is the authoritative statement about one
 * subject, and it is silent about every other. What the import does with the silence
 * is the whole of the merge rule.
 *
 * The manifest is rebuilt from the new members, so the archive is refused by nothing:
 * this exercises the **merge**, not the validator.
 */
export async function limitArchiveProgressionToOwnSubject(bytes: Uint8Array): Promise<Uint8Array> {
  const { readArchive, writeArchive } = await import('@/services/persistence/v2/archive');
  const { canonicalJsonStringify } = await import('@/services/persistence/v2/checksum');
  const { fullDeviceManifestContentChecksum } = await import(
    '@/services/persistence/products/archiveValidation'
  );
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const files = readArchive(bytes);
  const manifest = JSON.parse(
    decoder.decode(files.find((file) => file.path === 'manifest.json')?.bytes as Uint8Array),
  ) as Record<string, unknown>;
  const document = JSON.parse(
    decoder.decode(
      files.find((file) => file.path === 'progression.json')?.bytes as Uint8Array,
    ),
  ) as { progression: ProgressionRecordValue[] };
  for (const record of document.progression) {
    const bySubject = record.bySubject as Record<string, unknown>;
    for (const key of Object.keys(bySubject)) {
      if (key !== record.subjectId) delete bySubject[key];
    }
  }
  const replaced = files.map((file) =>
    file.path === 'progression.json'
      ? { path: file.path, bytes: encoder.encode(canonicalJsonStringify(document)) }
      : file,
  );
  const members = (manifest.members as Array<{ path: string; byteLength: number; sha256: string }>).map(
    (member) => {
      const content =
        replaced.find((file) => file.path === member.path)?.bytes ??
        (files.find((file) => file.path === member.path)?.bytes as Uint8Array);
      return { path: member.path, byteLength: content.byteLength, sha256: sha256Hex(content) };
    },
  );
  return writeArchive([
    ...replaced.filter((file) => file.path !== 'manifest.json'),
    {
      path: 'manifest.json',
      bytes: encoder.encode(
        canonicalJsonStringify({
          ...manifest,
          members,
          totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
          contentChecksum: fullDeviceManifestContentChecksum(members),
        }),
      ),
    },
  ] as never);
}
