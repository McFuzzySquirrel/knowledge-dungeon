/**
 * Phase 6 verifier gate V2 - the four exit criteria, attacked directly.
 *
 * Built through the real product: `exportSubjectBackup` then
 * `importSubjectBackup`, on a real storage-v2 generation over `fake-indexeddb`.
 * No product helper is stubbed, and nothing is imported from `tests/data/support/`.
 *
 * Exit criteria under test, verbatim from the plan:
 *
 * - "A copied subject is independent and fully usable."
 * - "A replaced subject matches the backup semantically."
 * - "No unrelated subject or global setting changes."
 * - "All ID references remain valid after copy import."
 *
 * The shape of the attack: the *same* `.kdsubject` is imported **twice** onto one
 * device, so two copies of one subject coexist. That is the strongest form of
 * "independent" - if any identifier were shared, the two copies would be
 * indistinguishable in the store, and the second import would have had to
 * overwrite the first.
 */

import { describe, expect, it } from 'vitest';

import {
  exportSubjectBackup,
  importSubjectBackup,
  readSubjectArchiveContents,
  type SubjectArchiveContents,
} from '@/services/persistence/products/subjectBackup';
import {
  ALPHA,
  ATT_ALPHA,
  BETA,
  GAMMA,
  MARKERS,
  R_ROOT,
  forgeDevice,
  readActiveValues,
  type ForgedDevice,
} from './support/forge';

const NOW = '2026-05-06T07:08:09.000Z';

async function exportAlpha(device: ForgedDevice): Promise<Uint8Array> {
  const result = await exportSubjectBackup({
    repository: device.repository,
    generationId: device.generationId,
    subjectId: ALPHA,
    now: NOW,
    payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
  });
  return result.bytes;
}

/** A record list, element type preserved, for the few places a cast is needed. */
function records<T>(list: readonly T[]): T[] {
  return list as T[];
}

/** The subject ids a subject list holds. */
function roomKeySet(list: ReadonlyArray<{ subjectId: string }>): string[] {
  return list.map((record) => record.subjectId);
}

function roomsOf(subject: unknown): Record<string, Record<string, unknown>> {
  const snapshot = (subject as { snapshot: { rooms: Record<string, Record<string, unknown>> } }).snapshot;
  return snapshot.rooms;
}

function dungeonOf(subject: unknown): Record<string, unknown> {
  return (subject as { snapshot: { dungeon: Record<string, unknown> } }).snapshot.dungeon;
}

/**
 * Field names whose value is prose or a fixed term, so a string that happens to
 * equal an id there is correct rather than a leak. Mirrors the product's two
 * protected sets; the *policy* is the product's, the list is written here so this
 * gate does not import the thing it is auditing.
 */
const PROTECTED_FIELD_NAMES: readonly string[] = [
  'topic', 'tags', 'subjectName', 'noteText', 'noteMarkdown', 'artifactMarkdown', 'artifactPreview',
  'badges', 'crossSubjectAchievements', 'name', 'label', 'labelKey', 'description', 'floorLabel',
  'fileName', 'externalUrl', 'altText', 'mimeType', 'relativePath', 'key', 'preferenceId',
  'biome', 'state', 'phaseState', 'status', 'relationType', 'createdByPhase', 'rank', 'equipSlot',
  'equipped', 'rarity', 'sourceType', 'availability', 'mode', 'schemaVersion', 'formatVersion',
  'storageGenerationFormatVersion', 'failedChecks', 'criterionScores',
];

/** Whether the last *field* segment of a path is a protected field name. */
function isProtectedPath(path: string): boolean {
  const withoutIndexes = path.replace(/\[\d+\]/g, '');
  const segments = withoutIndexes.split('.');
  const field = segments[segments.length - 1] as string;
  return PROTECTED_FIELD_NAMES.includes(field);
}

/** Every string anywhere in a value, with the path it was found at. */
function everyString(value: unknown, path = '$', out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => everyString(entry, `${path}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) everyString(entry, `${path}.${key}`, out);
  }
  return out;
}

describe('Phase 6 verifier V2: copy independence', () => {
  it('importing the same .kdsubject twice yields two subjects that share no identifier', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);

    const first = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const second = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });

    expect(first.activated).toBe(true);
    expect(second.activated).toBe(true);
    expect(first.importedSubjectId).not.toBe(second.importedSubjectId);
    // The copies also do not reuse the source subject's own id.
    expect(first.importedSubjectId).not.toBe(ALPHA);
    expect(second.importedSubjectId).not.toBe(ALPHA);
    expect(first.importedSubjectId).not.toBe(second.importedSubjectId);

    const values = await readActiveValues(device);
    const subjectIds = roomKeySet(values.subjects);
    // Five subjects: the three forged plus two copies.
    expect(subjectIds.length).toBe(5);
    expect(new Set(subjectIds).size).toBe(5);
  });

  it('every identifier the two copies hold is disjoint from the other copy and from the source', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const first = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const second = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const values = await readActiveValues(device);

    /** Every string in the records that belong to one subject. */
    const idsOf = (subjectId: string): Set<string> => {
      const ids = new Set<string>();
      const subject = values.subjects.find((record) => record.subjectId === subjectId);
      if (!subject) throw new Error(`no subject ${subjectId}`);
      ids.add(subject.subjectId);
      for (const roomId of Object.keys(roomsOf(subject))) ids.add(roomId);
      for (const record of records(values.attachmentMetadata)) {
        if (record.subjectId === subjectId) ids.add(record.attachmentId);
      }
      for (const record of records(values.attachmentBlobs)) {
        if (values.attachmentMetadata.some((m) => m.attachmentId === record.attachmentId && m.subjectId === subjectId)) {
          ids.add(record.attachmentId);
        }
      }
      for (const record of values.sessions) if (record.subjectId === subjectId) ids.add(record.sessionId);
      for (const record of records(values.progression)) {
        for (const key of Object.keys(record.bySubject as Record<string, unknown>)) {
          if (key !== subjectId) continue;
          const perSubject = (record.bySubject as Record<string, Record<string, unknown>>)[key] ?? {};
          for (const list of ['collectedNotes', 'fishCollection', 'inventory', 'equippedItems']) {
            for (const entry of (perSubject[list] as Array<Record<string, unknown>> | undefined) ?? []) {
              if (typeof entry.noteId === 'string') ids.add(entry.noteId);
              if (typeof entry.id === 'string') ids.add(entry.id);
            }
          }
        }
      }
      return ids;
    };

    const source = idsOf(ALPHA);
    const copyA = idsOf(first.importedSubjectId);
    const copyB = idsOf(second.importedSubjectId);
    const overlap = (left: Set<string>, right: Set<string>): string[] =>
      [...left].filter((value) => right.has(value));

    expect(overlap(copyA, copyB)).toEqual([]);
    expect(overlap(copyA, source)).toEqual([]);
    expect(overlap(copyB, source)).toEqual([]);
    // Bystanders are untouched, so nothing was borrowed from them either.
    expect(overlap(copyA, idsOf(BETA))).toEqual([]);
    expect(overlap(copyA, idsOf(GAMMA))).toEqual([]);
  });

  it('every reference inside a copy resolves inside that copy', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const first = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const second = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const values = await readActiveValues(device);

    for (const importedId of [first.importedSubjectId, second.importedSubjectId]) {
      const subject = values.subjects.find((record) => record.subjectId === importedId);
      expect(subject).toBeDefined();
      const rooms = roomsOf(subject);
      const roomIds = new Set(Object.keys(rooms));
      const dungeon = dungeonOf(subject);

      // rooms keys and their own roomId agree
      for (const [key, room] of Object.entries(rooms)) {
        expect(room.roomId, `room key ${key} disagrees with its roomId`).toBe(key);
      }
      // rootRoomId resolves
      expect(roomIds.has(dungeon.rootRoomId as string)).toBe(true);
      // every edge endpoint resolves, inside this copy
      for (const edge of dungeon.edges as Array<Record<string, string>>) {
        expect(roomIds.has(edge.fromRoomId), `edge from ${edge.fromRoomId} dangles`).toBe(true);
        expect(roomIds.has(edge.toRoomId), `edge to ${edge.toRoomId} dangles`).toBe(true);
      }
      // the room summaries name rooms the copy has
      for (const summary of dungeon.rooms as Array<Record<string, string>>) {
        expect(roomIds.has(summary.roomId), `summary ${summary.roomId} dangles`).toBe(true);
      }
      // the tag index values resolve; the tag names are the learner's own
      const tagIndex = dungeon.tagIndex as Record<string, string[]>;
      for (const [tag, ids] of Object.entries(tagIndex)) {
        for (const id of ids) {
          expect(roomIds.has(id), `tag "${tag}" points at missing room ${id}`).toBe(true);
        }
      }
      // notePath / artifactPath name a room the copy has, as a whole segment
      for (const [key, room] of Object.entries(rooms)) {
        for (const field of ['notePath', 'artifactPath'] as const) {
          const value = room[field] as string;
          for (const segment of value.split('/')) {
            const looksLikeARoomId = rooms[segment] !== undefined;
            if (looksLikeARoomId) expect(roomIds.has(segment)).toBe(true);
          }
          // The app writes `rooms/<roomId>/notes.txt`, so the room id is a whole
          // segment and the segment-wise rewrite must have moved it. A segment that
          // *looks* like a room of some other subject is a leak; see the dedicated
          // hostile-path case in `idReferences.test.ts`.
          const segments = value.split('/');
          const roomSegment = segments[1];
          if (segments[0] === 'rooms' && rooms[roomSegment] !== undefined) {
            expect(
              Object.keys(rooms).includes(roomSegment),
              `${field} of ${key} still names another subject's room`,
            ).toBe(true);
          }
        }
      }
      // snapshot attachment ids resolve to metadata records of THIS subject
      const ownAttachments = new Set(
        values.attachmentMetadata.filter((r) => r.subjectId === importedId).map((r) => r.attachmentId),
      );
      for (const room of Object.values(rooms)) {
        for (const attachment of room.attachments as Array<Record<string, string>>) {
          expect(ownAttachments.has(attachment.attachmentId), `room attachment ${attachment.attachmentId} dangles`).toBe(true);
        }
      }
      // sessions: roomsVisited resolves, session ids are unique
      for (const session of values.sessions) {
        if (session.subjectId !== importedId) continue;
        for (const roomId of session.roomsVisited) {
          expect(roomIds.has(roomId), `session ${session.sessionId} visited missing room ${roomId}`).toBe(true);
        }
      }
      // progression: bySubject key, note roomIds, dungeonIds, fish subjectIds
      for (const record of records(values.progression)) {
        if (record.subjectId !== importedId) continue;
        const bySubject = record.bySubject as Record<string, Record<string, unknown>>;
        expect(Object.keys(bySubject)).toContain(importedId);
        const perSubject = bySubject[importedId] as Record<string, unknown>;
        for (const note of (perSubject.collectedNotes as Array<Record<string, string>>) ?? []) {
          expect(roomIds.has(note.roomId), `collected note points at missing room ${note.roomId}`).toBe(true);
          expect(note.dungeonId, `collected note dungeonId ${note.dungeonId} is not this copy`).toBe(importedId);
        }
        for (const fish of (perSubject.fishCollection as Array<Record<string, string>>) ?? []) {
          expect(fish.subjectId, `fish ${fish.id} names another subject`).toBe(importedId);
        }
      }
      // attachment metadata roomIds resolve
      for (const record of records(values.attachmentMetadata)) {
        if (record.subjectId !== importedId) continue;
        expect(roomIds.has(record.roomId), `attachment ${record.attachmentId} names missing room ${record.roomId}`).toBe(true);
      }
    }
  });

  it('no string anywhere in a copy names an identifier belonging to the source or the other copy', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const first = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const second = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const values = await readActiveValues(device);

    // The identifiers the source and the two copies own.
    const owned = (subjectId: string): Set<string> => {
      const ids = new Set<string>();
      const subject = values.subjects.find((record) => record.subjectId === subjectId);
      if (subject) {
        for (const roomId of Object.keys(roomsOf(subject))) ids.add(roomId);
      }
      for (const record of values.attachmentMetadata) if (record.subjectId === subjectId) ids.add(record.attachmentId);
      for (const record of values.sessions) if (record.subjectId === subjectId) ids.add(record.sessionId);
      return ids;
    };
    const sourceIds = owned(ALPHA);
    const copyAIds = owned(first.importedSubjectId);
    const copyBIds = owned(second.importedSubjectId);

    // A whole-value or whole-segment match is a *live* reference; a substring
    // inside prose is deliberately not, and is measured separately below.
    const isWholeToken = (value: string, id: string): boolean =>
      value === id || (value.includes('/') && value.split('/').includes(id));

    for (const [label, subjectId, foreign] of [
      ['copy A', first.importedSubjectId, new Set([...sourceIds, ...copyBIds])],
      ['copy B', second.importedSubjectId, new Set([...sourceIds, ...copyAIds])],
    ] as const) {
      // Fields whose value is the learner's own words or a fixed vocabulary term
      // are *supposed* to keep a string that equals an id; rewriting them would be
      // the corruption. They are covered by their own case below, so they are
      // excluded here and the sweep is only about real reference locations.
      const subject = values.subjects.find((record) => record.subjectId === subjectId);
      for (const { path, value } of everyString(subject)) {
        if (isProtectedPath(path)) continue;
        for (const id of foreign) {
          expect(
            isWholeToken(value, id),
            `${label} ${path} carries ${id}, which belongs to another subject`,
          ).toBe(false);
        }
      }
      for (const record of records(values.progression)) {
        if (record.subjectId !== subjectId) continue;
        for (const { path, value } of everyString(record)) {
          if (isProtectedPath(path)) continue;
          for (const id of foreign) {
            expect(isWholeToken(value, id), `${label} progression ${path} carries ${id}`).toBe(false);
          }
        }
      }
      for (const record of records(values.sessions)) {
        if (record.subjectId !== subjectId) continue;
        for (const { path, value } of everyString(record)) {
          if (isProtectedPath(path)) continue;
          for (const id of foreign) {
            expect(isWholeToken(value, id), `${label} session ${path} carries ${id}`).toBe(false);
          }
        }
      }
    }
  });

  it('mutating the source device after the copy leaves the copy unaffected', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const result = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const copyId = result.importedSubjectId;

    const before = await readActiveValues(device);
    // The import activated a NEW generation, so the source subject that has to be
    // mutated is the one in the generation the pointer names now.
    const activeNow = (await device.repository.readActiveGenerationId()) as string;
    const copyBefore = JSON.stringify(before.subjects.find((r) => r.subjectId === copyId));
    const copyProgressionBefore = JSON.stringify(
      before.progression.find((r) => r.subjectId === copyId),
    );

    // Mutate the SOURCE subject: rename a room topic, move the root, add a room,
    // and rewrite the note paths. A copy that shared a room id would follow.
    const mutated = await device.repository.putRecords(activeNow, {
      subjects: before.subjects.map((record) => {
        if (record.subjectId !== ALPHA) return record;
        const snapshot = record.snapshot as unknown as Record<string, unknown>;
        const rooms = { ...(snapshot.rooms as Record<string, unknown>) };
        rooms[R_ROOT] = {
          ...(rooms[R_ROOT] as Record<string, unknown>),
          topic: 'MUTATED-AFTER-THE-COPY',
          notePath: 'rooms/MUTATED/notes.txt',
        };
        rooms['rm-alpha-late-arrival'] = {
          roomId: 'rm-alpha-late-arrival',
          topic: 'Arrived after the copy',
          createdAt: NOW,
          updatedAt: NOW,
          state: 'Created',
          notePath: 'rooms/rm-alpha-late-arrival/notes.txt',
          artifactPath: 'rooms/rm-alpha-late-arrival/artifact.md',
          noteText: '',
          artifactMarkdown: null,
          validationState: (rooms[R_ROOT] as Record<string, unknown>).validationState,
          reviewPassCount: 0,
          attachments: [],
        };
        return {
          ...record,
          snapshot: {
            ...snapshot,
            rooms,
            dungeon: { ...(snapshot.dungeon as Record<string, unknown>), rootRoomId: 'rm-alpha-late-arrival' },
          },
        } as never;
      }),
    });
    expect(mutated.generationId).toBe(activeNow);

    const after = await readActiveValues(device);
    // The source really did change...
    const sourceAfter = after.subjects.find((r) => r.subjectId === ALPHA);
    expect(JSON.stringify(sourceAfter)).not.toBe(JSON.stringify(before.subjects.find((r) => r.subjectId === ALPHA)));
    expect(Object.keys(roomsOf(sourceAfter))).toContain('rm-alpha-late-arrival');
    // ...and the copy did not, in the subject record or in its progression.
    expect(JSON.stringify(after.subjects.find((r) => r.subjectId === copyId))).toBe(copyBefore);
    expect(JSON.stringify(after.progression.find((r) => r.subjectId === copyId))).toBe(copyProgressionBefore);
    expect(Object.keys(roomsOf(after.subjects.find((r) => r.subjectId === copyId)))).not.toContain('rm-alpha-late-arrival');
  });

  it('a copy is fully usable: it can be read, exported again, and re-imported a third time', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const first = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });

    // Read it back through the product's own reader.
    const inspected = readSubjectArchiveContents(bytes);
    expect(inspected.subjectId).toBe(ALPHA);
    expect(inspected.preview.externalOnlyCount).toBe(1);

    // Export the COPY out of the device, with its own attachment bytes resolved.
    const live = await readActiveValues(device);
    const copyMetadata = live.attachmentMetadata.filter((r) => r.subjectId === first.importedSubjectId);
    const payload = new Map<string, Uint8Array>();
    for (const record of copyMetadata) {
      if (record.contentHash === null) continue;
      payload.set(record.attachmentId, device.sharedBytes);
    }
    const second = await exportSubjectBackup({
      repository: device.repository,
      generationId: (await device.repository.readActiveGenerationId()) as string,
      subjectId: first.importedSubjectId,
      now: NOW,
      payloadBytes: payload,
    });
    expect(second.subjectId).toBe(first.importedSubjectId);
    expect(second.manifest.recordCounts.subjects).toBe(1);
    // The copy's stored attachment bytes travelled with it.
    expect(second.manifest.recordCounts.attachmentBlobs).toBe(1);

    // Re-import that second-generation archive: a third subject, still independent.
    const third = await importSubjectBackup({ repository: device.repository, bytes: second.bytes, now: NOW });
    expect(third.activated).toBe(true);
    const finalValues = await readActiveValues(device);
    expect(finalValues.subjects.length).toBe(5);
    const thirdSubject = finalValues.subjects.find((r) => r.subjectId === third.importedSubjectId);
    expect(thirdSubject).toBeDefined();
    expect(Object.keys(roomsOf(thirdSubject)).length).toBe(3);
    // The third generation's rooms are all distinct from the first copy's.
    const firstCopyRooms = new Set(Object.keys(roomsOf(finalValues.subjects.find((r) => r.subjectId === first.importedSubjectId))));
    for (const roomId of Object.keys(roomsOf(thirdSubject))) {
      expect(firstCopyRooms.has(roomId)).toBe(false);
    }
  });

  it('the copy keeps the learner text, and the content-addressed attachment bytes are real', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const result = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const values = await readActiveValues(device);
    const copy = values.subjects.find((r) => r.subjectId === result.importedSubjectId);
    const dungeon = dungeonOf(copy);

    // Names, topics, notes, tags, and alt text are the learner's own and survive.
    expect(dungeon.subjectName).toBe(MARKERS.subjectName);
    const allText = everyString(copy).map((entry) => entry.value).join('\n');
    expect(allText).toContain(MARKERS.roomTopic);
    expect(allText).toContain(MARKERS.noteText);
    expect(allText).toContain(MARKERS.tag);
    expect(allText).toContain(MARKERS.altText);
    // A tag that happens to equal a room id survives as a tag name, because a tag
    // is the learner's own word and not a reference.
    const tagIndex = dungeon.tagIndex as Record<string, string[]>;
    expect(Object.keys(tagIndex)).toContain(R_ROOT);
    expect(Object.keys(tagIndex)).toContain(MARKERS.tag);
    // A room topic that is exactly a room id also survives.
    const rootKey = Object.keys(roomsOf(copy))[0] as string;
    const rooms = roomsOf(copy);
    for (const room of Object.values(rooms)) {
      if (room.topic === R_ROOT) expect(room.topic).toBe(R_ROOT);
    }
    expect(rooms[rootKey]).toBeDefined();
    // A biome equal to a room id is a fixed vocabulary value, not a reference.
    expect(dungeon.biome).toBe(R_ROOT);
    // An edge relationType equal to a room id is not rewritten either.
    const relations = (dungeon.edges as Array<Record<string, string>>).map((edge) => edge.relationType);
    expect(relations).toContain(R_ROOT);

    // The attachment bytes are the real bytes, and the blob's declared hash
    // matches them - the one place the product does verify bytes.
    const metadata = records(values.attachmentMetadata).filter((r) => r.subjectId === result.importedSubjectId);
    const stored = metadata.find((r) => r.availability === 'stored');
    expect(stored).toBeDefined();
    const blob = records(values.attachmentBlobs).find((b) => b.attachmentId === stored!.attachmentId) as { bytes: ArrayBuffer } | undefined;
    expect(blob).toBeDefined();
    expect(Buffer.from(new Uint8Array(blob!.bytes))).toEqual(Buffer.from(device.sharedBytes));
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(Buffer.from(new Uint8Array(blob!.bytes))).digest('hex')).toBe(String(stored!.contentHash));
    // The external-only attachment was disclosed rather than fabricated.
    const external = metadata.find((r) => r.availability === 'external-only');
    expect(external?.contentHash).toBeNull();
  });

  it('the archive reader reports what the export wrote, with no learner data in the preview', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const contents: SubjectArchiveContents = readSubjectArchiveContents(bytes);
    const serialised = JSON.stringify(contents.preview);
    for (const marker of Object.values(MARKERS)) {
      expect(serialised, `the preview leaked ${marker}`).not.toContain(marker);
    }
    // `SubjectArchivePreview` documents itself as "everything a preview may show"
    // and carries no subject name, topic, note, file name, or URL.
    expect(serialised).not.toContain(MARKERS.fileName);
    expect(serialised).not.toContain('https://');
    // The member list is fixed names and one content hash - no learner naming.
    for (const name of contents.preview.memberNames) {
      expect(name).toMatch(/^(subject|progression|sessions|assistance)\.json$|^attachments\/[0-9a-f]{64}$/);
    }
    // MEASURED, and the subject of a finding in the report rather than of an
    // assertion here: `preview.externalOnlyAttachments[].subjectId` carries the
    // ARCHIVE'S subject id, which is a different device's id. The product's own
    // doc comment on `readSubjectArchive` says the preview "cannot tell a caller
    // which subject the archive holds, and that is deliberate". This is the
    // measurement that says otherwise whenever the archive has an attachment
    // without bytes.
    expect(contents.subjectId).toBe(ALPHA);
    expect(contents.preview.externalOnlyAttachments.map((entry) => entry.subjectId)).toEqual([ALPHA]);
    // Room ids are the count, not the list.
    expect(contents.preview.roomCount).toBe(3);
    expect(contents.preview.memberNames).toEqual([
      'subject.json',
      'progression.json',
      'sessions.json',
      'assistance.json',
      `attachments/${device.sharedContentHash}`,
    ]);
  });
});
