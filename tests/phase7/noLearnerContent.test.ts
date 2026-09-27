/**
 * Phase 7 verifier gate V1 - exit criterion 1, "A template contains no learner content,
 * attachment metadata, or original IDs", attacked three ways.
 *
 * Three independent attacks, because a single one is a single point of failure:
 *
 * 1. **Key-set equality.** The emitted document's key set is compared for **equality**
 *    against a list written from plan section 7.3, not against the product's own
 *    exported constants. A gate that reads the product's constants proves the product
 *    is self-consistent; this one proves the product matches the plan, and would fail
 *    if the product widened its own vocabulary.
 * 2. **A leaf walk.** Every leaf of the document is collected with its path and
 *    classified. Every string leaf must be one of a small permitted set: a room topic
 *    the fixture planted, an approved tag, a biome, or one of four literal constants.
 *    A field that reached the file by any route - including a prototype path, an
 *    inherited property, or a getter - shows up here as a string leaf outside the
 *    permitted set.
 * 3. **A marker sweep over the raw bytes.** Every private string planted in the fixture
 *    is searched for in the document text. This is the falsifiable form: a leak through
 *    a permitted key that aliases a forbidden one still leaves a marker in the bytes.
 *
 * The three are deliberately redundant. The key-set equality proves the shape, the leaf
 * walk proves the values, and the marker sweep proves neither can be fooled by a value
 * that arrives in a permitted slot.
 *
 * ## The prototype attacks
 *
 * The brief asks for a leak reached by a prototype path, an inherited property, or a
 * getter. This gate runs four of them and records what actually happens rather than
 * asserting a guess:
 *
 * - a room identifier that is a prototype member name, defined as a genuine own
 *   enumerable key;
 * - a room reachable only by inheritance (its own `Object.keys` is empty);
 * - `dungeon` supplied by the prototype rather than as an own field;
 * - a `topic` that is an **accessor** rather than a data field.
 *
 * Phase: 7. Comment-blanked: this file's prose is never read by a checker, and the
 * fixture's marker strings are constants rather than sentences.
 */

import { describe, expect, it } from 'vitest';

import { exportSubjectTemplate } from '@/services/persistence/products/subjectTemplate';
import {
  APPROVED_TAGS,
  MARK,
  NOW,
  nastySubject,
  PERMITTED_MARKERS,
  reidentifiedPhase0Subject,
  ROOM,
  SUBJECT_ID,
} from './support/nastySubject';

/** Plan section 7.3's permitted things, plus the two constants the format adds. */
const EXPECTED_DOCUMENT_KEYS = [
  'createdAt',
  'description',
  'formatVersion',
  'graph',
  'name',
  'product',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
] as const;

const EXPECTED_GRAPH_KEYS = [
  'biome',
  'crossLinks',
  'rootIndex',
  'rooms',
  'structureEdges',
  'tags',
] as const;

const EXPECTED_ROOM_KEYS = ['tags', 'topic'] as const;
const EXPECTED_STRUCTURE_EDGE_KEYS = ['createdByPhase', 'from', 'to'] as const;
const EXPECTED_CROSS_LINK_KEYS = ['createdByPhase', 'from', 'relationType', 'to'] as const;

interface Leaf {
  readonly path: string;
  readonly value: unknown;
}

/** Every non-object leaf of a document, with a dotted path. Arrays index by number. */
function collectLeaves(value: unknown, path: string, into: Leaf[] = []): Leaf[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLeaves(entry, `${path}[${index}]`, into));
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectLeaves(entry, path === '' ? key : `${path}.${key}`, into);
    }
    return into;
  }
  into.push({ path, value });
  return into;
}

function parse(template: string): Record<string, unknown> {
  return JSON.parse(template) as Record<string, unknown>;
}

function exportWith(snapshot: Parameters<typeof exportSubjectTemplate>[0]): string {
  return exportSubjectTemplate(snapshot, {
    now: NOW,
    approvedTags: [...APPROVED_TAGS],
    approvedBiome: 'p7-leak-canary-biome',
    name: 'p7 verifier template',
    description: 'p7 verifier description',
  }).template;
}

/** The private strings planted in the fixture, as constants. */
const PLANTED_PRIVATE = [
  `${MARK}NOTE-BODY-the-summarised-version-of-my-own-work`,
  `${MARK}ARTIFACT-BODY-my-written-answer`,
  `${MARK}DRAFT-BODY-unsaved-scribe-draft`,
  `${MARK}ATTACHMENT-FILENAME-private-photo.png`,
  `${MARK}ALT-TEXT-my-child-in-the-garden`,
  'https://p7-leak-canary.example/',
  `${MARK}SUBJECT-NAME`,
  `${MARK}BIOME`,
  `${MARK}ASSISTANCE-HISTORY`,
  `${MARK}RECOVERY-RECORD`,
  `${MARK}CUSTOM-SPRITE-SVG-BODY`,
  `${MARK}MIGRATION-RECEIPT`,
  `${MARK}PROGRESSION-XP`,
  `${MARK}SM2-REVIEW-SCHEDULE`,
  `${MARK}REVIEW-PASS-COUNT`,
  `${MARK}VALIDATION-STATE`,
  `${MARK}UNKNOWN-TOP-LEVEL-FIELD`,
  `${MARK}UNKNOWN-DUNGEON-FIELD`,
  `${MARK}UNKNOWN-ROOM-FIELD`,
  `${MARK}FISH-ID`,
  `${MARK}FISH-NAME`,
  `${MARK}ATTACHMENT-ID-local`,
  `${MARK}ATTACHMENT-ID-external`,
  `${MARK}SPRITE-ID`,
  `${MARK}RECEIPT-ID`,
  `${MARK}tag-secret-unapproved-1`,
  `${MARK}tag-secret-unapproved-2`,
  `${MARK}tag-secret-unapproved-3`,
  SUBJECT_ID,
  ROOM.root,
  ROOM.childA,
  ROOM.childB,
  ROOM.orphan,
];

describe('phase 7 verifier V1: a template carries no learner content, attachment metadata, or original ids', () => {
  const document = parse(exportWith(nastySubject()));

  it('emits exactly the declared document key set, for equality', () => {
    expect(Object.keys(document).sort()).toEqual([...EXPECTED_DOCUMENT_KEYS].sort());
  });

  it('emits exactly the declared key set at every nested level, for equality', () => {
    const graph = document.graph as Record<string, unknown>;
    expect(Object.keys(graph).sort()).toEqual([...EXPECTED_GRAPH_KEYS].sort());
    for (const room of graph.rooms as Array<Record<string, unknown>>) {
      expect(Object.keys(room).sort()).toEqual([...EXPECTED_ROOM_KEYS].sort());
    }
    for (const edge of graph.structureEdges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge).sort()).toEqual([...EXPECTED_STRUCTURE_EDGE_KEYS].sort());
    }
    for (const link of graph.crossLinks as Array<Record<string, unknown>>) {
      expect(Object.keys(link).sort()).toEqual([...EXPECTED_CROSS_LINK_KEYS].sort());
    }
  });

  it('declares the two constants the format adds and nothing else beyond the six permitted things', () => {
    // `product` and `createdAt` are not one of section 7.3's six. They are asserted
    // explicitly so that a *third* addition cannot hide inside a set equality.
    expect(document.product).toBe('kdtemplate');
    expect(document.createdAt).toBe(NOW);
  });

  it('has no leaf that is a private string, a file name, a URL, or an identifier', () => {
    const permitted = new Set<string>([
      NOW,
      'kdtemplate',
      'p7 verifier template',
      'p7 verifier description',
      'p7-leak-canary-biome',
      '1.1.0',
      // The application's own closed edge vocabularies, which section 7.3's "Edge and
      // cross-link structure" necessarily carries. Asserted as literals, not read from
      // the product, so widening a vocabulary fails here.
      'subtopic',
      'analogy',
      'prerequisite',
      'related',
      'depends_on',
      'Creator',
      'Scribe',
      'Archaeologist',
      ...PERMITTED_MARKERS,
      ...APPROVED_TAGS,
    ]);
    const strings = collectLeaves(document, '').filter((leaf) => typeof leaf.value === 'string');
    const unexpected = strings.filter((leaf) => !permitted.has(leaf.value as string));
    expect(
      unexpected.map((leaf) => leaf.path),
    ).toEqual([]);
  });

  it('leaves no planted marker anywhere in the raw document bytes', () => {
    const template = exportWith(nastySubject());
    for (const marker of PLANTED_PRIVATE) {
      expect(template.includes(marker), marker).toBe(false);
    }
  });

  it('carries no number or boolean outside the version contracts and the indices', () => {
    const allowedPaths = new Set([
      'formatVersion',
      'storageGenerationFormatVersion',
      'graph.rootIndex',
    ]);
    const nonStrings = collectLeaves(document, '').filter((leaf) => typeof leaf.value !== 'string');
    const scalars = nonStrings
      .filter((leaf) => leaf.value !== null)
      .filter((leaf) => typeof leaf.value !== 'number' || !leaf.path.endsWith('].from') && !leaf.path.endsWith('].to'));
    for (const leaf of scalars) {
      if (leaf.path.startsWith('graph.rooms[') || leaf.path.startsWith('graph.structureEdges[') || leaf.path.startsWith('graph.crossLinks[')) {
        continue;
      }
      expect(allowedPaths.has(leaf.path), leaf.path).toBe(true);
    }
  });

  it('leaks nothing out of the re-identified Phase 0 unknown-fields fixture either', () => {
    const template = exportWith(reidentifiedPhase0Subject());
    for (const marker of [
      `${MARK}P0-NOTE-`,
      `${MARK}P0-ARTIFACT-`,
      `${MARK}P0-NOTEPATH-`,
      `${MARK}P0-ARTIFACTPATH-`,
      `${MARK}P0-FILENAME`,
      `${MARK}P0-ALT`,
      `${MARK}P0-URL`,
      `${MARK}P0-SUBJECT-NAME`,
      `${MARK}p0-tag`,
      'subject-phase0-v110-full',
      'room-phase0-v110-full-root',
      'room-phase0-v110-full-branch',
      'preserve-this-synthetic-top-level-field',
      'preserve-this-synthetic-dungeon-field',
      'preserve-this-synthetic-progression-field',
      'crystal-caverns',
    ]) {
      expect(template.includes(marker), marker).toBe(false);
    }
    // ...and the two topics the fixture does permit are the only topics in the file.
    const graph = JSON.parse(template).graph as { rooms: Array<{ topic: string }> };
    expect(graph.rooms.map((room) => room.topic).sort()).toEqual([
      'Synthetic Branch Topic',
      'Synthetic Root Topic',
    ]);
  });

  describe('prototype-shaped attacks', () => {
    it('emits no identifier for a room whose id is a prototype member name', () => {
      const rooms = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(rooms, '__proto__', {
        value: {
          roomId: '__proto__',
          topic: 'a permitted topic',
          tags: [],
          noteText: `${MARK}PROTO-NOTE`,
          attachments: [{ fileName: `${MARK}PROTO-FILENAME` }],
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const snapshot = {
        dungeon: {
          schemaVersion: '1.1.0',
          dungeonId: 'subject-proto',
          subjectName: `${MARK}PROTO-SUBJECT`,
          createdAt: NOW,
          updatedAt: NOW,
          phaseState: 'CreatorActive',
          rootRoomId: '__proto__',
          rooms: [{ roomId: '__proto__', topic: 'a permitted topic', status: 'Created' }],
          edges: [],
          progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
        },
        rooms,
      } as unknown as Parameters<typeof exportSubjectTemplate>[0];
      const template = exportSubjectTemplate(snapshot, { now: NOW }).template;
      expect(template).not.toContain('__proto__');
      expect(template).not.toContain(`${MARK}PROTO`);
      const graph = JSON.parse(template).graph as { rootIndex: number; rooms: unknown[] };
      expect(graph.rootIndex).toBe(0);
      expect(graph.rooms).toHaveLength(1);
    });

    it('ignores a room that is only reachable through the prototype chain', () => {
      const inherited = {
        roomId: 'room-inherited',
        topic: 'an inherited topic',
        tags: [],
        noteText: `${MARK}INHERITED-NOTE`,
      };
      const rooms = Object.create({ 'room-inherited': inherited }) as Record<string, unknown>;
      const snapshot = {
        dungeon: {
          schemaVersion: '1.1.0',
          dungeonId: 'subject-inherit',
          subjectName: `${MARK}INHERIT-SUBJECT`,
          createdAt: NOW,
          updatedAt: NOW,
          phaseState: 'CreatorActive',
          rootRoomId: 'room-own',
          rooms: [{ roomId: 'room-own', topic: 'own topic', status: 'Created' }],
          edges: [],
          progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
        },
        rooms: Object.assign(rooms, {
          'room-own': { roomId: 'room-own', topic: 'own topic', tags: [] },
        }),
      } as unknown as Parameters<typeof exportSubjectTemplate>[0];
      const graph = JSON.parse(exportSubjectTemplate(snapshot, { now: NOW }).template).graph as {
        rooms: Array<{ topic: string }>;
      };
      expect(graph.rooms.map((room) => room.topic)).toEqual(['own topic']);
    });

    it('reads dungeon from the prototype when the snapshot has no own dungeon, and leaks nothing from it', () => {
      const ownRoom = { roomId: 'room-own', topic: 'own topic', tags: [] };
      const snapshot = Object.create({
        dungeon: {
          schemaVersion: '1.1.0',
          dungeonId: `${MARK}PROTOTO-DUNGEON-ID`,
          subjectName: `${MARK}PROTOTO-SUBJECT-NAME`,
          createdAt: NOW,
          updatedAt: NOW,
          phaseState: 'ArchaeologistActive',
          rootRoomId: 'room-own',
          rooms: [{ roomId: 'room-own', topic: 'own topic', status: 'Created' }],
          edges: [],
          progression: { xpTotal: 4242, rank: 'Scholar', badges: [], fishCollection: [], marker: `${MARK}PROTOTO-XP` },
          biome: `${MARK}PROTOTO-BIOME`,
        },
      }) as unknown as Parameters<typeof exportSubjectTemplate>[0];
      snapshot.rooms = { 'room-own': ownRoom } as never;
      const template = exportSubjectTemplate(snapshot, { now: NOW }).template;
      expect(template).not.toContain(`${MARK}PROTOTO`);
      expect(template).not.toContain('4242');
      expect(template).not.toContain('room-own');
    });

    it('exports an accessor-defined topic, which is a note about the source and not a leak', () => {
      // Recorded, not asserted as acceptable: the exporter reads `room.topic` by ordinary
      // property access, so a getter is invoked and its return value is the topic. There
      // is no own-property check and no way for the product to tell a topic from a topic.
      // This test exists so the behaviour is pinned rather than discovered later.
      const room: Record<string, unknown> = { roomId: 'room-getter', tags: [] };
      Object.defineProperty(room, 'topic', {
        get: () => `${MARK}GETTER-TOPIC-VALUE`,
        enumerable: true,
        configurable: true,
      });
      const snapshot = {
        dungeon: {
          schemaVersion: '1.1.0',
          dungeonId: 'subject-getter',
          subjectName: `${MARK}GETTER-SUBJECT`,
          createdAt: NOW,
          updatedAt: NOW,
          phaseState: 'CreatorActive',
          rootRoomId: 'room-getter',
          rooms: [{ roomId: 'room-getter', topic: 'x', status: 'Created' }],
          edges: [],
          progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
        },
        rooms: { 'room-getter': room },
      } as unknown as Parameters<typeof exportSubjectTemplate>[0];
      const graph = JSON.parse(exportSubjectTemplate(snapshot, { now: NOW }).template).graph as {
        rooms: Array<{ topic: string }>;
      };
      expect(graph.rooms.map((entry) => entry.topic)).toEqual([`${MARK}GETTER-TOPIC-VALUE`]);
      // The subject's own name and the room's identifier still do not appear.
      expect(exportSubjectTemplate(snapshot, { now: NOW }).template).not.toContain(`${MARK}GETTER-SUBJECT`);
      expect(exportSubjectTemplate(snapshot, { now: NOW }).template).not.toContain('room-getter');
    });
  });
});
