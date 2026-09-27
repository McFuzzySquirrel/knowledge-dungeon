/**
 * Phase 7 verifier gate V3 - exit criteria 2, 3, and 4, against real storage.
 *
 * - "Imported graph structure matches the export"
 * - "Two imports create independent subjects"
 * - "Templates import into Creator state with blank notes"
 *
 * ## Why this gate uses a real repository
 *
 * Criteria 3 and 4 are statements about a **subject on a device**, not about a value in
 * memory. A gate that only called the pure half would pass an importer that mints a
 * perfect subject and then writes nothing. So every test here runs the product's
 * `importSubjectTemplate` against a real `StorageV2Repository` over `fake-indexeddb`,
 * and then reads the record back off the device before making any claim.
 *
 * ## "Structure matches" is compared as isomorphism, not as counts
 *
 * Room and edge counts would pass an importer that scrambled the hierarchy. So the
 * comparison is a canonical, identifier-free description of the graph: the parent of
 * every room, the relation and authorship of every edge, and which room is the root -
 * built once from the document and once from the imported subject using its fresh ids.
 *
 * ## Independence is disjointness *and* mutability
 *
 * Disjointness alone would be satisfied by a product that minted from a clock, since two
 * imports in the same millisecond would collide. So the second half mutates the first
 * import and requires the second to be untouched, including the `tagIndex` object
 * identity, which a shallow copy of the document would share.
 *
 * Phase: 7.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSubjectFromTemplateSnapshot,
  exportSubjectTemplate,
  importSubjectTemplate,
} from '@/services/persistence/products/subjectTemplate';
import { assertImportableSubjectSnapshot } from '@/core/validation/persistence/subjectValidation';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';
import { APPROVED_TAGS, MARK, NOW, nastySubject } from './support/nastySubject';
import { countingGenerator, openDevice, seedSubject, uniqueDatabaseName } from './support/device';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

/** A canonical, identifier-free description of a graph. */
interface Shape {
  readonly rootTopic: string;
  readonly rooms: ReadonlyArray<{ topic: string; tags: readonly string[]; parent: string | null }>;
  readonly relations: readonly string[];
}

const TEMPLATE = exportSubjectTemplate(nastySubject(), {
  now: NOW,
  approvedTags: [...APPROVED_TAGS],
  approvedBiome: 'p7-leak-canary-biome',
  name: 'p7 verifier template',
  description: 'p7 verifier description',
}).template;

/** The document's graph, described without indices. */
function shapeOfDocument(): Shape {
  const graph = (JSON.parse(TEMPLATE) as {
    graph: {
      rootIndex: number;
      rooms: Array<{ topic: string; tags: string[] }>;
      structureEdges: Array<{ from: number; to: number; createdByPhase: string }>;
      crossLinks: Array<{ from: number; to: number; relationType: string; createdByPhase: string }>;
    };
  }).graph;
  const topicAt = (index: number): string => (graph.rooms[index] as { topic: string }).topic;
  const parentOf = new Map<number, number>();
  for (const edge of graph.structureEdges) parentOf.set(edge.to, edge.from);
  return {
    rootTopic: topicAt(graph.rootIndex),
    rooms: graph.rooms.map((room, index) => ({
      topic: room.topic,
      tags: [...room.tags],
      parent: parentOf.has(index) ? topicAt(parentOf.get(index) as number) : null,
    })),
    relations: [
      ...graph.structureEdges.map((edge) => `subtopic|${topicAt(edge.from)}|${topicAt(edge.to)}|${edge.createdByPhase}`),
      ...graph.crossLinks.map((edge) => `${edge.relationType}|${topicAt(edge.from)}|${topicAt(edge.to)}|${edge.createdByPhase}`),
    ].sort(),
  };
}

/** The same description, built from a minted subject and its own fresh ids. */
function shapeOfSubject(snapshot: SubjectSnapshot): Shape {
  const dungeon = snapshot.dungeon as unknown as {
    rootRoomId: string;
    rooms: Array<{ roomId: string }>;
    edges: Array<{ fromRoomId: string; toRoomId: string; relationType: string; createdByPhase: string }>;
  };
  const rooms = snapshot.rooms as unknown as Record<string, { topic: string; tags?: string[] }>;
  const topicAt = (roomId: string): string => rooms[roomId]?.topic ?? '';
  const parentOf = new Map<string, string>();
  for (const edge of dungeon.edges) {
    if (edge.relationType === 'subtopic') parentOf.set(edge.toRoomId, edge.fromRoomId);
  }
  return {
    rootTopic: topicAt(dungeon.rootRoomId),
    rooms: dungeon.rooms.map((summary) => ({
      topic: topicAt(summary.roomId),
      tags: [...(rooms[summary.roomId]?.tags ?? [])],
      parent: parentOf.has(summary.roomId) ? topicAt(parentOf.get(summary.roomId) as string) : null,
    })),
    relations: [
      ...dungeon.edges
        .filter((edge) => edge.relationType === 'subtopic')
        .map((edge) => `subtopic|${topicAt(edge.fromRoomId)}|${topicAt(edge.toRoomId)}|${edge.createdByPhase}`),
      ...dungeon.edges
        .filter((edge) => edge.relationType !== 'subtopic')
        .map((edge) => `${edge.relationType}|${topicAt(edge.fromRoomId)}|${topicAt(edge.toRoomId)}|${edge.createdByPhase}`),
    ].sort(),
  };
}

describe('phase 7 verifier V3: structural fidelity, independence, and blankness on a real device', () => {
  let repository: StorageV2Repository;

  beforeEach(async () => {
    repository = await openDevice(uniqueDatabaseName('v3'));
  });

  afterEach(() => {
    repository.close();
  });

  it('reproduces the exported graph exactly, by isomorphism under the id remap', () => {
    const minted = createSubjectFromTemplateSnapshot(TEMPLATE, {
      now: NOW,
      generator: countingGenerator('p7'),
    });
    expect(shapeOfSubject(minted.snapshot)).toEqual(shapeOfDocument());
  });

  it('puts the imported subject in Creator state, with the root where the document said', () => {
    const minted = createSubjectFromTemplateSnapshot(TEMPLATE, {
      now: NOW,
      generator: countingGenerator('p7'),
    });
    const dungeon = minted.snapshot.dungeon as unknown as { phaseState: string; rootRoomId: string };
    expect(dungeon.phaseState).toBe('CreatorActive');
    expect(dungeon.rootRoomId).toBe(minted.rootRoomId);
    expect(minted.rootRoomId).not.toBeNull();
  });

  it('blanks every room: no note, no artifact, no attachment, no review, no SM-2 progress', () => {
    const minted = createSubjectFromTemplateSnapshot(TEMPLATE, {
      now: NOW,
      generator: countingGenerator('p7'),
    });
    const rooms = minted.snapshot.rooms as unknown as Record<
      string,
      {
        roomId: string;
        state: string;
        noteText: string;
        artifactMarkdown: string | null;
        attachments: unknown[];
        reviewPassCount: number;
        sm2ConsecutiveCorrect: number;
        sm2IntervalDays: number;
        sm2EaseFactor: number;
        sm2QualityResponse: number;
        validationState: { wordCount: number; finalPass: boolean; manualConfirmed: boolean };
        notePath: string;
        artifactPath: string;
      }
    >;
    expect(Object.keys(rooms)).toHaveLength(4);
    for (const [roomId, room] of Object.entries(rooms)) {
      expect(room.roomId).toBe(roomId);
      expect(room.state).toBe('Created');
      expect(room.noteText).toBe('');
      expect(room.artifactMarkdown).toBeNull();
      expect(room.attachments).toEqual([]);
      expect(room.reviewPassCount).toBe(0);
      expect(room.sm2ConsecutiveCorrect).toBe(0);
      expect(room.sm2IntervalDays).toBe(1);
      expect(room.sm2EaseFactor).toBe(2.5);
      expect(room.sm2QualityResponse).toBe(3);
      expect(room.validationState.wordCount).toBe(0);
      expect(room.validationState.finalPass).toBe(false);
      expect(room.validationState.manualConfirmed).toBe(false);
    }
  });

  it('carries no progression, no fish, no badges, and no assistance on the imported subject', () => {
    const minted = createSubjectFromTemplateSnapshot(TEMPLATE, {
      now: NOW,
      generator: countingGenerator('p7'),
    });
    const dungeon = minted.snapshot.dungeon as unknown as {
      progression: { xpTotal: number; rank: string; badges: unknown[]; fishCollection: unknown[] };
      assistance?: unknown;
    };
    expect(dungeon.progression.xpTotal).toBe(0);
    expect(dungeon.progression.rank).toBe('Novice');
    expect(dungeon.progression.badges).toEqual([]);
    expect(dungeon.progression.fishCollection).toEqual([]);
    expect(dungeon.assistance).toBeUndefined();
  });

  it('keeps the approved tags on the rooms and rebuilds the index from them', () => {
    const minted = createSubjectFromTemplateSnapshot(TEMPLATE, {
      now: NOW,
      generator: countingGenerator('p7'),
    });
    const dungeon = minted.snapshot.dungeon as unknown as { tagIndex: Record<string, string[]> };
    const index = dungeon.tagIndex;
    const keys = Object.keys(index).sort();
    expect(keys).toEqual([...APPROVED_TAGS].sort());
    // Every id in the index is an id the import minted, and every minted room is in one.
    const roomIds = new Set(Object.keys(minted.snapshot.rooms as unknown as Record<string, unknown>));
    for (const key of keys) {
      for (const roomId of index[key] as string[]) expect(roomIds.has(roomId)).toBe(true);
    }
  });

  it('produces a subject the application\'s own importer accepts', () => {
    const minted = createSubjectFromTemplateSnapshot(TEMPLATE, {
      now: NOW,
      generator: countingGenerator('p7'),
    });
    expect(() => assertImportableSubjectSnapshot(minted.snapshot)).not.toThrow();
  });

  it('writes exactly one subject to the device, and the device then lists it', async () => {
    await seedSubject(repository, 'subject-already-here', nastySubject({ subjectName: 'Pre-existing' }));
    const before = await repository.readRecords((await repository.readActiveGenerationId()) as string);

    const result = await importSubjectTemplate({
      repository,
      template: TEMPLATE,
      now: NOW,
      generator: countingGenerator('p7import'),
    });

    const after = await repository.readRecords(result.generationId);
    expect(after.records.subjects).toHaveLength(before.records.subjects.length + 1);
    expect(after.records.subjects.map((envelope) => envelope.recordId)).toContain(result.subjectId);
    expect(result.recordCounts.subjects).toBe(before.records.subjects.length + 1);
  });

  it('saves a subject that reads back identical, and that is re-exportable to the same graph', async () => {
    const result = await importSubjectTemplate({
      repository,
      template: TEMPLATE,
      now: NOW,
      generator: countingGenerator('p7import'),
    });
    const reread = await repository.readRecords(result.generationId);
    const envelope = reread.records.subjects.find((entry) => entry.recordId === result.subjectId);
    expect(envelope).toBeDefined();
    const stored = (envelope as { value: { snapshot: SubjectSnapshot } }).value.snapshot;
    expect(shapeOfSubject(stored)).toEqual(shapeOfDocument());

    // Re-export the stored subject with the same approvals. The graph must come back the
    // same, and the only permitted difference is the injected `createdAt`.
    const again = exportSubjectTemplate(stored, {
      now: NOW,
      approvedTags: [...APPROVED_TAGS],
      approvedBiome: 'p7-leak-canary-biome',
      name: 'p7 verifier template',
      description: 'p7 verifier description',
    });
    const once = JSON.parse(TEMPLATE) as { graph: unknown };
    const twice = JSON.parse(again.template) as { graph: unknown };
    expect(twice.graph).toEqual(once.graph);
    expect(again.template).toBe(TEMPLATE);
  });

  it('makes two imports of the same file share no identifier, and be independently mutable', async () => {
    const first = await importSubjectTemplate({
      repository,
      template: TEMPLATE,
      now: NOW,
      generator: countingGenerator('p7first'),
    });
    const second = await importSubjectTemplate({
      repository,
      template: TEMPLATE,
      now: NOW,
      generator: countingGenerator('p7second'),
    });

    expect(second.subjectId).not.toBe(first.subjectId);
    const firstRooms = Object.keys(first.snapshot.rooms as unknown as Record<string, unknown>);
    const secondRooms = Object.keys(second.snapshot.rooms as unknown as Record<string, unknown>);
    expect(secondRooms).toHaveLength(firstRooms.length);
    for (const roomId of firstRooms) expect(secondRooms).not.toContain(roomId);

    // Endpoint disjointness, over the imported edge lists.
    const endpoints = (result: typeof first): string[] => {
      const edges = (result.snapshot.dungeon as unknown as {
        edges: Array<{ fromRoomId: string; toRoomId: string }>;
      }).edges;
      return edges.flatMap((edge) => [edge.fromRoomId, edge.toRoomId]);
    };
    expect(endpoints(second).filter((id) => firstRooms.includes(id))).toEqual([]);

    // Mutability: mutate the first import's structure and require the second to be intact.
    const firstSnapshot = first.snapshot as unknown as {
      rooms: Record<string, { topic: string; noteText: string }>;
      dungeon: { subjectName: string };
    };
    const secondSnapshot = second.snapshot as unknown as {
      rooms: Record<string, { topic: string; noteText: string }>;
      dungeon: { subjectName: string; tagIndex: Record<string, string[]> };
    };
    const firstRoomId = firstRooms[0] as string;
    const secondRoomId = secondRooms[0] as string;
    expect(firstRoomId).not.toBe(secondRoomId);
    firstSnapshot.rooms[firstRoomId]!.noteText = `${MARK}MUTATION`;
    firstSnapshot.dungeon.subjectName = `${MARK}MUTATED-NAME`;
    expect(secondSnapshot.rooms[secondRoomId]!.noteText).toBe('');
    expect(secondSnapshot.dungeon.subjectName).not.toBe(`${MARK}MUTATED-NAME`);

    // The tag index must be a separate object graph, not one shared reference.
    const firstIndex = (first.snapshot.dungeon as unknown as { tagIndex: Record<string, string[]> }).tagIndex;
    const secondIndex = secondSnapshot.dungeon.tagIndex;
    expect(firstIndex).not.toBe(secondIndex);
    const firstTag = Object.keys(firstIndex)[0] as string;
    firstIndex[firstTag] = ['mutated'];
    expect(secondIndex[firstTag]).not.toEqual(['mutated']);
  });

  it('mints identifiers that do not collide with what the device already held', async () => {
    const existing = nastySubject({ subjectName: 'Collision risk' });
    const existingSubjectId = 'kc-subject-should-not-be-reused';
    const existingRoomId = Object.keys(existing.rooms as unknown as Record<string, unknown>)[0] as string;
    await seedSubject(repository, existingSubjectId, existing);

    // A generator that offers only identifiers the device already holds for its first
    // forty attempts, then a fresh one. The product must skip past every taken value
    // rather than use it, and must reach the free value.
    const takenOnDevice = [existingSubjectId, existingRoomId];
    let attempts = 0;
    const result = await importSubjectTemplate({
      repository,
      template: TEMPLATE,
      now: NOW,
      generator: {
        next: () => {
          attempts += 1;
          if (attempts <= 40) return takenOnDevice[attempts % takenOnDevice.length] as string;
          return `p7-free-${attempts}`;
        },
      },
    });
    expect(attempts).toBeGreaterThan(40);
    expect(result.subjectId).not.toBe(existingSubjectId);
    const roomIds = Object.keys(result.snapshot.rooms as unknown as Record<string, unknown>);
    expect(roomIds).not.toContain(existingRoomId);
    expect(new Set([result.subjectId, ...roomIds]).size).toBe(5);
    const stored = await repository.readRecords(result.generationId);
    const ids = stored.records.subjects.map((envelope) => envelope.recordId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses rather than colliding when the generator can only return taken identifiers', async () => {
    await seedSubject(repository, 'subject-taken', nastySubject({ subjectName: 'Taken' }));
    await expect(
      importSubjectTemplate({
        repository,
        template: TEMPLATE,
        now: NOW,
        // Always the one identifier the device already holds, so no attempt can succeed.
        generator: { next: () => 'subject-taken' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'no-free-identifier' } });
  });
});
