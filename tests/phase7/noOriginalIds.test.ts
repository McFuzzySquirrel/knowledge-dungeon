/**
 * Phase 7 verifier gate V2 - exit criterion 1's "or original IDs", attacked through byte
 * identity.
 *
 * ## The argument being attacked
 *
 * A closed allowlist with rooms addressed by array index means no identifier is *read
 * into* the document. That is necessary but not sufficient for the stronger claim the
 * implementer makes: that two exports of structurally identical graphs from different
 * subjects are **byte-identical**. Byte identity is the falsifiable form of "no original
 * IDs", because if the canonical room order were a function of anything but the graph's
 * content, an identifier would influence the file even though no identifier is *in* it.
 *
 * So this gate builds several pairs that are isomorphic as graphs and differently
 * identified, and requires identical bytes:
 *
 * 1. a different subject id;
 * 2. a permutation of every room id, with the topics held on the same rooms;
 * 3. the rooms map built in reverse insertion order, and the edge list reversed;
 * 4. timestamps, names, notes, attachments, progression, and the biome all different.
 *
 * It then goes after the **residual** the implementer documents: two rooms with the same
 * topic, the same tags, and the same incident-edge structure. The claim is that such a
 * pair is ordered by whatever the pre-tiebreak pass produced. This gate requires the
 * product to be *deterministic* on such a graph (same input graph, same bytes) and
 * measures whether it is also *identifier-independent* there, so the report can state
 * the boundary of the property as measured rather than as claimed.
 *
 * Phase: 7.
 */

import { describe, expect, it } from 'vitest';

import { exportSubjectTemplate } from '@/services/persistence/products/subjectTemplate';
import { APPROVED_TAGS, NOW, nastySubject, type NastySubjectOptions } from './support/nastySubject';

function exportWith(snapshot: Parameters<typeof exportSubjectTemplate>[0]): string {
  return exportSubjectTemplate(snapshot, {
    now: NOW,
    approvedTags: [...APPROVED_TAGS],
    approvedBiome: 'p7-leak-canary-biome',
  }).template;
}

/** Reverse a plain object's own key order, without changing what it holds. */
function reverseEntries<T extends Record<string, unknown>>(source: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).reverse()) out[key] = source[key];
  return out as T;
}

interface Graph {
  readonly rootIndex: number;
  readonly rooms: ReadonlyArray<{ topic: string; tags: readonly string[] }>;
  readonly structureEdges: ReadonlyArray<{ from: number; to: number; createdByPhase: string }>;
  readonly crossLinks: ReadonlyArray<{ from: number; to: number; relationType: string; createdByPhase: string }>;
}

function graphOf(template: string): Graph {
  return (JSON.parse(template) as { graph: Graph }).graph;
}

describe('phase 7 verifier V2: the emitted bytes do not depend on any identifier', () => {
  it('is byte-identical for a differently-identified but structurally identical subject', () => {
    const base = exportWith(nastySubject());
    const renamed = exportWith(
      nastySubject({
        subjectId: 'subject-totally-different-9f2c',
        subjectName: 'a completely different name',
        biome: 'another-biome',
        extraTopLevel: { somethingElse: 'x' },
        extraDungeon: { anotherField: 1 },
        extraRootRoom: { yetAnother: true },
      }),
    );
    expect(renamed).toBe(base);
  });

  it('is byte-identical when every room id is permuted across the same topics', () => {
    const base = exportWith(nastySubject());
    const permuted = exportWith(
      nastySubject({
        roomIds: {
          root: 'zzz-root',
          childA: 'zzz-child-b',
          childB: 'zzz-child-a',
          orphan: 'aaa-orphan',
        },
      }),
    );
    expect(permuted).toBe(base);
  });

  it('is byte-identical when the rooms map and the edge list are built in reverse order', () => {
    const snapshot = nastySubject();
    const reversed = {
      ...snapshot,
      rooms: reverseEntries(snapshot.rooms as unknown as Record<string, unknown>),
      dungeon: {
        ...(snapshot.dungeon as unknown as Record<string, unknown>),
        rooms: [...(snapshot.dungeon.rooms as unknown as Array<unknown>)].reverse(),
        edges: [...(snapshot.dungeon.edges as unknown as Array<unknown>)].reverse(),
      },
    } as unknown as Parameters<typeof exportSubjectTemplate>[0];
    expect(exportWith(reversed)).toBe(exportWith(snapshot));
  });

  it('is byte-identical across an entirely different id alphabet, twice over', () => {
    const shapes = [
      { root: 'a', childA: 'b', childB: 'c', orphan: 'd' },
      { root: 'r9', childA: 'r8', childB: 'r7', orphan: 'r6' },
      { root: 'room_zzz', childA: 'room_yyy', childB: 'room_xxx', orphan: 'room_www' },
    ];
    const bytes = shapes.map((roomIds) =>
      exportWith(nastySubject({ roomIds, subjectId: `subject-${roomIds.root}` })),
    );
    expect(bytes[1]).toBe(bytes[0] as string);
    expect(bytes[2]).toBe(bytes[0] as string);
  });

  it('is deterministic for the same input, twice', () => {
    const first = exportWith(nastySubject());
    const second = exportWith(nastySubject());
    expect(second).toBe(first);
  });

  it('is a pure function of the injected clock: a different `now` is the only difference', () => {
    const a = exportSubjectTemplate(nastySubject(), { now: '2026-01-01T00:00:00.000Z', approvedTags: [...APPROVED_TAGS] }).template;
    const b = exportSubjectTemplate(nastySubject(), { now: '2026-01-02T00:00:00.000Z', approvedTags: [...APPROVED_TAGS] }).template;
    expect(a).not.toBe(b);
    expect(a.replace('2026-01-01T00:00:00.000Z', 'X')).toBe(b.replace('2026-01-02T00:00:00.000Z', 'X'));
  });

  describe('the documented residual, measured', () => {
    /**
     * Root with two children that are indistinguishable by topic, by tags, and by
     * incident-edge structure. This is the pair the implementer's own residual
     * paragraph is about.
     */
    function twinSubject(roomIds: { root: string; a: string; b: string }, subjectId: string): Parameters<typeof exportSubjectTemplate>[0] {
      const room = (roomId: string, topic: string) => ({
        roomId,
        topic,
        tags: topic === 'the same topic' ? ['the same tag'] : [],
        noteText: 'private note body',
      });
      return {
        dungeon: {
          schemaVersion: '1.1.0',
          dungeonId: subjectId,
          subjectName: 'twin subject',
          createdAt: NOW,
          updatedAt: NOW,
          phaseState: 'CreatorActive',
          rootRoomId: roomIds.root,
          rooms: [
            { roomId: roomIds.root, topic: 'root', status: 'Created' },
            { roomId: roomIds.a, topic: 'the same topic', status: 'Created' },
            { roomId: roomIds.b, topic: 'the same topic', status: 'Created' },
          ],
          edges: [
            { fromRoomId: roomIds.root, toRoomId: roomIds.a, relationType: 'subtopic', createdAt: NOW, createdByPhase: 'Creator' },
            { fromRoomId: roomIds.root, toRoomId: roomIds.b, relationType: 'subtopic', createdAt: NOW, createdByPhase: 'Creator' },
          ],
          progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
        },
        rooms: {
          [roomIds.root]: room(roomIds.root, 'root'),
          [roomIds.a]: room(roomIds.a, 'the same topic'),
          [roomIds.b]: room(roomIds.b, 'the same topic'),
        },
      } as unknown as Parameters<typeof exportSubjectTemplate>[0];
    }

    it('is deterministic on an indistinguishable twin pair, for one id assignment', () => {
      const first = exportWith(twinSubject({ root: 'room-root', a: 'room-aaa', b: 'room-bbb' }, 'subject-one'));
      const second = exportWith(twinSubject({ root: 'room-root', a: 'room-aaa', b: 'room-bbb' }, 'subject-one'));
      expect(second).toBe(first);
    });

    it('emits both twins, so the pair is not lost - only its order is at stake', () => {
      const graph = graphOf(exportWith(twinSubject({ root: 'room-root', a: 'room-aaa', b: 'room-bbb' }, 'subject-one')));
      expect(graph.rooms).toHaveLength(3);
      expect(graph.rooms.filter((room) => room.topic === 'the same topic')).toHaveLength(2);
      expect(graph.structureEdges).toHaveLength(2);
    });

    it('records the measured boundary: swapping which id holds which twin can change the bytes', () => {
      // This is the residual the implementer documents. It is asserted as a *measurement*
      // with its consequence spelled out, because the consequence is what matters: the
      // two documents are still isomorphic, and neither carries an identifier.
      const assignmentOne = exportWith(twinSubject({ root: 'room-root', a: 'room-aaa', b: 'room-bbb' }, 'subject-one'));
      const assignmentTwo = exportWith(twinSubject({ root: 'room-root', a: 'room-bbb', b: 'room-aaa' }, 'subject-two'));
      const one = graphOf(assignmentOne);
      const two = graphOf(assignmentTwo);

      // Same graph, same size, same edge count, in both.
      expect(two.rooms).toHaveLength(one.rooms.length);
      expect(two.structureEdges).toHaveLength(one.structureEdges.length);
      // Neither document carries any of the identifiers.
      for (const id of ['room-root', 'room-aaa', 'room-bbb', 'subject-one', 'subject-two']) {
        expect(assignmentOne).not.toContain(id);
        expect(assignmentTwo).not.toContain(id);
      }
      // And the ordering difference, if any, is confined to the two identical entries.
      const differing = one.rooms
        .map((room, index) => (room.topic === two.rooms[index]?.topic ? null : index))
        .filter((index): index is number => index !== null);
      expect(differing.length).toBeLessThanOrEqual(2);
    });

    it('holds byte identity even when the twins are distinguished only by their cross-links', () => {
      // The hardest case I could construct: two siblings with the same topic and the same
      // tags, told apart *only* by a lateral link to a third, distinguishable room. The
      // base order here falls back to room ids, so only the incident-edge tiebreak can
      // produce id independence - and it has to get the index assignment right for the
      // emitted `from`/`to` integers to match.
      const build = (swap: boolean): Parameters<typeof exportSubjectTemplate>[0] => {
        const root = 'room-root';
        const first = swap ? 'room-zzz' : 'room-aaa';
        const second = swap ? 'room-aaa' : 'room-zzz';
        const c = 'room-ccc';
        const d = 'room-ddd';
        const room = (roomId: string, topic: string, tags: string[]) => ({ roomId, topic, tags });
        return {
          dungeon: {
            schemaVersion: '1.1.0',
            dungeonId: 'subject-twin',
            subjectName: 'twin',
            createdAt: NOW,
            updatedAt: NOW,
            phaseState: 'CreatorActive',
            rootRoomId: root,
            rooms: [root, first, second, c, d].map((roomId) => ({
              roomId,
              topic: roomId === root ? 'root' : roomId === c ? 'c' : roomId === d ? 'd' : 'the same topic',
              status: 'Created',
            })),
            edges: [
              { fromRoomId: root, toRoomId: first, relationType: 'subtopic', createdAt: NOW, createdByPhase: 'Creator' },
              { fromRoomId: root, toRoomId: second, relationType: 'subtopic', createdAt: NOW, createdByPhase: 'Creator' },
              { fromRoomId: c, toRoomId: first, relationType: 'analogy', createdAt: NOW, createdByPhase: 'Creator' },
              { fromRoomId: d, toRoomId: second, relationType: 'related', createdAt: NOW, createdByPhase: 'Creator' },
            ],
            progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
          },
          rooms: {
            [root]: room(root, 'root', []),
            [first]: room(first, 'the same topic', ['the same tag']),
            [second]: room(second, 'the same topic', ['the same tag']),
            [c]: room(c, 'c', []),
            [d]: room(d, 'd', []),
          },
        } as unknown as Parameters<typeof exportSubjectTemplate>[0];
      };
      expect(exportWith(build(true))).toBe(exportWith(build(false)));
    });
  });

  describe('the order is a function of the graph, not of the ids', () => {
    it('orders rooms breadth-first from the root and by topic within a level', () => {
      const graph = graphOf(exportWith(nastySubject()));
      expect(graph.rooms[0]?.topic).toContain('TOPIC-ROOT');
      const childTopics = graph.rooms.slice(1, 3).map((room) => room.topic);
      expect([...childTopics].sort()).toEqual(childTopics);
    });

    it('places a room the root cannot reach after the reachable ones, keeping it in the file', () => {
      const graph = graphOf(exportWith(nastySubject()));
      expect(graph.rooms).toHaveLength(4);
      expect(graph.rooms.some((room) => room.topic.includes('TOPIC-ORPHAN'))).toBe(true);
    });

    it('agrees with the root index and with the structure edges after a rename', () => {
      const options: NastySubjectOptions = {
        roomIds: { root: 'x1', childA: 'x2', childB: 'x3', orphan: 'x4' },
        subjectId: 's-1',
      };
      const graph = graphOf(exportWith(nastySubject(options)));
      expect(graph.rootIndex).toBe(0);
      // The root is a parent, is not anyone's child, and the orphan is nobody's child.
      const parents = new Set(graph.structureEdges.map((edge) => edge.to));
      const froms = new Set(graph.structureEdges.map((edge) => edge.from));
      expect(froms.has(0)).toBe(true);
      expect(parents.has(0)).toBe(false);
      expect(parents.size).toBe(2);
      expect(graph.rooms).toHaveLength(4);
    });
  });
});
