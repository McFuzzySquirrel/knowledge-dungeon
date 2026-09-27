/**
 * Phase 6 data-product gate 4: copy-mode identifier remapping is exhaustive.
 *
 * Plan section 7.3: the default import mode "remaps subject, room, edge, fish,
 * session, and attachment identifiers". This gate holds that list, and then holds it
 * against a subject nastier than any Phase 5 fixture - a room id that is a strict
 * prefix of another, a room id made of regular expression metacharacters, a room id
 * containing an astral-plane character, a room id that is also a tag name, a room id
 * that is an `Object.prototype` name, and an unknown app-owned field holding a room id
 * at six levels.
 *
 * The remapper is tested as the **pure function it is declared to be**, with no
 * archive, no ZIP codec, and no `fake-indexeddb` in the way, because that is what
 * makes each rule separately falsifiable. The end-to-end proof that the remapped
 * records are what the product actually writes is `subjectCopyIndependence.test.ts`;
 * this file proves the rules.
 *
 * What is held here:
 *
 * - **The two substring-sibling rooms.** `room-1` and `room-1a` are in the same
 *   subject, the same `tagIndex` array, the same session's `roomsVisited`, and each
 *   other's `notePath` segments. Every one of those is asserted individually, because
 *   a rewrite that handles the `rooms` map and forgets the paths still looks right.
 * - **No string replacement, anywhere.** The metacharacter room id is compared with
 *   `===`, so no escaping can be wrong; the astral-plane id is compared the same way.
 * - **Protected text survives.** A room topic that *is* another room's id, a subject
 *   name that *begins with* a room id, a biome that *equals* a room id, two tags that
 *   are room ids, a fish `subjectName` that is a room id, and a session `subjectName`
 *   that is a room id - all carried verbatim. The subject snapshot's own
 *   `progression` mirror keeps its fish, so those are covered too.
 * - **Unknown fields.** An unknown field holding a room id, at six levels, is
 *   rewritten; an unknown field holding a room id inside a path is rewritten
 *   segment-wise; and an unknown field holding a room id as **prose** is carried
 *   verbatim and counted. That last one is the disclosed residual, and the count is
 *   asserted rather than assumed.
 * - **Collision avoidance, against an adversarial generator.** A generator that
 *   returns a value the destination already holds, then a `Object.prototype` name,
 *   then a blank, and only then something free: every one of those is skipped and the
 *   mint still succeeds, and the result collides with nothing. A generator that
 *   returns nothing usable at all is refused with a typed error rather than producing
 *   a record that cannot be stored.
 * - **Purity and idempotence.** The same input and the same generator produce the
 *   same output; two different generators produce two different outputs; and the
 *   function touches no clock, no repository, and no randomness.
 *
 * Privacy: every assertion is about identifiers, counts, and the *shape* of a rewrite.
 * No assertion copies a subject name, a topic, a note, a filename, or a URL into a
 * failure message; a protected-text assertion compares against a constant this file
 * declares, and says only pass or fail.
 */

import { describe, expect, it } from 'vitest';

import {
  isSanitizedDetailText,
  StorageV2Error,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import { createDeterministicIdFactory } from '@/services/persistence/v2/database';
import {
  FIXED_VOCABULARY_FIELDS,
  PATH_FIELDS_REWRITTEN_BY_SEGMENT,
  PROTECTED_FIELDS,
  PROTECTED_TEXT_FIELDS,
  SUBJECT_ID_KIND_PREFIX,
  SUBJECT_ID_KINDS,
  SUBJECT_ID_MINT_ATTEMPTS,
  remapSubjectRecords,
  type SubjectIdGenerator,
  type SubjectIdKind,
  type SubjectRemapInput,
} from '@/services/persistence/products/idRemapping';
import {
  NASTY_ATTACHMENT_IDS,
  NASTY_DEVICE_NOW,
  NASTY_ROOM_IDS,
  NASTY_ROOM_LIST,
  NASTY_ROOM_TOPIC_EQUALS_A_ROOM_ID,
  NASTY_SUBJECT_ID,
  NASTY_SUBJECT_NAME_EQUALS_A_ROOM_ID,
  NASTY_TAGS,
  createNastySubjectDevice,
  nastySnapshot,
} from './support/nastySubject';

const NOW = '2026-10-03T00:00:00.000Z';

/**
 * A generator that offers a declared hostile prefix, then free values forever.
 *
 * A pure cycle would not do: every candidate in it is offered a second time once the
 * first has been reserved, so the mint would exhaust its bound and the test would be
 * measuring exhaustion rather than collision avoidance. The prefix is therefore
 * offered once each, and the tail is monotonic.
 */
function sequenceGenerator(prefix: readonly string[]): SubjectIdGenerator {
  let index = 0;
  return {
    next(): string {
      if (index < prefix.length) {
        const value = prefix[index] as string;
        index += 1;
        return value;
      }
      const value = `free-${String(index - prefix.length + 1).padStart(4, '0')}`;
      index += 1;
      return value;
    },
  };
}

/** A generator that never returns anything usable. */
function deadGenerator(): SubjectIdGenerator {
  return { next: () => '' };
}

/**
 * One remap input, built from the nasty fixture's own records so the rules are
 * tested against real record values rather than hand-written ones.
 */
async function remapInput(
  overrides: Partial<SubjectRemapInput> = {},
): Promise<SubjectRemapInput> {
  const device = await createNastySubjectDevice('kd-data-gate-remap');
  const { readSubjectArchiveContents } = await import(
    '@/services/persistence/products/subjectBackup'
  );
  const { exportSubjectBackup } = await import('@/services/persistence/products/subjectBackup');
  const archive = (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: device.subjectId,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
  const contents = readSubjectArchiveContents(archive);
  return {
    subject: contents.subject,
    progression: contents.progression,
    sessions: contents.sessions,
    assistance: contents.assistance,
    attachmentMetadata: contents.attachmentMetadata,
    attachmentBlobs: contents.attachmentBlobs,
    existing: { taken: new Set<string>() },
    generator: createDeterministicIdFactory('gate'),
    now: NOW,
    ...overrides,
  };
}

/** The room-id mapping, as a lookup from source room id to its replacement. */
function roomMap(result: { mapping: ReadonlyArray<{ kind: SubjectIdKind; from: string; to: string }> }): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of result.mapping) if (entry.kind === 'room') out.set(entry.from, entry.to);
  return out;
}

describe('Phase 6 gate 4: the declared room-id locations are all rewritten', () => {
  it('the rooms map, the room ids, the paths, the edges, the root, the tag values, and the summaries', async () => {
    const result = remapSubjectRecords(await remapInput());
    const map = roomMap(result);
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, Record<string, unknown>>;
      dungeon: {
        dungeonId: string;
        rootRoomId: string;
        rooms: { roomId: string }[];
        edges: { fromRoomId: string; toRoomId: string; fixtureEdgeField: string }[];
        tagIndex: Record<string, string[]>;
        biome: string;
        progression: { fishCollection: { subjectId: string }[]; fixtureProgressionField: string };
        fixtureDungeonField: string;
      };
      unknownTopLevelField: string;
      unknownTopLevelPathField: string;
      unknownTopLevelProseField: string;
    };

    // Every source room has a replacement, and the replacements are distinct.
    expect(map.size).toBe(NASTY_ROOM_LIST.length);
    expect(new Set(map.values()).size).toBe(NASTY_ROOM_LIST.length);
    for (const [from, to] of map) {
      expect(from, 'a source id must never be its own replacement').not.toBe(to);
      expect(to).toMatch(/^kc-room-/);
    }

    // The `rooms` keys, and each room's own `roomId`.
    expect(Object.keys(snapshot.rooms).sort()).toEqual([...map.values()].sort());
    for (const [key, room] of Object.entries(snapshot.rooms)) {
      expect(room.roomId).toBe(key);
    }

    // Each `notePath` and `artifactPath` names its **own** new room, segment-wise.
    for (const [key, room] of Object.entries(snapshot.rooms)) {
      for (const field of PATH_FIELDS_REWRITTEN_BY_SEGMENT) {
        const segments = String(room[field]).split('/');
        expect(segments, `${key} ${field}`).toContain(key);
        for (const source of NASTY_ROOM_LIST) {
          expect(segments, `${key} ${field} still names ${source}`).not.toContain(source);
        }
      }
    }

    // The dungeon's own references, and the summary list.
    expect(snapshot.dungeon.dungeonId).toBe(result.subject.subjectId);
    expect(snapshot.dungeon.rootRoomId).toBe(map.get(NASTY_ROOM_IDS.substring));
    expect(snapshot.dungeon.rooms.map((summary) => summary.roomId).sort()).toEqual([...map.values()].sort());
    for (const edge of snapshot.dungeon.edges) {
      expect(map.values()).toContain(edge.fromRoomId);
      expect(map.values()).toContain(edge.toRoomId);
    }
    // The dungeon's own progression mirror keeps its fish, with the subject context
    // rewritten - plan section 5.2 requires exactly one explicit subject context
    // from pond entry through collection.
    for (const fish of snapshot.dungeon.progression.fishCollection) {
      expect(fish.subjectId).toBe(result.subject.subjectId);
    }
    // The unknown fields at the top level and the dungeon level.
    expect(snapshot.unknownTopLevelField).toBe(map.get(NASTY_ROOM_IDS.unicode));
    expect(snapshot.dungeon.fixtureDungeonField).toBe(map.get(NASTY_ROOM_IDS.substringSibling));
    expect(snapshot.dungeon.progression.fixtureProgressionField).toBe(map.get(NASTY_ROOM_IDS.prototype));
    // ...and the unknown field on an edge.
    expect(snapshot.dungeon.edges[0]?.fixtureEdgeField).toBe(map.get(NASTY_ROOM_IDS.tagNamed));
  });

  it('the two substring-sibling rooms are independent in every place both appear', async () => {
    const result = remapSubjectRecords(await remapInput());
    const map = roomMap(result);
    const short = map.get(NASTY_ROOM_IDS.substring) as string;
    const long = map.get(NASTY_ROOM_IDS.substringSibling) as string;
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, { notePath: string; topic: string; tags: string[]; fixtureRoomField: string; fixtureRoomPointerField: string; fixtureRoomProseField: string }>;
      dungeon: { edges: { fromRoomId: string; toRoomId: string }[]; tagIndex: Record<string, string[]> };
    };

    // Different replacements.
    expect(short).not.toBe(long);
    // The shorter room's path names the shorter room and not the longer one, and the
    // longer room's path names the longer one. A substring rewrite fails here.
    expect(snapshot.rooms[short]?.notePath.split('/')).toEqual(
      ['rooms', short, 'notes.md'],
    );
    expect(snapshot.rooms[long]?.notePath.split('/')).toEqual(['rooms', long, 'notes.md']);
    expect(snapshot.rooms[short]?.notePath).not.toContain(long);
    expect(snapshot.rooms[long]?.notePath).not.toContain(short);
    // The one tag array that holds both, with both rewritten independently.
    const shared = snapshot.dungeon.tagIndex[NASTY_TAGS[0] as string] as string[];
    expect(shared).toHaveLength(2);
    expect(shared).toContain(short);
    expect(shared).toContain(long);
    // The unknown pointer field in each room.
    expect(snapshot.rooms[short]?.fixtureRoomPointerField.split('/')).toEqual([
      'rooms',
      short,
      'notes.md',
    ]);
    expect(snapshot.rooms[long]?.fixtureRoomPointerField.split('/')).toEqual([
      'rooms',
      long,
      'notes.md',
    ]);
    // The edge between them.
    const edge = snapshot.dungeon.edges.find(
      (entry) => entry.fromRoomId === short && entry.toRoomId === long,
    );
    expect(edge).toBeDefined();
    // The session that visited both.
    const session = result.sessions.find((entry) =>
      entry.roomsVisited.includes(short),
    );
    expect(session?.roomsVisited).toContain(long);
    // The prose residual in each room still names its **own** source id, because a
    // room id inside prose is not a reference and is carried verbatim.
    expect(snapshot.rooms[short]?.fixtureRoomProseField).toContain(NASTY_ROOM_IDS.substring);
    expect(snapshot.rooms[long]?.fixtureRoomProseField).toContain(NASTY_ROOM_IDS.substringSibling);
  });

  it('a metacharacter room id and an astral-plane room id survive, and nothing is compiled', async () => {
    const result = remapSubjectRecords(await remapInput());
    const map = roomMap(result);
    // The metacharacter id is a *key* of a real record and was replaced by whole-token
    // equality, so no regular expression was ever built from it and there is nothing
    // to escape. The astral-plane id is a pair of code units compared with `===`.
    expect(map.has(NASTY_ROOM_IDS.metachar)).toBe(true);
    expect(map.has(NASTY_ROOM_IDS.unicode)).toBe(true);
    expect(map.get(NASTY_ROOM_IDS.metachar)).not.toContain('(');
    expect(map.get(NASTY_ROOM_IDS.unicode)).not.toContain('🌊');
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, { notePath: string; fixtureRoomField: string }>;
    };
    for (const source of [NASTY_ROOM_IDS.metachar, NASTY_ROOM_IDS.unicode]) {
      const target = map.get(source) as string;
      expect(snapshot.rooms[target]?.notePath).toBe(`rooms/${target}/notes.md`);
      expect(snapshot.rooms[target]?.fixtureRoomField).toBe(target);
    }
    // The source fixture really does carry those hazards, so the assertions above are
    // about the product and not about a fixture that quietly normalised them away.
    const source = nastySnapshot() as unknown as {
      rooms: Record<string, { notePath: string }>;
      dungeon: { edges: { fromRoomId: string }[] };
    };
    expect(source.rooms[NASTY_ROOM_IDS.metachar]?.notePath).toContain('(x)');
    expect(source.rooms[NASTY_ROOM_IDS.unicode]?.notePath).toContain('🌊');
    expect(source.dungeon.edges.some((edge) => edge.fromRoomId === NASTY_ROOM_IDS.prototype)).toBe(true);
  });

  it('a room id that is also a tag name is remapped as a room and kept as a tag', async () => {
    const result = remapSubjectRecords(await remapInput());
    const map = roomMap(result);
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, { tags: string[] }>;
      dungeon: { tagIndex: Record<string, string[]>; biome: string };
    };
    const renamed = map.get(NASTY_ROOM_IDS.tagNamed) as string;
    // The tag index keeps every key, including the two that are room ids. A rewrite
    // that renamed object keys would have replaced the key `cozy-hearth` with the
    // room's new name, and the list below would no longer be the learner's tags.
    expect(Object.keys(snapshot.dungeon.tagIndex).sort()).toEqual([...NASTY_TAGS].sort());
    // `cozy-hearth` indexes the room that shares its name, and `room-1` indexes the
    // two substring-sibling rooms - so the key that is a room id names one room and
    // the key that is a *prefix* of a room id names two. Neither key moved.
    expect(snapshot.dungeon.tagIndex[NASTY_TAGS[1] as string]).toEqual([renamed]);
    expect(snapshot.dungeon.tagIndex[NASTY_TAGS[0] as string]).toEqual([
      map.get(NASTY_ROOM_IDS.substring),
      map.get(NASTY_ROOM_IDS.substringSibling),
    ]);
    // ...and every room's `tags` array is untouched, including the one that collides.
    for (const room of Object.values(snapshot.rooms)) {
      expect(room.tags).toEqual([...NASTY_TAGS]);
    }
    // The biome, which is fixed vocabulary and happens to equal a room id, survives.
    expect(snapshot.dungeon.biome).toBe(NASTY_ROOM_IDS.tagNamed);
  });
});

describe('Phase 6 gate 4: learner-authored text is never rewritten', () => {
  it('a topic, a subject name, a biome, a fish name field, and session names all survive', async () => {
    const result = remapSubjectRecords(await remapInput());
    const map = roomMap(result);
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, { topic: string }>;
      dungeon: { subjectName: string };
    };
    // The room whose topic is *literally another room's id*, applied to the room
    // whose own id is a prefix of that one. Nothing was rewritten.
    const sibling = map.get(NASTY_ROOM_IDS.substringSibling) as string;
    expect(snapshot.rooms[sibling]?.topic).toBe(NASTY_ROOM_TOPIC_EQUALS_A_ROOM_ID);
    expect(snapshot.rooms[sibling]?.topic).toBe(NASTY_ROOM_IDS.substring);
    expect(String(map.get(NASTY_ROOM_TOPIC_EQUALS_A_ROOM_ID))).not.toBe(NASTY_ROOM_TOPIC_EQUALS_A_ROOM_ID);
    // The subject name still begins with the metacharacter room id.
    expect(snapshot.dungeon.subjectName.startsWith(NASTY_ROOM_IDS.metachar)).toBe(true);
    expect(snapshot.dungeon.subjectName).toBe(NASTY_SUBJECT_NAME_EQUALS_A_ROOM_ID);
    // The progression record's own subject name, the fish subject name, and the
    // session subject name: all protected, and all of them held a room id in the
    // fixture.
    const progression = result.progression[0]?.bySubject[result.subject.subjectId] as {
      subjectName: string;
      fishCollection: { subjectName: string; subjectId: string; name: string }[];
    };
    expect(progression.subjectName).toBe(NASTY_ROOM_IDS.metachar);
    expect(progression.fishCollection[0]?.subjectName).toBe(NASTY_ROOM_IDS.tagNamed);
    expect(progression.fishCollection[0]?.name).toBe('Synthetic Nasty Gate Fish');
    // The fish's `subjectId` **is** a reference, and was rewritten.
    expect(progression.fishCollection[0]?.subjectId).toBe(result.subject.subjectId);
    const session = result.sessions[0];
    expect(session?.subjectName).toBe(NASTY_ROOM_IDS.tagNamed);
    // And the protected sets themselves are what the product consults, asserted so a
    // future edit that moves a name between them is visible.
    expect(PROTECTED_TEXT_FIELDS.has('topic')).toBe(true);
    expect(PROTECTED_TEXT_FIELDS.has('tags')).toBe(true);
    expect(PROTECTED_TEXT_FIELDS.has('tagIndex')).toBe(true);
    expect(PROTECTED_TEXT_FIELDS.has('subjectName')).toBe(true);
    expect(FIXED_VOCABULARY_FIELDS.has('biome')).toBe(true);
    expect(FIXED_VOCABULARY_FIELDS.has('phaseState')).toBe(true);
    expect(FIXED_VOCABULARY_FIELDS.has('rank')).toBe(true);
    expect(PROTECTED_FIELDS.size).toBe(PROTECTED_TEXT_FIELDS.size + FIXED_VOCABULARY_FIELDS.size);
    // The two path fields are deliberately *not* protected, and that pairing is
    // asserted because it is the specific defect the module header names.
    expect(PROTECTED_TEXT_FIELDS.has('notePath')).toBe(false);
    expect(PROTECTED_TEXT_FIELDS.has('artifactPath')).toBe(false);
    expect(PATH_FIELDS_REWRITTEN_BY_SEGMENT.size).toBe(2);
  });

  it('a prototype-named room is not lost, and the room count is the assertion', async () => {
    const result = remapSubjectRecords(await remapInput());
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, { roomId: string }>;
    };
    // The source really has a room whose id is `__proto__`.
    expect(Object.keys(nastySnapshot().rooms as Record<string, unknown>)).toContain(
      NASTY_ROOM_IDS.prototype,
    );
    // The copy has the same number of rooms, and the prototype-named one became a
    // normal name. A rebuild that used `{}` and index assignment would have lost it
    // and the count would be one short - silently, because the room was never
    // referenced by anything that would have complained.
    expect(Object.keys(snapshot.rooms)).toHaveLength(NASTY_ROOM_LIST.length);
    const renamed = roomMap(result).get(NASTY_ROOM_IDS.prototype) as string;
    expect(Object.keys(snapshot.rooms)).toContain(renamed);
    expect(snapshot.rooms[renamed]?.roomId).toBe(renamed);
    // And no room is still named after a prototype key, so a later reader that
    // indexes the map with `rooms[id]` cannot be handed an object prototype and
    // mistaken for a room.
    expect(Object.keys(snapshot.rooms)).not.toContain(NASTY_ROOM_IDS.prototype);
    // The rebuilt map keeps its null prototype through the sweep, so a lookup for a
    // room that is not there answers `undefined` rather than `Object.prototype`. A
    // plain object here would hand a reader an object it can mistake for a room.
    expect(Object.getPrototypeOf(snapshot.rooms)).toBeNull();
    expect((snapshot.rooms as Record<string, unknown>)[NASTY_ROOM_IDS.prototype]).toBeUndefined();
    expect((snapshot.rooms as Record<string, unknown>)['room-does-not-exist']).toBeUndefined();
  });
});

describe('Phase 6 gate 4: the unknown-field policy, and the residual it discloses', () => {
  it('an unknown field holding a room id is rewritten at every level of the fixture', async () => {
    const result = remapSubjectRecords(await remapInput());
    const map = roomMap(result);
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, {
        fixtureRoomField: string;
        fixtureRoomPointerField: string;
        fixtureRoomProseField: string;
        validationState: { fixtureValidationField: string };
        attachments: { attachmentId: string; fixtureAttachmentField?: string }[];
      }>;
      unknownTopLevelField: string;
      unknownTopLevelPathField: string;
    };
    // Top level.
    expect(snapshot.unknownTopLevelField).toBe(map.get(NASTY_ROOM_IDS.unicode));
    // Top level, path-shaped.
    expect(snapshot.unknownTopLevelPathField.split('/')).toEqual([
      'rooms',
      map.get(NASTY_ROOM_IDS.metachar),
      'notes.md',
    ]);
    // Room level, validation level, and attachment level.
    for (const [key, room] of Object.entries(snapshot.rooms)) {
      expect(room.fixtureRoomField, key).toBe(key);
      expect(room.validationState.fixtureValidationField, key).toBe(
        map.get(NASTY_ROOM_IDS.metachar),
      );
      expect(room.fixtureRoomPointerField.split('/'), key).toEqual(['rooms', key, 'notes.md']);
    }
    const stored = snapshot.rooms[map.get(NASTY_ROOM_IDS.substring) as string];
    expect(stored?.attachments[0]?.fixtureAttachmentField).toBe(map.get(NASTY_ROOM_IDS.tagNamed));
    // A field the remapper does not know about at all, and which holds a **subject**
    // id rather than a room id, is rewritten by the same rule.
    const progression = result.progression[0]?.bySubject[result.subject.subjectId] as {
      extraFields: Record<string, unknown>;
    };
    expect(progression.extraFields.fixtureProgressionField).toBe(
      'preserve-this-synthetic-progression-field',
    );
    expect(progression.extraFields.fixtureProgressionRoomField).toBe(
      map.get(NASTY_ROOM_IDS.unicode),
    );
  });

  it('a string that mentions a room id without being one is carried verbatim and counted', async () => {
    const result = remapSubjectRecords(await remapInput());
    // Exactly seven strings in the fixture mention a room id as prose: one per room
    // and one at the top level. The count is asserted because it is the number a
    // screen shows, and an inflated one would be a wrong disclosure.
    expect(result.unresolvedReferenceCount).toBe(7);
    const snapshot = result.subject.snapshot as unknown as {
      rooms: Record<string, { fixtureRoomProseField: string }>;
      unknownTopLevelProseField: string;
    };
    // Every one of them still names its source id, verbatim, because rewriting prose
    // to fix a reference that may not exist would corrupt the learner's own words.
    for (const [key, room] of Object.entries(snapshot.rooms)) {
      const source = NASTY_ROOM_LIST.find((id) => room.fixtureRoomProseField.includes(id));
      expect(source, key).toBeDefined();
      expect(room.fixtureRoomProseField).toContain(source as string);
    }
    expect(snapshot.unknownTopLevelProseField).toContain(NASTY_ROOM_IDS.metachar);
    // And the same rule is what a protected field relies on, so a non-zero residual
    // is not a symptom of the protected-text rule failing.
    expect(PROTECTED_FIELDS.has('fixtureRoomProseField')).toBe(false);
  });

  it('a subject with no rooms, and a subject with exactly one, both remap cleanly', async () => {
    // The boundary cases, because "exhaustively" has to include "there is nothing to
    // be exhaustive about" and "there is only one of it".
    const base = nastySnapshot() as unknown as {
      rooms: Record<string, Record<string, unknown>>;
      dungeon: Record<string, unknown>;
    };
    const singleRoomId = NASTY_ROOM_IDS.metachar;
    const oneRoom: SubjectRecordValue = {
      subjectId: NASTY_SUBJECT_ID,
      schemaVersion: '1.1.0',
      createdAt: NASTY_DEVICE_NOW,
      updatedAt: NASTY_DEVICE_NOW,
      snapshot: {
        ...base,
        rooms: { [singleRoomId]: base.rooms[singleRoomId] as Record<string, unknown> },
        dungeon: {
          ...base.dungeon,
          rootRoomId: singleRoomId,
          rooms: [{ roomId: singleRoomId, topic: 'Synthetic single-room topic', status: 'Created' }],
          edges: [],
          tagIndex: { 'single-tag': [singleRoomId] },
        },
      },
    } as unknown as SubjectRecordValue;
    const single = remapSubjectRecords({
      subject: oneRoom,
      progression: [],
      sessions: [],
      assistance: [],
      attachmentMetadata: [],
      attachmentBlobs: [],
      existing: { taken: new Set<string>() },
      generator: createDeterministicIdFactory('single'),
      now: NOW,
    });
    expect(Object.keys(single.subject.snapshot.rooms)).toHaveLength(1);
    const only = Object.keys(single.subject.snapshot.rooms)[0] as string;
    expect(only).not.toBe(singleRoomId);
    const singleDungeon = single.subject.snapshot.dungeon;
    expect(singleDungeon.rootRoomId).toBe(only);
    expect(singleDungeon.tagIndex?.['single-tag']).toEqual([only]);
    expect(singleDungeon.edges).toEqual([]);
    // Two prose strings mention the one room id: the room's own and the top-level
    // one. Both are carried verbatim and both are counted.
    expect(single.unresolvedReferenceCount).toBe(2);

    const emptyRoom: SubjectRecordValue = {
      ...oneRoom,
      snapshot: {
        ...oneRoom.snapshot,
        rooms: {},
        dungeon: { ...oneRoom.snapshot.dungeon, rooms: [], edges: [], tagIndex: {}, rootRoomId: '' },
      },
    } as unknown as SubjectRecordValue;
    const empty = remapSubjectRecords({
      subject: emptyRoom,
      progression: [],
      sessions: [],
      assistance: [],
      attachmentMetadata: [],
      attachmentBlobs: [],
      existing: { taken: new Set<string>() },
      generator: createDeterministicIdFactory('empty'),
      now: NOW,
    });
    expect(Object.keys(empty.subject.snapshot.rooms)).toEqual([]);
    expect(empty.unresolvedReferenceCount).toBe(0);
    // The subject id was still minted, because a subject with no rooms is still a
    // subject and a copy that shared its id with the source would still be broken.
    expect(empty.subject.subjectId).not.toBe(NASTY_SUBJECT_ID);
    // Only the subject id is mapped. An empty `rootRoomId` is not a room: minting a
    // replacement for the empty string would put a mapping on the report that names
    // no room.
    expect(empty.mapping.map((entry) => entry.kind)).toEqual(['subject']);
  });
});

describe('Phase 6 gate 4: a minted identifier never collides', () => {
  it('a generator that offers taken values, prototype names, and blanks is refused past', async () => {
    // An injected generator is data like any other, so nothing it returns is trusted.
    // Each of the first three candidates must be skipped, and the fourth accepted.
    const taken = ['alpha-0001', 'beta-0002', 'gamma-0003'];
    const result = remapSubjectRecords(
      await remapInput({
        existing: { taken: new Set(taken) },
        generator: sequenceGenerator([...taken, 'toString', '   ', 'free-0001']),
      }),
    );
    const minted = result.mapping.map((entry) => entry.to);
    expect(minted.length).toBeGreaterThan(0);
    for (const value of taken) expect(minted, value).not.toContain(value);
    for (const value of minted) {
      expect(minted.filter((entry) => entry === value)).toHaveLength(1);
      // The kind prefix is applied to the accepted candidate, so the eight kinds
      // cannot collide with each other either.
      expect(SUBJECT_ID_KINDS.some((kind) => value.startsWith(SUBJECT_ID_KIND_PREFIX[kind]))).toBe(true);
    }
    // The subject's own id is not `alpha-0001`, is code-shaped, and is the value the
    // mapping recorded for the subject - the three are the same statement, and the
    // mapping is sorted by kind so the subject entry is not the first one.
    expect(taken).not.toContain(result.subject.subjectId);
    const subjectEntry = result.mapping.find((entry) => entry.kind === 'subject');
    expect(subjectEntry?.from).toBe(NASTY_SUBJECT_ID);
    expect(subjectEntry?.to).toBe(result.subject.subjectId);
    expect(isSanitizedDetailText(result.subject.subjectId)).toBe(true);
  });

  it('a generator that can never produce a free identifier is refused with a typed error', async () => {
    // A bounded loop with a typed refusal, rather than an unbounded one or a record
    // that cannot be stored.
    let thrown: unknown = null;
    try {
      remapSubjectRecords(await remapInput({ generator: deadGenerator() }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    const failure = thrown as StorageV2Error;
    expect(failure.code).toBe('RECORD_INVALID');
    expect(failure.details.reason).toBe('no-free-identifier');
    expect(failure.details.field).toBe('idGenerator');
    // The bound is declared, so a caller can reason about it, and it is small enough
    // that a refusing import is fast.
    expect(SUBJECT_ID_MINT_ATTEMPTS).toBe(64);
  });

  it('an identifier already on the destination is never produced, even by a matching generator', async () => {
    // The device-local form of the same rule: a subject on the destination that
    // happens to be named `gate-0001` must survive the import untouched, and the
    // copy's ids must not include it.
    const result = remapSubjectRecords(
      await remapInput({
        existing: { taken: new Set(['gate-0001', 'kc-room-gate-0002', 'kc-room-gate-0001']) },
      }),
    );
    const minted = result.mapping.map((entry) => entry.to);
    expect(minted).not.toContain('gate-0001');
    expect(minted).not.toContain('kc-room-gate-0001');
    expect(minted).not.toContain('kc-room-gate-0002');
    // Every room kind, so the *prefixed* form is what was checked and not just the
    // raw candidate.
    const roomMinted = result.mapping
      .filter((entry) => entry.kind === 'room')
      .map((entry) => entry.to);
    expect(roomMinted).not.toContain('kc-room-gate-0001');
    expect(roomMinted).not.toContain('kc-room-gate-0002');
    expect(result.mintAttempts).toBeGreaterThan(0);
  });

  it('the function is pure: same input and same generator, same output, byte for byte', async () => {
    const input = await remapInput({ generator: createDeterministicIdFactory('pure') });
    const first = remapSubjectRecords(input);
    const second = remapSubjectRecords({ ...input, generator: createDeterministicIdFactory('pure') });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // And a different generator produces a different result, so the determinism above
    // is a property of the arguments and not of a constant.
    const other = remapSubjectRecords({ ...input, generator: createDeterministicIdFactory('other') });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
    // The input was not mutated: the same input object drives both calls, and a
    // remapper that wrote into it would have made the second call differ.
    expect(JSON.stringify(input.subject.snapshot)).toBe(
      JSON.stringify((await remapInput({ generator: createDeterministicIdFactory('pure') })).subject.snapshot),
    );
    // The blob's `storedAt` is the injected clock, because it is a fact about the
    // device the copy is written to; the bytes and the content hash are verbatim.
    expect(first.attachmentBlobs[0]?.storedAt).toBe(NOW);
    expect(first.attachmentBlobs[0]?.contentHash).toBe(input.attachmentBlobs[0]?.contentHash);
    expect(first.attachmentBlobs[0]?.byteLength).toBe(input.attachmentBlobs[0]?.byteLength);
  });

  it('every declared identifier class is in the mapping, and nothing else is', async () => {
    const result = remapSubjectRecords(await remapInput());
    const byKind = new Map<SubjectIdKind, number>();
    for (const entry of result.mapping) {
      byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    }
    expect(byKind.get('subject')).toBe(1);
    expect(byKind.get('room')).toBe(NASTY_ROOM_LIST.length);
    // Three attachment ids: two metadata records and the one a room names and no
    // record owns. The orphan's id is still remapped, which is the point.
    expect(byKind.get('attachment')).toBe(3);
    expect(byKind.get('session')).toBe(2);
    expect(byKind.get('assistance')).toBe(1);
    expect(byKind.get('fish')).toBe(2);
    expect(byKind.get('note')).toBe(2);
    expect(byKind.get('loot')).toBe(2);
    expect(result.mapping.length).toBe(
      1 + NASTY_ROOM_LIST.length + 3 + 2 + 1 + 2 + 2 + 2,
    );
    // The mapping is ordered by kind then by source id, so a report is stable.
    const kinds = result.mapping.map((entry) => entry.kind);
    expect([...kinds].sort()).toEqual(kinds);
    // The orphan attachment id is among them, and it is not in any metadata record.
    expect(result.mapping.some((entry) => entry.from === NASTY_ATTACHMENT_IDS.orphanInSnapshot)).toBe(true);
    expect(result.attachmentMetadata.map((record) => record.attachmentId)).not.toContain(
      NASTY_ATTACHMENT_IDS.orphanInSnapshot,
    );
    // And every minted id is safe to use as a database key.
    for (const entry of result.mapping) {
      expect(entry.to).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(Object.hasOwn(Object.prototype, entry.to)).toBe(false);
    }
  });
});
