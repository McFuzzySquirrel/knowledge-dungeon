/**
 * Phase 7 data-product gate 21: an imported template reproduces the exported graph, mints
 * fresh identifiers, and produces two independent subjects.
 *
 * Three of the phase's four exit criteria live here:
 *
 * - "Imported graph structure matches the export"
 * - "Two imports create independent subjects"
 * - "Templates import into Creator state with blank notes"
 *
 * plus the one the plan states in prose: "Import with fresh IDs and blank room state".
 *
 * ## What "structure matches" is compared against
 *
 * Not "the imported snapshot looks like the imported snapshot". The comparison is
 * **graph isomorphism under the id remap**: the document's rooms, hierarchy edges,
 * cross-links, and root are turned into a canonical, id-free description, and the imported
 * subject is turned into the *same* description using its fresh ids. Two descriptions that
 * agree are the same graph with different identifiers, which is the whole claim. A weaker
 * comparison - room count, edge count - would pass an importer that scrambled the hierarchy,
 * so the description includes the parent of every room, the relation of every edge, and
 * which room is the root.
 *
 * ## Independence is measured as disjointness, twice
 *
 * "Two imports create independent subjects" is a statement about two **sets of
 * identifiers**, so it is asserted as disjointness: no subject id, no room id, and no edge
 * endpoint is shared. But disjointness alone would be satisfied by a product that minted
 * from a clock, which is a real hazard - two imports in the same millisecond collide. So
 * the second half is **mutability**: clearing a room in the first import must not be
 * visible in the second, editing a topic in one must not be visible in the other, and the
 * two `tagIndex` objects must be separate objects rather than one shared reference. A
 * product that shared structure would pass a disjointness check and fail this.
 *
 * ## A generator that misbehaves is refused, not trusted
 *
 * The minted identifiers come from an injected generator, and the product re-checks every
 * candidate rather than assuming the generator is well behaved. This gate proves that on
 * the three shapes that matter: one that returns the same value forever, one that returns
 * the destination's own identifier, and one that returns a value the `StorageV2Error`
 * constructor would refuse as a detail. Each is a typed refusal, not a record that cannot
 * be stored - which is the difference between "ids are fresh" as a claim and as a property.
 *
 * ## An imported subject is a real subject
 *
 * The last test takes the minted snapshot all the way round: through the application's own
 * `assertImportableSubjectSnapshot`, through a real storage-v2 write, through a real read
 * back, and out to a second template. So "the import produced a blank graph" is a
 * statement about a subject the application can actually open, list, and re-share - not
 * about an object in memory.
 *
 * Privacy: assertions name identifiers (synthetic fixture constants), counts, and field
 * names. No assertion message reproduces a topic, a note, or a filename.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import { readSubjectIdsFromActiveGeneration, writeSubjectToActiveGeneration } from '@/services/persistence/v2/appRepository';
import { assertImportableSubjectSnapshot } from '@/core/validation/persistence/subjectValidation';
import { listSubjectIds, saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import { resetLegacyStorage } from './support/populatedDevice';
import {
  createSubjectFromTemplateSnapshot,
  exportSubjectTemplate,
  SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME,
  type SubjectTemplateGraph,
} from '@/services/persistence/products/subjectTemplate';
import {
  ALPHA_IDENTIFIERS,
  TEMPLATE_APPROVED_TAGS,
  TEMPLATE_NOW,
  templateSnapshot,
} from './support/templateSubject';

const DATABASE = 'kd-data-gate-template-roundtrip';

/** A generator that produces a fresh, predictable value each call. */
function counterGenerator(prefix: string): { next(): string; calls: number } {
  const state = { calls: 0, next: () => `${prefix}-${(state.calls += 1).toString().padStart(4, '0')}` };
  return state;
}

/**
 * The exported graph, as an id-free canonical description.
 *
 * Rooms by content-derived index, the parent of each room, every edge with its relation,
 * and the root's index. Nothing here mentions an identifier, so the same function applied
 * to the document and to the imported subject can be compared directly - and the room
 * *indices* are recomputed from topics rather than inherited, because the imported subject's
 * room ids are in a different order than the document's array positions.
 */
function describeStructure(input: {
  readonly topics: readonly string[];
  readonly parentByTopic: ReadonlyMap<string, string | null>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly relation: string; readonly phase: string }>;
  readonly rootTopic: string;
}): string {
  const index = new Map(input.topics.map((topic, position) => [topic, position]));
  return JSON.stringify({
    roomCount: input.topics.length,
    root: input.rootTopic,
    // Each room's parent topic, or null for the root and for an unparented room. Sorted, so
    // two subjects that built the same hierarchy in a different order still agree.
    parents: [...input.parentByTopic.entries()]
      .map(([topic, parent]) => [topic, parent])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    edges: input.edges
      .map((edge) => [edge.from, edge.relation, edge.to, edge.phase])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    indexOf: [...index.entries()].sort(),
  });
}

/** The document's structure, in the form above. */
function describeDocument(graph: SubjectTemplateGraph): string {
  const topics = graph.rooms.map((room) => room.topic);
  const parentByTopic = new Map<string, string | null>();
  for (const edge of graph.structureEdges) {
    parentByTopic.set(topics[edge.to] as string, topics[edge.from] as string);
  }
  return describeStructure({
    topics,
    parentByTopic,
    edges: [
      ...graph.structureEdges.map((edge) => ({
        from: topics[edge.from] as string,
        to: topics[edge.to] as string,
        relation: 'subtopic',
        phase: edge.createdByPhase,
      })),
      ...graph.crossLinks.map((link) => ({
        from: topics[link.from] as string,
        to: topics[link.to] as string,
        relation: link.relationType,
        phase: link.createdByPhase,
      })),
    ],
    rootTopic: topics[graph.rootIndex] as string,
  });
}

/** An imported subject's structure, in the form above. */
function describeImported(snapshot: {
  dungeon: { rooms: Array<{ roomId: string; topic: string }>; edges: Array<{ fromRoomId: string; toRoomId: string; relationType: string; createdByPhase: string }>; rootRoomId: string };
  rooms: Record<string, { topic: string }>;
}): string {
  const topicOf = new Map<string, string>();
  for (const [roomId, room] of Object.entries(snapshot.rooms)) topicOf.set(roomId, room.topic);
  const parentByTopic = new Map<string, string | null>();
  for (const edge of snapshot.dungeon.edges) {
    if (edge.relationType === 'subtopic') {
      parentByTopic.set(topicOf.get(edge.toRoomId) as string, topicOf.get(edge.fromRoomId) as string);
    }
  }
  return describeStructure({
    topics: [...topicOf.values()],
    parentByTopic,
    edges: snapshot.dungeon.edges.map((edge) => ({
      from: topicOf.get(edge.fromRoomId) as string,
      to: topicOf.get(edge.toRoomId) as string,
      relation: edge.relationType,
      phase: edge.createdByPhase,
    })),
    rootTopic: topicOf.get(snapshot.dungeon.rootRoomId) as string,
  });
}

let template: string;

beforeAll(() => {
  template = exportSubjectTemplate(templateSnapshot(), {
    now: TEMPLATE_NOW,
    approvedTags: TEMPLATE_APPROVED_TAGS,
    approvedBiome: 'cozy-meadow',
    name: 'Synthetic Template',
  }).template;
});

describe('Phase 7 gate 21: the imported graph structure matches the export', () => {
  it('rooms, hierarchy, cross-links, and the root all survive the remap', () => {
    const read = (() => JSON.parse(template) as { graph: SubjectTemplateGraph })();
    const first = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('structure'),
    });
    expect(describeImported(first.snapshot)).toBe(describeDocument(read.graph));
    // ...and the counts, individually, so a failure above is attributable.
    expect(Object.keys(first.snapshot.rooms)).toHaveLength(read.graph.rooms.length);
    expect(first.snapshot.dungeon.rooms).toHaveLength(read.graph.rooms.length);
    expect(first.snapshot.dungeon.edges).toHaveLength(
      read.graph.structureEdges.length + read.graph.crossLinks.length,
    );
    expect(first.snapshot.dungeon.rootRoomId).toBe(first.roomIds[read.graph.rootIndex]);
    // The hierarchy really is a hierarchy: the root has no parent, and every other room has
    // exactly one.
    const parents = first.snapshot.dungeon.edges.filter((edge) => edge.relationType === 'subtopic');
    const childCount = new Map<string, number>();
    for (const edge of parents) {
      childCount.set(edge.toRoomId, (childCount.get(edge.toRoomId) ?? 0) + 1);
    }
    expect([...childCount.values()].every((count) => count === 1)).toBe(true);
    expect(childCount.has(first.snapshot.dungeon.rootRoomId)).toBe(false);
  });

  it('the import is in Creator state, and every room is blank', () => {
    const minted = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('blank'),
      destinationSubjectName: 'A Subject The User Typed',
    });
    expect(minted.snapshot.dungeon.phaseState).toBe('CreatorActive');
    expect(minted.snapshot.dungeon.subjectName).toBe('A Subject The User Typed');
    expect(minted.subjectNameSource).toBe('caller');
    for (const room of Object.values(minted.snapshot.rooms)) {
      expect(room.state).toBe('Created');
      expect(room.noteText).toBe('');
      expect(room.artifactMarkdown).toBeNull();
      expect(room.reviewPassCount).toBe(0);
      expect(room.attachments).toEqual([]);
      expect(room.validationState.finalPass).toBe(false);
      expect(room.validationState.manualConfirmed).toBe(false);
      // The room's own paths name its **fresh** id, not anything from the document.
      expect(room.notePath).toBe(`rooms/${room.roomId}/notes.txt`);
      expect(room.artifactPath).toBe(`rooms/${room.roomId}/artifact.md`);
    }
  });

  it('the destination name falls back to the template name, then to a constant', () => {
    // The three-way resolution, asserted rather than documented, including the rule that a
    // template never carries the *source* subject's name.
    const fromTemplate = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('name-a'),
    });
    expect(fromTemplate.subjectName).toBe('Synthetic Template');
    expect(fromTemplate.subjectNameSource).toBe('template-name');

    const unnamed = exportSubjectTemplate(templateSnapshot(), {
      now: TEMPLATE_NOW,
      approvedTags: TEMPLATE_APPROVED_TAGS,
    }).template;
    const fromDefault = createSubjectFromTemplateSnapshot(unnamed, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('name-b'),
    });
    expect(fromDefault.subjectName).toBe(SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME);
    expect(fromDefault.subjectNameSource).toBe('default');
    // The source subject's own name is in none of them.
    for (const result of [fromTemplate, fromDefault]) {
      expect(result.subjectName).not.toContain('Synthetic Data Gate Subject');
    }
  });

  it('the tag index is rebuilt from the imported rooms, so the two always agree', () => {
    const minted = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('tags'),
    });
    const index = minted.snapshot.dungeon.tagIndex as unknown as Record<string, string[]>;
    expect(Object.keys(index).sort()).toEqual([...TEMPLATE_APPROVED_TAGS].sort());
    for (const [tag, roomIds] of Object.entries(index)) {
      expect(roomIds.length).toBeGreaterThan(0);
      for (const roomId of roomIds) {
        expect(minted.roomIds).toContain(roomId);
        expect(minted.snapshot.rooms[roomId]?.tags).toContain(tag);
      }
    }
  });
});

describe('Phase 7 gate 21: two imports are independent subjects', () => {
  it('they share no identifier at all', () => {
    const first = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('first'),
    });
    const second = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('second'),
    });
    expect(second.subjectId).not.toBe(first.subjectId);
    expect(new Set(first.roomIds).size).toBe(first.roomIds.length);
    expect(new Set(second.roomIds).size).toBe(second.roomIds.length);
    const overlap = second.roomIds.filter((roomId) => first.roomIds.includes(roomId));
    expect(overlap).toEqual([]);
    // The endpoints too, and the root.
    const endpointsOf = (result: { snapshot: { dungeon: { edges: Array<{ fromRoomId: string; toRoomId: string }> } } }) =>
      result.snapshot.dungeon.edges.flatMap((edge) => [edge.fromRoomId, edge.toRoomId]);
    expect(endpointsOf(second).filter((id) => endpointsOf(first).includes(id))).toEqual([]);
    expect(second.rootRoomId).not.toBe(first.rootRoomId);
    // And the structure is nonetheless identical, which is what makes them two copies rather
    // than one subject described twice.
    expect(describeImported(second.snapshot)).toBe(describeImported(first.snapshot));
  });

  it('they are separately mutable, and neither edit reaches the other', () => {
    const first = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('mut-a'),
    });
    const second = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('mut-b'),
    });
    // A room cleared in the first, a topic changed in the first, and nothing visible in the
    // second.
    const firstRoom = first.roomIds[1] as string;
    const secondRoom = second.roomIds[1] as string;
    (first.snapshot.rooms[firstRoom] as { state: string }).state = 'ArtifactCollected';
    (first.snapshot.rooms[firstRoom] as { reviewPassCount: number }).reviewPassCount = 4;
    (first.snapshot.rooms[firstRoom] as { noteText: string }).noteText = 'written in the first import';
    (first.snapshot.rooms[firstRoom] as { topic: string }).topic = 'edited in the first import';
    expect(second.snapshot.rooms[secondRoom]?.state).toBe('Created');
    expect(second.snapshot.rooms[secondRoom]?.reviewPassCount).toBe(0);
    expect(second.snapshot.rooms[secondRoom]?.noteText).toBe('');
    expect(second.snapshot.rooms[secondRoom]?.topic).not.toBe('edited in the first import');
    // The two `rooms` maps are separate objects, and the two tag indexes are separate
    // objects: a shared reference would make a later edit in one visible in the other.
    expect(first.snapshot.rooms).not.toBe(second.snapshot.rooms);
    expect(first.snapshot.dungeon.tagIndex).not.toBe(second.snapshot.dungeon.tagIndex);
    expect(first.snapshot.dungeon.rooms).not.toBe(second.snapshot.dungeon.rooms);
  });

  it('a generator that cannot produce free identifiers is refused, not trusted', () => {
    // Three misbehaviours, three typed refusals. Each would otherwise produce a record that
    // cannot be stored, or - worse for the constant generator - two subjects sharing every
    // identifier, which is precisely the failure "two imports create independent subjects"
    // exists to rule out.
    const cases: ReadonlyArray<{ readonly what: string; readonly generator: { next(): string } }> = [
      { what: 'a constant value', generator: { next: () => 'always-the-same' } },
      { what: 'the destination identifier', generator: { next: () => (template.includes('taken') ? 'a-room' : 'x') } },
      { what: 'a prototype member name', generator: { next: () => '__proto__' } },
      { what: 'a value that cannot be a detail', generator: { next: () => 'has spaces in it' } },
      { what: 'a filename-shaped value', generator: { next: () => 'looks.like.png' } },
      { what: 'an empty string', generator: { next: () => '' } },
    ];
    for (const entry of cases) {
      let thrown: unknown;
      try {
        createSubjectFromTemplateSnapshot(template, {
          now: TEMPLATE_NOW,
          generator: entry.generator,
          taken: new Set(['a-room']),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.what).toBeInstanceOf(StorageV2Error);
      const error = thrown as StorageV2Error;
      expect(error.toReport().details.reason, entry.what).toBe('no-free-identifier');
      // The refusal is log-safe: its report carries a reason and a kind, and the refused
      // value is not in it.
      const report = JSON.stringify(error.toReport());
      expect(report, entry.what).not.toContain('always-the-same');
      expect(report, entry.what).not.toContain('__proto__');
      expect(report, entry.what).not.toContain('has spaces in it');
      expect(report, entry.what).not.toContain('looks.like.png');
    }
  });

  it('an identifier already on the destination is refused rather than reused', () => {
    // The other half of the collision rule, and the one that matters on a real device: a
    // template import must not mint a room id that another subject already holds, or the two
    // subjects would share a room.
    const taken = new Set([...ALPHA_IDENTIFIERS]);
    let thrown: unknown;
    try {
      createSubjectFromTemplateSnapshot(template, {
        now: TEMPLATE_NOW,
        // A generator whose every candidate is on the device.
        generator: { next: () => ALPHA_IDENTIFIERS[0] as string },
        taken,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).toReport().details.reason).toBe('no-free-identifier');
  });
});

describe('Phase 7 gate 21: an imported subject is a subject the application can use', () => {
  it('it passes the application importer, saves, lists, reads back, and re-exports', async () => {
    resetLegacyStorage();
    const repository = await openStorageV2Repository({
      databaseName: DATABASE,
      clock: fixedClock(TEMPLATE_NOW),
      idFactory: createDeterministicIdFactory('template'),
    });
    await repository.stageGeneration({ generationId: 'gen-template-1', source: 'local-edit', records: {} });
    await repository.activateGeneration('gen-template-1');

    const minted = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('usable'),
      destinationSubjectName: 'A Usable Subject',
    });
    // The application's own importer accepts it - the product asserts this internally, and
    // the gate asserts it from outside so the assertion cannot be satisfied by the same
    // function that produced the snapshot.
    expect(() => assertImportableSubjectSnapshot(minted.snapshot)).not.toThrow();

    await writeSubjectToActiveGeneration(repository, minted.subjectId, minted.snapshot, TEMPLATE_NOW);
    const stored = await repository.readRecords('gen-template-1');
    expect(stored.records.subjects).toHaveLength(1);
    expect(stored.records.subjects[0]?.value.subjectId).toBe(minted.subjectId);
    // Readable through the application's own per-record reader.
    expect(await readSubjectIdsFromActiveGeneration(repository)).toEqual([minted.subjectId]);
    const validation = await repository.validateGeneration('gen-template-1');
    expect(validation.ok).toBe(true);
    expect(validation.checksumMismatches).toEqual([]);
    // Every store's count delta is zero, so the written generation describes itself.
    expect(Object.values(validation.countDeltas).every((delta) => delta === 0)).toBe(true);
    expect(Object.keys(validation.countDeltas).length).toBeGreaterThanOrEqual(11);

    // And the legacy facade can save and list it too, so a rollback build would find it.
    const saved = await saveSubjectSnapshot(minted.subjectId, minted.snapshot);
    expect(saved.success).toBe(true);
    expect(await listSubjectIds()).toContain(minted.subjectId);

    // Re-exportable: the second template is byte-identical to the first, which is the
    // strongest statement that the import introduced nothing the export would carry.
    const reExported = exportSubjectTemplate(minted.snapshot, {
      now: TEMPLATE_NOW,
      approvedTags: TEMPLATE_APPROVED_TAGS,
      approvedBiome: 'cozy-meadow',
      name: 'Synthetic Template',
    }).template;
    expect(reExported).toBe(template);
  });

  it('a blank subject has no identifier from the source and no learner state at all', () => {
    const minted = createSubjectFromTemplateSnapshot(template, {
      now: TEMPLATE_NOW,
      generator: counterGenerator('state'),
    });
    const serialized = JSON.stringify(minted.snapshot);
    for (const identifier of ALPHA_IDENTIFIERS) {
      expect(serialized.includes(identifier), identifier).toBe(false);
    }
    for (const forbidden of [
      'noteText":"a',
      'artifactMarkdown":"#',
      'reviewPassCount":3',
      'attachments":[{',
      'fishCollection":[{',
    ]) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
    expect(minted.snapshot.dungeon.progression.fishCollection).toEqual([]);
    expect(minted.snapshot.dungeon.progression.badges).toEqual([]);
    expect(minted.snapshot.dungeon.progression.xpTotal).toBe(0);
  });
});
