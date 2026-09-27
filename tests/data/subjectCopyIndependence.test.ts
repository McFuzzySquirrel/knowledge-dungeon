/**
 * Phase 6 data-product gate 1: a copied subject is independent and fully usable.
 *
 * This is the phase's primary exit criterion (plan Phase 6, "A copied subject is
 * independent and fully usable"), and "independent" is the load-bearing word. Plan
 * section 7.3 makes copy mode the **default** import mode, so this is the path a
 * learner takes when they import a friend's subject, and the failure mode is not a
 * crash - it is a copy that quietly shares state with its source. Two subjects that
 * share one room id are not two subjects: clearing a room in the copy clears it in
 * the original, and nothing anywhere reports an error.
 *
 * So the gate proves four separate things, and each is falsifiable on its own:
 *
 * 1. **No shared identifier.** Not the subject id, not one room id, not one
 *    attachment id, not one session id, not one fish entry id, not one note id, not
 *    one loot id, not one assistance id - across the copy and the *whole* device,
 *    including the subject it was copied from and the unrelated subject beside it.
 * 2. **Every reference resolves inside the copy.** A copy whose ids are distinct can
 *    still be broken: an edge pointing at a room the copy does not have, a
 *    `notePath` naming the *source's* room, a `tagIndex` value left behind, a
 *    `roomsVisited` entry naming a room that only exists on the other device, a
 *    collected note or fish pointing at the source subject. Every declared location
 *    is walked and resolved.
 * 3. **The source device's records are unchanged**, compared as canonical bytes
 *    through the shared fingerprint, and the source subject is still exportable - so
 *    "the source device can keep working" is a demonstrated capability, not an
 *    assurance.
 * 4. **The copy is fully usable**, which is measured by the application's own gate:
 *    `validateGeneration` on the new generation is clean, and the archive the copy
 *    produces is byte-identical to the one it was imported from apart from the
 *    identifiers - so a copy can be backed up, handed on, and copied again.
 *
 * The fixture is `nastySubject.ts`, whose subject is nastier than any Phase 5
 * fixture: a room id that is a prefix of another, a room id made of regular
 * expression metacharacters, a room id containing an astral-plane character, a room
 * id that is also a tag name, a room id that is an `Object.prototype` name, and an
 * unknown field holding a room id at six levels.
 *
 * Privacy: the assertions read ids, counts, and digests. No assertion, and no
 * failure message, copies a subject name, a topic, a note, a filename, or a URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import type { StorageRecordEnvelope } from '@/services/persistence/v2/schema';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  exportSubjectBackup,
  importSubjectBackup,
  readSubjectArchiveContents,
  type SubjectImportResult,
} from '@/services/persistence/products/subjectBackup';
import {
  captureDeviceState,
  describeDifferences,
  diffDeviceStates,
  fingerprintOf,
} from './support/deviceState';
import {
  NASTY_DEVICE_NOW,
  NASTY_DETERMINISM_NOW,
  NASTY_GENERATION_ID,
  NASTY_OTHER_SUBJECT_ID,
  NASTY_ROOM_IDS,
  NASTY_ROOM_LIST,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  type NastyDevice,
} from './support/nastySubject';

let device: NastyDevice;
let archive: Uint8Array;
let imported: SubjectImportResult;

beforeAll(async () => {
  device = await createNastySubjectDevice('kd-data-gate-copy');
  archive = (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
  imported = await importSubjectBackup({
    repository: device.repository,
    bytes: archive,
    now: NASTY_DETERMINISM_NOW,
  });
});

/** The values of one store in the activated generation, keyed by record id. */
async function valuesOf(
  repository: StorageV2Repository,
  generationId: string,
  store: 'subjects' | 'progression' | 'sessions' | 'assistance' | 'attachmentMetadata' | 'attachmentBlobs',
): Promise<Map<string, unknown>> {
  const snapshot = await repository.readRecords(generationId);
  const out = new Map<string, unknown>();
  for (const envelope of snapshot.records[store] as StorageRecordEnvelope<unknown>[]) {
    out.set(envelope.recordId, envelope.value);
  }
  return out;
}

/** Every identifier of one kind, from the subject and its progression record. */
function identifiersOfSubject(
  subject: Record<string, unknown>,
  progression: unknown,
): Readonly<Record<string, readonly string[]>> {
  const snapshot = subject.snapshot as { rooms: Record<string, { attachments?: { attachmentId: string }[] }> };
  const dungeon = (subject.snapshot as { dungeon: Record<string, unknown> }).dungeon;
  const bySubject = (progression as { bySubject: Record<string, Record<string, unknown>> } | null)?.bySubject ?? {};
  const perSubject = Object.values(bySubject)[0] ?? {};
  return {
    subject: [String(subject.subjectId)],
    rooms: Object.keys(snapshot.rooms),
    attachments: Object.values(snapshot.rooms).flatMap((room) =>
      (room.attachments ?? []).map((attachment) => attachment.attachmentId),
    ),
    dungeonId: [String(dungeon.dungeonId)],
    rootRoom: [String(dungeon.rootRoomId)],
    fish: ((perSubject.fishCollection as { id: string }[] | undefined) ?? []).map((fish) => fish.id),
    notes: ((perSubject.collectedNotes as { noteId: string }[] | undefined) ?? []).map(
      (note) => note.noteId,
    ),
    loot: [
      ...((perSubject.inventory as { id: string }[] | undefined) ?? []).map((item) => item.id),
      ...((perSubject.equippedItems as { id: string }[] | undefined) ?? []).map((item) => item.id),
    ],
  };
}

describe('Phase 6 gate 1: a copy shares no identifier with anything on the device', () => {
  it('the default mode is copy, and it mints a new subject id', () => {
    // No `mode` in the request at all. Plan section 7.3: the default import mode
    // is Create copy, and this is the assertion that the default is copy rather
    // than a default that happens to be safe because the archive names a subject
    // the device already has.
    expect(imported.mode).toBe('copy');
    expect(imported.importedSubjectId).not.toBe(NASTY_SUBJECT_ID);
    expect(imported.importedSubjectId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(imported.replacedSubjectId).toBeNull();
    // Nothing was destroyed, and the whole mapping is on the result.
    expect(imported.destroyedRecordCounts).toEqual({});
    expect(imported.identifiersRemapped).toBe(imported.idMapping.length);
    expect(imported.idMapping.length).toBeGreaterThanOrEqual(18);
  });

  it('every identifier class is disjoint from every identifier already on the device', async () => {
    const subjects = await valuesOf(device.repository, imported.generationId, 'subjects');
    const copy = subjects.get(imported.importedSubjectId) as Record<string, unknown> | undefined;
    expect(copy, 'the copy must be a subjects record in the activated generation').toBeDefined();

    const progressionValues = await valuesOf(device.repository, imported.generationId, 'progression');
    const copyProgression = progressionValues.get(imported.importedSubjectId) ?? null;
    const copyIds = identifiersOfSubject(copy as Record<string, unknown>, copyProgression);

    // The source subject, and every other subject, as they were **before** the
    // import. Read from the retained previous generation, so this compares the copy
    // against the device's real prior state rather than against a value the import
    // itself produced.
    const previousSubjects = await valuesOf(device.repository, NASTY_GENERATION_ID, 'subjects');
    const previousProgression = await valuesOf(device.repository, NASTY_GENERATION_ID, 'progression');
    const deviceIds: string[] = [];
    for (const [recordId, value] of previousSubjects) {
      const record = value as Record<string, unknown>;
      const ids = identifiersOfSubject(record, previousProgression.get(recordId) ?? null);
      deviceIds.push(
        ...ids.subject,
        ...ids.rooms,
        ...ids.attachments,
        ...ids.dungeonId,
        ...ids.fish,
        ...ids.notes,
        ...ids.loot,
      );
    }
    const previousSessions = await valuesOf(device.repository, NASTY_GENERATION_ID, 'sessions');
    for (const value of previousSessions.values()) {
      deviceIds.push(String((value as { sessionId: string }).sessionId));
    }
    const previousAssistance = await valuesOf(device.repository, NASTY_GENERATION_ID, 'assistance');
    for (const value of previousAssistance.values()) {
      deviceIds.push(String((value as { assistanceId: string }).assistanceId));
    }
    const previousAttachments = await valuesOf(device.repository, NASTY_GENERATION_ID, 'attachmentMetadata');
    for (const value of previousAttachments.values()) {
      deviceIds.push(String((value as { attachmentId: string }).attachmentId));
    }
    // Non-trivial, or the disjointness is vacuous.
    expect(deviceIds.length).toBeGreaterThanOrEqual(25);
    const deviceSet = new Set(deviceIds);

    // The dungeon's own id is the subject's id, so the collected list is a *set*:
    // the interesting property is that the copy's identifiers are distinct from the
    // device's, not that one value cannot appear in two fields.
    const copyAll = [
      ...copyIds.subject,
      ...copyIds.rooms,
      ...copyIds.attachments,
      ...copyIds.dungeonId,
      ...copyIds.fish,
      ...copyIds.notes,
      ...copyIds.loot,
    ];
    expect(copyAll.length).toBeGreaterThanOrEqual(15);
    // The copy's identifiers are distinct from each other, which is what makes the
    // disjointness meaningful: two copies of the same archive must not collapse onto
    // one another.
    expect(copyIds.subject).toEqual([imported.importedSubjectId]);
    expect(copyIds.dungeonId).toEqual([imported.importedSubjectId]);
    expect(new Set([...copyIds.rooms, ...copyIds.attachments, ...copyIds.fish, ...copyIds.notes, ...copyIds.loot]).size).toBe(
      copyIds.rooms.length + copyIds.attachments.length + copyIds.fish.length + copyIds.notes.length + copyIds.loot.length,
    );
    for (const id of new Set(copyAll)) {
      expect(deviceSet.has(id), `copy reuses a device identifier: ${id}`).toBe(false);
    }

    // And no *source* id survived anywhere in the copy. This is the whole criterion,
    // stated in the other direction: every source room id is a substring-free
    // absolute statement about absence, not a comparison of two sets the product
    // produced.
    const sourceRooms = new Set(NASTY_ROOM_LIST);
    for (const id of copyIds.rooms) expect(sourceRooms.has(id)).toBe(false);
    expect(copyIds.rooms).toHaveLength(NASTY_ROOM_LIST.length);
    expect(sourceRooms.has(NASTY_SUBJECT_ID)).toBe(false);
    expect(sourceRooms.has(NASTY_OTHER_SUBJECT_ID)).toBe(false);
  });

  it('a second copy of the same archive shares no identifier with the first', async () => {
    // The strongest end-to-end form of collision avoidance. The second import runs
    // against a device that now *holds* the first copy, so every identifier the
    // first copy minted is on the destination and a remapper that did not check
    // would collide. Nothing about the archive changed between the two runs.
    const second = await importSubjectBackup({
      repository: device.repository,
      bytes: archive,
      now: NASTY_DETERMINISM_NOW,
    });
    expect(second.mode).toBe('copy');
    expect(second.importedSubjectId).not.toBe(imported.importedSubjectId);
    const first = new Set(imported.idMapping.map((entry) => entry.to));
    const alsoFirst = new Set([imported.importedSubjectId]);
    for (const entry of second.idMapping) {
      expect(first.has(entry.to), `second copy reused a first-copy identifier: ${entry.kind}`).toBe(false);
      expect(alsoFirst.has(entry.to)).toBe(false);
    }
    // Both copies landed, and both generations are retained.
    const subjects = await valuesOf(device.repository, second.generationId, 'subjects');
    expect(subjects.has(imported.importedSubjectId)).toBe(true);
    expect(subjects.has(second.importedSubjectId)).toBe(true);
    expect(second.previousActiveGenerationId).toBe(imported.generationId);
  });
});

describe('Phase 6 gate 1: every reference inside the copy resolves', () => {
  it('the rooms map, the dungeon, the edges, the tag index, the paths, and the sessions all agree', async () => {
    const subjects = await valuesOf(device.repository, imported.generationId, 'subjects');
    const copy = subjects.get(imported.importedSubjectId) as Record<string, unknown>;
    const snapshot = copy.snapshot as {
      rooms: Record<string, Record<string, unknown>>;
      dungeon: {
        dungeonId: string;
        rootRoomId: string;
        rooms: { roomId: string; topic: string; status: string }[];
        edges: { fromRoomId: string; toRoomId: string }[];
        tagIndex: Record<string, string[]>;
        biome: string;
      };
    };
    const roomIds = new Set(Object.keys(snapshot.rooms));
    // Room **count** first, because it is the only assertion that catches a room
    // lost rather than a room mis-rewritten - and a `__proto__` room is exactly the
    // room an object-keyed rebuild drops without an error.
    expect(roomIds.size).toBe(NASTY_ROOM_LIST.length);

    // Each room's own id equals its key, and its note and artifact paths name it.
    for (const [key, room] of Object.entries(snapshot.rooms)) {
      expect(room.roomId, key).toBe(key);
      const notePath = String(room.notePath);
      const artifactPath = String(room.artifactPath);
      expect(notePath.split('/'), key).toContain(key);
      expect(artifactPath.split('/'), key).toContain(key);
      // ...and neither path still mentions any *source* room id, which is the
      // specific defect a substring rewrite produces.
      for (const source of NASTY_ROOM_LIST) {
        expect(notePath.split('/'), `${key} notePath`).not.toContain(source);
        expect(artifactPath.split('/'), `${key} artifactPath`).not.toContain(source);
      }
    }

    // The dungeon's own references.
    expect(snapshot.dungeon.dungeonId).toBe(imported.importedSubjectId);
    expect(roomIds.has(snapshot.dungeon.rootRoomId)).toBe(true);
    expect(snapshot.dungeon.rooms.map((summary) => summary.roomId).sort()).toEqual([...roomIds].sort());
    expect(snapshot.dungeon.edges.length).toBeGreaterThanOrEqual(6);
    for (const edge of snapshot.dungeon.edges) {
      expect(roomIds.has(edge.fromRoomId), 'edge source room').toBe(true);
      expect(roomIds.has(edge.toRoomId), 'edge target room').toBe(true);
    }

    // The tag index: the keys are still the learner's tag names - two of which are
    // source room ids, and both of which must have survived - and every value is a
    // room of the copy.
    expect(Object.keys(snapshot.dungeon.tagIndex).sort()).toEqual(
      ['cozy-hearth', 'room-1', 'synthetic-tag'],
    );
    for (const [tag, ids] of Object.entries(snapshot.dungeon.tagIndex)) {
      expect(ids.length, tag).toBeGreaterThan(0);
      for (const id of ids) expect(roomIds.has(id), `tag ${tag} value`).toBe(true);
    }
    // The biome is learner-chosen vocabulary, not a reference, and it survived even
    // though it happens to equal a source room id.
    expect(snapshot.dungeon.biome).toBe(NASTY_ROOM_IDS.tagNamed);

    // The sessions: the copy's own two sessions, and their `roomsVisited`.
    const sessions = await valuesOf(device.repository, imported.generationId, 'sessions');
    const copySessions = [...sessions.entries()].filter(([recordId]) => recordId.startsWith('kc-session-'));
    expect(copySessions.length).toBe(2);
    for (const [recordId, value] of copySessions) {
      const session = value as { subjectId: string; roomsVisited: string[] };
      expect(recordId.startsWith('kc-session-'), recordId).toBe(true);
      expect(session.subjectId).toBe(imported.importedSubjectId);
    }
    // Every room a session visited that **was** a room of the subject is now a room
    // of the copy. The one entry that named a room the subject never had is the
    // disclosed residual of the same rule the reader applies: it is carried
    // verbatim, because the alternative is dropping real history, and it is counted
    // in `disclosedWarnings` rather than hidden.
    const first = copySessions[0]?.[1] as { roomsVisited: string[] };
    expect(first.roomsVisited).toHaveLength(3);
    for (const roomId of first.roomsVisited) expect(roomIds.has(roomId), `session visited ${roomId}`).toBe(true);
    const second = copySessions[1]?.[1] as { roomsVisited: string[] };
    expect(second.roomsVisited).toHaveLength(2);
    expect(roomIds.has(second.roomsVisited[0] as string)).toBe(true);
    expect(second.roomsVisited[1]).toBe('room-data-gate-nasty-vanished');
    expect(roomIds.has(second.roomsVisited[1] as string)).toBe(false);
    // The session that named a room the subject does not have is **carried** and
    // disclosed, not dropped: the archive's own record is real history, and
    // dropping it would be data loss.
    const disclosed = imported.disclosedWarnings.find(
      (problem) => problem.code === 'unknown-room-reference' || problem.code === 'unknown-subject-reference',
    );
    expect(disclosed).toBeDefined();
    expect(disclosed?.severity).toBe('warning');

    // The attachments: metadata records resolve to the copy's subject and a room the
    // copy has, and the snapshot's own attachment ids match.
    const metadata = await valuesOf(device.repository, imported.generationId, 'attachmentMetadata');
    const copyMetadata = [...metadata.values()].filter(
      (value) => (value as { subjectId: string }).subjectId === imported.importedSubjectId,
    );
    expect(copyMetadata.length).toBe(2);
    const copyAttachmentIds = new Set<string>();
    for (const value of copyMetadata) {
      const record = value as { roomId: string; availability: string; contentHash: string | null };
      expect(roomIds.has(record.roomId), 'attachment room').toBe(true);
      copyAttachmentIds.add(String((value as { attachmentId: string }).attachmentId));
    }
    const snapshotAttachmentIds = new Set(
      Object.values(snapshot.rooms).flatMap((room) =>
        ((room.attachments as { attachmentId: string }[] | undefined) ?? []).map(
          (attachment) => attachment.attachmentId,
        ),
      ),
    );
    // The orphan attachment the room names and no record owns is remapped too, which
    // is why the snapshot's set is a strict superset of the metadata's.
    expect(snapshotAttachmentIds.size).toBe(3);
    for (const id of copyAttachmentIds) expect(snapshotAttachmentIds.has(id)).toBe(true);
    for (const id of snapshotAttachmentIds) expect(id.startsWith('kc-attachment-'), id).toBe(true);

    // A `stored` attachment has its bytes, and they hash to what the record claims.
    const blobs = await valuesOf(device.repository, imported.generationId, 'attachmentBlobs');
    for (const value of copyMetadata) {
      const record = value as { attachmentId: string; availability: string; contentHash: string | null };
      if (record.availability !== 'stored') {
        expect(record.contentHash).toBeNull();
        expect(blobs.has(`blob:${record.attachmentId}`)).toBe(false);
        continue;
      }
      const blob = blobs.get(`blob:${record.attachmentId}`) as
        | { contentHash: string; bytes: ArrayBuffer; byteLength: number }
        | undefined;
      expect(blob, `blob for ${record.attachmentId}`).toBeDefined();
      expect(blob?.contentHash).toBe(record.contentHash);
      expect(blob?.byteLength).toBeGreaterThan(0);
    }
  });

  it('progression resolves: one record for the copy, keyed by the copy, with fish and notes inside', async () => {
    const progression = await valuesOf(device.repository, imported.generationId, 'progression');
    const copy = progression.get(imported.importedSubjectId) as
      | {
          subjectId: string;
          bySubject: Record<string, Record<string, unknown>>;
          crossSubjectAchievements: string[];
        }
      | undefined;
    expect(copy).toBeDefined();
    expect(copy?.subjectId).toBe(imported.importedSubjectId);
    // The `bySubject` key is the copy's own subject id, and it is the only key the
    // record carries: a foreign key would be disclosed, not invented.
    expect(Object.keys(copy?.bySubject ?? {})).toEqual([imported.importedSubjectId]);
    const perSubject = (copy?.bySubject ?? {})[imported.importedSubjectId] as {
      subjectId: string;
      fishCollection: { id: string; subjectId: string }[];
      collectedNotes: { noteId: string; dungeonId: string; roomId: string }[];
      inventory: { id: string }[];
      equippedItems: { id: string }[];
      extraFields: Record<string, unknown>;
    };
    expect(perSubject.subjectId).toBe(imported.importedSubjectId);
    const subjects = await valuesOf(device.repository, imported.generationId, 'subjects');
    const copySubject = subjects.get(imported.importedSubjectId) as {
      snapshot: { rooms: Record<string, unknown> };
    };
    const roomIds = new Set(Object.keys(copySubject.snapshot.rooms));

    // The fish live inside the progression record, and plan section 7.3's
    // `progression.json` is therefore what carries them. Proved here rather than
    // asserted in prose: two entries, distinct ids, and a fish that names the copy.
    expect(perSubject.fishCollection.length).toBe(2);
    for (const fish of perSubject.fishCollection) {
      expect(fish.id.startsWith('kc-fish-'), fish.id).toBe(true);
      expect(fish.subjectId).toBe(imported.importedSubjectId);
    }
    for (const note of perSubject.collectedNotes) {
      expect(note.noteId.startsWith('kc-note-'), note.noteId).toBe(true);
      expect(note.dungeonId).toBe(imported.importedSubjectId);
      expect(roomIds.has(note.roomId), `collected note room ${note.roomId}`).toBe(true);
    }
    for (const item of [...perSubject.inventory, ...perSubject.equippedItems]) {
      expect(item.id.startsWith('kc-loot-'), item.id).toBe(true);
    }
    // The unknown app-owned fields survived, verbatim, apart from the identifier
    // rewrite in the one that held a room id.
    expect(perSubject.extraFields.fixtureProgressionField).toBe(
      'preserve-this-synthetic-progression-field',
    );
    expect(roomIds.has(String(perSubject.extraFields.fixtureProgressionRoomField))).toBe(true);
    // Cross-subject achievements are carried verbatim, and the count is reported.
    expect(copy?.crossSubjectAchievements).toEqual(['achievement-data-gate-nasty-first']);
    expect(imported.crossSubjectAchievementsCarried).toBe(1);
  });

  it('the copy is fully usable: the activated generation validates, and the copy re-exports', async () => {
    // "Fully usable" is measured by the application's own gate. storage-v2's
    // `validateGeneration` is the same check that decides whether a generation may
    // be activated, so a clean report is the strongest available statement that a
    // learner could open this subject, walk it, and continue.
    const validation = await device.repository.validateGeneration(imported.generationId);
    expect(validation.ok, JSON.stringify(validation.problems)).toBe(true);
    expect(validation.checksumMismatches).toEqual([]);
    for (const delta of Object.values(validation.countDeltas)) expect(delta).toBe(0);
    expect(validation.problems.filter((problem) => problem.severity === 'error')).toEqual([]);

    // ...and the copy can be backed up again, and the archive it produces describes
    // the same subject: two generations, one subject, byte-identical records.
    const reexported = await exportSubjectBackup({
      repository: device.repository,
      generationId: imported.generationId,
      subjectId: imported.importedSubjectId,
      now: NASTY_DETERMINISM_NOW,
      payloadBytes: device.payloadBytes,
    });
    const original = readSubjectArchiveContents(archive);
    const copy = readSubjectArchiveContents(reexported.bytes);
    expect(copy.preview.roomCount).toBe(original.preview.roomCount);
    // Every subject-scoped count is identical...
    for (const key of ['subjects', 'progression', 'sessions', 'attachments', 'attachmentBlobs'] as const) {
      expect(copy.preview.recordCounts[key], key).toBe(original.preview.recordCounts[key]);
    }
    // ...and `assistance` is the one that legitimately grew, because the copy mode
    // mints a fresh identifier for the archive's assistance records rather than
    // overwriting the destination device's own. So a device that has taken N copies
    // holds N+1 assistance records and its next export declares N+1. The
    // alternatives are worse - dropping the archive's history loses the copied
    // subject's assistance, and preserving the ids overwrites this device's own
    // signals with another device's - so the growth is chosen, and it is visible in
    // the manifest rather than silent. See the module header and the follow-up list.
    expect(original.preview.recordCounts.assistance).toBe(1);
    expect(copy.preview.recordCounts.assistance).toBe(2);
    // The re-export is itself a well-formed archive describing the copy, read by the
    // production reader with no disclosure at all - so the copy is not merely
    // storable, it is a first-class subject the product can round-trip.
    expect(copy.preview.disclosedProblems).toEqual([]);
    expect(copy.preview.blockingPolicy).toBe('error-blocks-warning-discloses');
    expect(copy.subjectId).toBe(imported.importedSubjectId);
    // Its room ids are the copy's room ids, not the source's.
    expect(Object.keys((copy.subject.snapshot as { rooms: Record<string, unknown> }).rooms).sort()).toEqual(
      [...roomIdsOf(reexported)].sort(),
    );
  });
});

/** The room ids of an archive's subject, for a gate assertion. */
function roomIdsOf(result: { bytes: Uint8Array }): string[] {
  const contents = readSubjectArchiveContents(result.bytes);
  return Object.keys((contents.subject.snapshot as { rooms: Record<string, unknown> }).rooms);
}

describe('Phase 6 gate 1: the source device is untouched and still working', () => {
  it('the retained previous generation is byte-identical to what the device held before', async () => {
    // The retained generation is the rollback path, so "the source device can keep
    // working" is measured on the generation that was active before the import and
    // is still readable after it. Compared through the shared fingerprint, which
    // reads every record envelope including its own checksum and timestamp.
    const before = await captureDeviceState(device.repository);
    void before;

    // Re-read the retained generation and compare it to the fixture it was staged
    // from, record by record and value by value.
    const retained = await device.repository.readRecords(NASTY_GENERATION_ID);
    const staged = device.staged;
    // Sorted by the record's own identity, because a store is a *set* of records
    // keyed by id and its read order is an index's choice, not a property of the
    // data. Comparing in staging order would be comparing a cursor.
    const byKey = <T extends Record<string, unknown>>(values: readonly T[], key: string): string =>
      canonicalJsonStringify(
        [...values].sort((left, right) => (String(left[key]) < String(right[key]) ? -1 : 1)),
      );
    for (const [store, key] of [
      ['subjects', 'subjectId'],
      ['progression', 'subjectId'],
      ['sessions', 'sessionId'],
      ['assistance', 'assistanceId'],
      ['attachmentMetadata', 'attachmentId'],
      ['attachmentBlobs', 'attachmentId'],
      ['preferences', 'preferenceId'],
      ['shortcuts', 'actionId'],
      ['recovery', 'kind'],
    ] as const) {
      const stored = (retained.records[store] as unknown as StorageRecordEnvelope<
        Record<string, unknown>
      >[]).map((envelope) => envelope.value);
      expect(byKey(stored, key), store).toBe(
        byKey(staged[store] as unknown as Record<string, unknown>[], key),
      );
    }
    // The *other* generation is retained too, byte for byte, so the rollback path
    // goes back two steps and not one.
    const earlier = await device.repository.readRecords(device.priorGenerationId);
    expect(canonicalJsonStringify(earlier.records.subjects.map((e) => e.value))).toBe(
      canonicalJsonStringify([staged.subjects[0]]),
    );
    expect((await device.repository.readGeneration(device.priorGenerationId))?.descriptor?.status).toBe(
      'superseded',
    );
    // The other subject's progression, byte for byte.
    const otherProgression = retained.records.progression.find(
      (envelope) => envelope.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    );
    expect(canonicalJsonStringify(otherProgression?.value)).toBe(
      canonicalJsonStringify(device.otherProgression),
    );
    // The retained generation's descriptor still says it is `superseded` and is
    // still readable, which is the whole of plan section 7.1 step 6.
    const descriptor = await device.repository.readGeneration(NASTY_GENERATION_ID);
    expect(descriptor?.descriptor?.status).toBe('superseded');
    expect(imported.previousGenerationRetained).toBe(true);
    expect(imported.previousActiveGenerationId).toBe(NASTY_GENERATION_ID);
  });

  it('the source subject is still exportable from the device after the copy', async () => {
    const again = await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    });
    expect(again.subjectId).toBe(NASTY_SUBJECT_ID);
    // Byte-identical to the archive the copy was made from, under the same clock.
    // That is the "the source device can keep working" statement: the source is not
    // a different subject now, and it is not degraded.
    expect(again.bytes.byteLength).toBe(archive.byteLength);
    expect(again.manifest.contentChecksum).toBe(
      readSubjectArchiveContents(archive).preview.contentChecksum,
    );
    const contents = readSubjectArchiveContents(again.bytes);
    expect(contents.subjectId).toBe(NASTY_SUBJECT_ID);
    expect(contents.subject.snapshot).toEqual(
      readSubjectArchiveContents(archive).subject.snapshot,
    );
  });

  it('no unrelated subject changed, and the unrelated stores carried forward byte for byte', async () => {
    // The new generation's unrelated subject must be the *same value* as the base's,
    // and the four device-global stores must be the same arrays of the same values.
    const next = await valuesOf(device.repository, imported.generationId, 'subjects');
    const base = await valuesOf(device.repository, NASTY_GENERATION_ID, 'subjects');
    expect(canonicalJsonStringify(next.get(NASTY_OTHER_SUBJECT_ID))).toBe(
      canonicalJsonStringify(base.get(NASTY_OTHER_SUBJECT_ID)),
    );
    expect(canonicalJsonStringify(next.get(NASTY_SUBJECT_ID))).toBe(
      canonicalJsonStringify(base.get(NASTY_SUBJECT_ID)),
    );

    const nextSnapshot = await device.repository.readRecords(imported.generationId);
    const baseSnapshot = await device.repository.readRecords(NASTY_GENERATION_ID);
    for (const store of ['preferences', 'shortcuts', 'customSprites', 'recovery'] as const) {
      expect(
        canonicalJsonStringify(nextSnapshot.records[store].map((envelope) => envelope.value)),
        store,
      ).toBe(canonicalJsonStringify(baseSnapshot.records[store].map((envelope) => envelope.value)));
    }
    expect(imported.carriedForwardStores).toEqual([
      'preferences',
      'shortcuts',
      'customSprites',
      'recovery',
    ]);
    expect(imported.carriedForwardRecordCounts.preferences).toBe(2);
    expect(imported.carriedForwardRecordCounts.shortcuts).toBe(1);
    expect(imported.carriedForwardRecordCounts.recovery).toBe(1);
  });

  it('the fingerprint moves when a record changes, so the comparisons above can fail', async () => {
    // The positive control for this gate. A fingerprint that could not move would
    // make every "unchanged" assertion in this file decorative, so one real change
    // is made through the real repository and required to move the digest and be
    // named in the diff.
    const before = await captureDeviceState(device.repository);
    const beforeFingerprint = fingerprintOf(before);
    const sessionId = 'session-data-gate-nasty-0001';
    const session = (await valuesOf(device.repository, imported.generationId, 'sessions')).get(sessionId) as {
      xpEarned: number;
    };
    await device.repository.putRecords(imported.generationId, {
      sessions: [{ ...session, xpEarned: session.xpEarned + 1 } as never],
    });
    const after = await captureDeviceState(device.repository);
    expect(fingerprintOf(after)).not.toBe(beforeFingerprint);
    const differences = diffDeviceStates(before, after);
    expect(
      differences.some(
        (difference) =>
          difference.kind === 'record' &&
          difference.where.endsWith(`/sessions/${sessionId}`) &&
          difference.field === 'value',
      ),
      describeDifferences(differences),
    ).toBe(true);
  });
});
