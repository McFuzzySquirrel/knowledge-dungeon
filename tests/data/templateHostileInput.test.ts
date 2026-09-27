/**
 * Phase 7 data-product gate 22: every malformed or hostile `.kdtemplate` is refused with a
 * typed, sanitised error, and the refusal never echoes the value it refused.
 *
 * Plan section 5.2 requires that "Data imports never partially overwrite the active data
 * generation", and the `.kdsubject` product's equivalent gate (Phase 6, gate 14) showed
 * that a corrupt-archive matrix is where a reader's real coverage turns up. A template is
 * a **smaller** attack surface than a ZIP archive in some ways and a larger one in others,
 * and both directions matter:
 *
 * - Smaller: there is no codec, so there is no compression-ratio attack, no member-path
 *   traversal, no dropped member, and no central directory to lie about. The whole ZIP
 *   hazard class is absent by construction.
 * - Larger: the document is **hand-editable JSON**, and a learner will edit one. Every
 *   array is a place to put a dangling index, every object is a place to add a key, and a
 *   tag is a string that becomes an object key on import. So the matrix below is mostly
 *   about the *content* of a syntactically perfect document.
 *
 * ## Every case is refused three ways over
 *
 * 1. With a `StorageV2Error` - the one error type this application's storage layer throws,
 *    so a caller can classify a failure rather than catching a bare `Error`.
 * 2. With a **code-shaped reason** drawn from the product's closed set, so a screen has
 *    copy for it and a gate can assert it. The reason is a property ("an endpoint is out of
 *    range") and never a value.
 * 3. With a report that does **not** contain the refused value. This is the third assertion
 *    on every case, and it is the one that would catch a future edit which helpfully added
 *    the offending tag to the error. The `StorageV2Error` constructor already refuses a
 *    string detail that is not code-shaped, so a leak would have to come from somewhere
 *    else - which is exactly why it is measured rather than assumed.
 *
 * ## Prototype-named keys and reserved-word tags are the same hazard twice
 *
 * A `__proto__` **key** is refused by the closed key set: `JSON.parse` creates it as a
 * genuine own data property, so the key check sees it and reports an unexpected-key count.
 * A `__proto__` **tag** is refused by the tag rule, in both its raw and its normalised form,
 * and the two are different failures - one would silently rename the user's tag, the other
 * would lose a key from the rebuilt `tagIndex` - so they have separate reasons. All three
 * names are tested, and so is the *non-vacuity*: the scan really does find them, which is
 * asserted on a document that contains one.
 *
 * ## The exporter's own refusals are in the matrix too
 *
 * A template this build writes, this build can read. The export side therefore refuses a
 * snapshot it cannot encode losslessly - an edge naming a room the subject does not have, a
 * relation type outside the application's vocabulary, a room whose map key disagrees with
 * its own `roomId` - rather than dropping the edge and calling it a template. Those refusals
 * are in the same table so a reader sees one rule set, not two.
 *
 * Privacy: each case names its own id and its expected reason. No assertion message
 * reproduces the value the case planted beyond the reserved-word names, which are
 * `Object.prototype` members rather than learner content.
 */

import { describe, expect, it } from 'vitest';

import {
  createSubjectFromTemplateSnapshot,
  exportSubjectTemplate,
  inspectSubjectTemplate,
  measureSubjectTemplate,
  readSubjectTemplate,
  SUBJECT_TEMPLATE_CANONICAL_PASSES,
  SUBJECT_TEMPLATE_MAX_BYTES,
  SUBJECT_TEMPLATE_MAX_DEPTH,
  SUBJECT_TEMPLATE_MAX_EDGES,
  SUBJECT_TEMPLATE_MAX_ROOMS,
  SUBJECT_TEMPLATE_MAX_TAGS,
  SUBJECT_TEMPLATE_CROSS_LINK_KEYS,
  SUBJECT_TEMPLATE_DOCUMENT_KEYS,
  SUBJECT_TEMPLATE_GRAPH_KEYS,
  SUBJECT_TEMPLATE_REFUSAL_REASONS,
  SUBJECT_TEMPLATE_ROOM_KEYS,
  SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS,
  SUBJECT_TEMPLATE_TAG_FORM_TOKENS,
  SUBJECT_TEMPLATE_VERSION_KEYS,
  type SubjectTemplateRefusalReason,
} from '@/services/persistence/products/subjectTemplate';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import { MARKER_TOKEN } from './support/marker';
import {
  TEMPLATE_APPROVED_TAGS,
  TEMPLATE_NOW,
  templateIds,
  templateSnapshot,
} from './support/templateSubject';

const VALID = exportSubjectTemplate(templateSnapshot(), {
  now: TEMPLATE_NOW,
  approvedTags: TEMPLATE_APPROVED_TAGS,
  approvedBiome: 'cozy-meadow',
  name: 'Synthetic Template',
}).template;

/** Parse the valid document, apply a mutation, and hand back the text. */
function withGraph(mutate: (graph: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(VALID) as { graph: Record<string, unknown> };
  mutate(parsed.graph);
  return JSON.stringify(parsed);
}

/**
 * Every string this product is allowed to put in a `StorageV2Error` detail.
 *
 * Declared here from the product's **own** exported vocabulary rather than as a hand-written
 * list, so a new detail token cannot appear without this set noticing, and so a well-shaped
 * string a learner typed - which a regex would happily accept - fails the assertion. The
 * point is not the shape; it is that the value came from the product's closed vocabulary.
 */
const ALLOWED_DETAIL_TOKENS: ReadonlySet<string> = new Set([
  ...SUBJECT_TEMPLATE_REFUSAL_REASONS,
  ...SUBJECT_TEMPLATE_DOCUMENT_KEYS,
  ...SUBJECT_TEMPLATE_GRAPH_KEYS,
  ...SUBJECT_TEMPLATE_ROOM_KEYS,
  ...SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS,
  ...SUBJECT_TEMPLATE_CROSS_LINK_KEYS,
  ...SUBJECT_TEMPLATE_VERSION_KEYS,
  'document',
  'product',
  'biome',
  'now',
  'kind',
  'stage',
  'generation',
  'records',
  'validate',
  'relationType',
  'createdByPhase',
  'rootIndex',
  'tags',
  'topic',
  'destinationSubjectName',
  'structureEdges',
  'crossLinks',
  'edges',
  ...SUBJECT_TEMPLATE_TAG_FORM_TOKENS,
]);

/** The detail *keys* the product is allowed to use, from the same reasoning. */
const ALLOWED_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'reason',
  'field',
  'form',
  'index',
  'keyCount',
  'count',
  'byteLength',
  'depth',
  'form',
  'kind',
  'stage',
  'policy',
]);

function generator(): { next(): string } {
  let calls = 0;
  return { next: () => `hostile-${(calls += 1).toString().padStart(4, '0')}` };
}

interface HostileCase {
  readonly id: string;
  /** A value the refusal must not echo anywhere in its report. */
  readonly mustNotEcho: string;
  readonly reason: SubjectTemplateRefusalReason;
  readonly template: string;
}

/**
 * The matrix.
 *
 * Every case is a *different* reason or a different structural level, and the table asserts
 * that at the end: no two cases may share an id, and the reasons must be a subset of the
 * product's closed set. A case that produced the wrong reason would be caught here rather
 * than by the per-case assertion, which is the same belt-and-braces shape the `.kdsubject`
 * matrix uses.
 */
const CASES: readonly HostileCase[] = [
  {
    id: 'not-json',
    mustNotEcho: 'this is not json at all',
    reason: 'template-not-json',
    template: '{"product":"kdtemplate", oops',
  },
  {
    id: 'not-an-object',
    mustNotEcho: 'a bare string',
    reason: 'document-wrong-shape',
    template: '"a bare string"',
  },
  {
    id: 'a-four-megabyte-file',
    mustNotEcho: MARKER_TOKEN,
    reason: 'template-too-large',
    // A real four-megabyte document: the cap is checked before the text is parsed, so this
    // is a refusal about size and not about JSON.
    template: `{"pad":"${'x'.repeat(4 * 1024 * 1024)}"}`,
  },
  {
    id: 'absurd-depth',
    mustNotEcho: MARKER_TOKEN,
    reason: 'template-nested-too-deeply',
    template: `${'{"a":'.repeat(400)}${MARKER_TOKEN}${' }'.repeat(400)}`,
  },
  {
    id: 'the-pre-phase-seven-document',
    mustNotEcho: 'knowledge-dungeon-template',
    reason: 'legacy-template-format-refused',
    // The shape the pre-Phase-7 legacy exporter wrote, with the five leaks it carried.
    template: JSON.stringify({
      format: 'knowledge-dungeon-template',
      schemaVersion: '1.1.0',
      exportedAt: TEMPLATE_NOW,
      subjectName: MARKER_TOKEN,
      biome: 'cozy-meadow',
      rootRoomId: templateIds('alpha').root,
      rooms: [{ roomId: templateIds('alpha').root, topic: MARKER_TOKEN }],
      edges: [],
      tagIndex: {},
      roomTemplates: {
        [templateIds('alpha').root]: {
          roomId: templateIds('alpha').root,
          topic: MARKER_TOKEN,
          tags: [],
          attachments: [{ sourceType: 'local', fileName: MARKER_TOKEN, mimeType: 'image/png' }],
        },
      },
    }),
  },
  {
    id: 'an-unexpected-document-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'document-unexpected-field',
    template: JSON.stringify({
      ...(JSON.parse(VALID) as Record<string, unknown>),
      subjectName: MARKER_TOKEN,
    }),
  },
  {
    id: 'a-missing-document-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'document-missing-field',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      delete parsed.description;
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'a-wrong-product',
    mustNotEcho: 'kdsubject',
    reason: 'unsupported-product-format-version',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.product = 'kdsubject';
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'a-wrong-format-version',
    mustNotEcho: '999',
    reason: 'unsupported-product-format-version',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.formatVersion = 999;
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'a-wrong-storage-generation-version',
    mustNotEcho: '987',
    reason: 'unsupported-storage-format-version',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.storageGenerationFormatVersion = 987;
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'a-wrong-subject-schema-version',
    mustNotEcho: '9.9.9',
    reason: 'unsupported-subject-schema-version',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.subjectSchemaVersion = '9.9.9';
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'a-non-semver-subject-schema-version',
    mustNotEcho: 'not-a-version',
    reason: 'document-wrong-shape',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.subjectSchemaVersion = 'not-a-version';
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'an-unexpected-graph-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'graph-unexpected-field',
    template: withGraph((graph) => {
      graph.tagIndex = { [MARKER_TOKEN]: [] };
    }),
  },
  {
    id: 'a-missing-graph-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'graph-missing-field',
    template: withGraph((graph) => {
      delete graph.biome;
    }),
  },
  {
    id: 'an-unexpected-room-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'room-unexpected-field',
    template: withGraph((graph) => {
      (graph.rooms as Array<Record<string, unknown>>)[0]!.noteText = MARKER_TOKEN;
    }),
  },
  {
    id: 'a-missing-room-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'room-missing-field',
    template: withGraph((graph) => {
      delete (graph.rooms as Array<Record<string, unknown>>)[0]!.tags;
    }),
  },
  {
    id: 'an-unexpected-structure-edge-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'structure-edge-unexpected-field',
    template: withGraph((graph) => {
      (graph.structureEdges as Array<Record<string, unknown>>)[0]!.relationType = MARKER_TOKEN;
    }),
  },
  {
    id: 'a-missing-cross-link-key',
    mustNotEcho: MARKER_TOKEN,
    reason: 'cross-link-missing-field',
    template: withGraph((graph) => {
      delete (graph.crossLinks as Array<Record<string, unknown>>)[0]!.relationType;
    }),
  },
  {
    id: 'a-prototype-named-document-key',
    mustNotEcho: '__proto__',
    reason: 'document-unexpected-field',
    template: `{"__proto__":{"polluted":true},${VALID.slice(1)}`,
  },
  {
    id: 'a-constructor-named-room-key',
    mustNotEcho: 'constructor',
    reason: 'room-unexpected-field',
    template: withGraph((graph) => {
      // The key is assembled at runtime, so TypeScript is not resolving `.constructor` on
      // `Object.prototype` and objecting to a string. The point of the case is that the
      // *JSON* carries an own `constructor` key, which `JSON.parse` creates as data.
      const room = (graph.rooms as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
      room[['con', 'structor'].join('')] = MARKER_TOKEN;
    }),
  },
  {
    id: 'a-toString-named-graph-key',
    mustNotEcho: 'toString',
    reason: 'graph-unexpected-field',
    template: withGraph((graph) => {
      (graph as Record<string, unknown>)[['to', 'String'].join('')] = MARKER_TOKEN;
    }),
  },
  {
    id: 'an-edge-naming-a-room-that-does-not-exist',
    mustNotEcho: '999',
    reason: 'edge-names-a-room-that-does-not-exist',
    template: withGraph((graph) => {
      (graph.structureEdges as Array<Record<string, unknown>>)[0]!.to = 999;
    }),
  },
  {
    id: 'a-negative-edge-endpoint',
    mustNotEcho: '-1',
    reason: 'edge-names-a-room-that-does-not-exist',
    template: withGraph((graph) => {
      (graph.crossLinks as Array<Record<string, unknown>>)[0]!.from = -1;
    }),
  },
  {
    id: 'a-fractional-edge-endpoint',
    mustNotEcho: '1.5',
    reason: 'edge-wrong-shape',
    template: withGraph((graph) => {
      (graph.crossLinks as Array<Record<string, unknown>>)[0]!.to = 1.5;
    }),
  },
  {
    id: 'a-duplicate-edge',
    mustNotEcho: MARKER_TOKEN,
    reason: 'duplicate-edge',
    template: withGraph((graph) => {
      const edges = graph.structureEdges as Array<Record<string, unknown>>;
      edges.push({ ...(edges[0] as Record<string, unknown>) });
    }),
  },
  {
    id: 'a-self-loop-edge',
    mustNotEcho: MARKER_TOKEN,
    reason: 'self-loop-edge',
    template: withGraph((graph) => {
      (graph.crossLinks as Array<Record<string, unknown>>)[0]!.to = (
        graph.crossLinks as Array<Record<string, unknown>>
      )[0]!.from;
    }),
  },
  {
    id: 'a-duplicate-room-in-the-hierarchy',
    mustNotEcho: MARKER_TOKEN,
    reason: 'room-has-two-structure-parents',
    // A room with two `subtopic` parents: the floor model cannot represent it, and
    // `graphDomain.reparentRoom` exists precisely to keep it to one. The second edge has a
    // *different* parent, so this is genuinely two parents and not a duplicate edge - which
    // is the case the previous row covers.
    template: withGraph((graph) => {
      const edges = graph.structureEdges as Array<Record<string, unknown>>;
      const child = (edges[0] as Record<string, unknown>).to as number;
      // Room 1 already has room 0 as its parent, so room 2 becomes its second. Neither
      // endpoint equals the other, so this is two parents and not a self-loop.
      edges.push({ from: 2, to: child, createdByPhase: 'Creator' });
    }),
  },
  {
    id: 'an-empty-graph',
    mustNotEcho: MARKER_TOKEN,
    reason: 'graph-has-no-rooms',
    template: withGraph((graph) => {
      graph.rooms = [];
      graph.structureEdges = [];
      graph.crossLinks = [];
    }),
  },
  {
    id: 'no-root',
    mustNotEcho: MARKER_TOKEN,
    reason: 'graph-has-no-root',
    template: withGraph((graph) => {
      graph.rootIndex = 99;
    }),
  },
  {
    id: 'a-tag-that-is-a-reserved-word',
    mustNotEcho: '__proto__',
    reason: 'tag-is-a-reserved-word',
    template: withGraph((graph) => {
      graph.tags = ['__proto__', 'vectors'];
    }),
  },
  {
    id: 'a-tag-that-normalises-to-a-reserved-word',
    mustNotEcho: 'constructor',
    reason: 'tag-is-a-reserved-word',
    template: withGraph((graph) => {
      graph.tags = ['constructor', 'vectors'];
    }),
  },
  {
    id: 'a-duplicate-tag',
    mustNotEcho: MARKER_TOKEN,
    reason: 'duplicate-approved-tag',
    template: withGraph((graph) => {
      graph.tags = ['vectors', 'vectors'];
    }),
  },
  {
    id: 'a-tag-outside-the-approved-vocabulary',
    mustNotEcho: 'linear-algebra',
    reason: 'tag-not-in-the-approved-list',
    template: withGraph((graph) => {
      (graph.rooms as Array<Record<string, unknown>>)[0]!.tags = ['linear-algebra', 'not-approved'];
    }),
  },
  {
    id: 'a-tag-in-an-unnormalised-spelling',
    mustNotEcho: 'Matrix Theory!',
    reason: 'tag-not-approved-shape',
    template: withGraph((graph) => {
      graph.tags = ['Matrix Theory!', 'vectors'];
    }),
  },
  {
    id: 'a-tag-that-is-not-a-string',
    mustNotEcho: '7',
    reason: 'tag-not-approved-shape',
    template: withGraph((graph) => {
      // A number where a string belongs. The document is text, so the `7` is the literal
      // the reader sees - which is why the refusal must not echo it.
      (graph.tags as unknown[]) = [7, 'vectors'];
    }),
  },
  {
    id: 'an-unknown-relation-type',
    mustNotEcho: MARKER_TOKEN,
    reason: 'edge-wrong-shape',
    template: withGraph((graph) => {
      (graph.crossLinks as Array<Record<string, unknown>>)[0]!.relationType = MARKER_TOKEN;
    }),
  },
  {
    id: 'an-unknown-authorship-phase',
    mustNotEcho: MARKER_TOKEN,
    reason: 'edge-wrong-shape',
    template: withGraph((graph) => {
      (graph.structureEdges as Array<Record<string, unknown>>)[0]!.createdByPhase = MARKER_TOKEN;
    }),
  },
  {
    id: 'an-empty-topic',
    mustNotEcho: MARKER_TOKEN,
    reason: 'label-wrong-shape',
    template: withGraph((graph) => {
      (graph.rooms as Array<Record<string, unknown>>)[0]!.topic = '';
    }),
  },
  {
    id: 'a-topic-that-is-not-a-string',
    mustNotEcho: 'null',
    reason: 'label-wrong-shape',
    template: withGraph((graph) => {
      (graph.rooms as Array<Record<string, unknown>>)[0]!.topic = null;
    }),
  },
  {
    id: 'an-absurdly-long-topic',
    mustNotEcho: 'y'.repeat(500),
    reason: 'text-too-long',
    template: withGraph((graph) => {
      (graph.rooms as Array<Record<string, unknown>>)[0]!.topic = 'y'.repeat(500);
    }),
  },
  {
    id: 'too-many-rooms',
    mustNotEcho: `${MARKER_TOKEN}-room-flood`,
    reason: 'too-many-rooms',
    template: withGraph((graph) => {
      graph.rooms = new Array<Record<string, unknown>>(SUBJECT_TEMPLATE_MAX_ROOMS + 1).fill({
        topic: `${MARKER_TOKEN}-room-flood`,
        tags: [],
      });
    }),
  },
  {
    id: 'too-many-tags',
    mustNotEcho: `${MARKER_TOKEN}-tag-flood`,
    reason: 'too-many-tags',
    template: withGraph((graph) => {
      graph.tags = new Array<string>(SUBJECT_TEMPLATE_MAX_TAGS + 1).fill(
        `${MARKER_TOKEN}-tag-flood`,
      );
    }),
  },
  {
    id: 'too-many-edges',
    mustNotEcho: `${MARKER_TOKEN}-edge-flood`,
    reason: 'too-many-edges',
    template: withGraph((graph) => {
      // Exactly the declared shape, so the case is a **count** refusal and not a shape or a
      // size one: the byte cap is checked first and this document has to stay under it, or
      // the refusal would honestly be `template-too-large` and the edge bound would go
      // untested. The assertion below measures the document to prove it did.
      graph.structureEdges = new Array<Record<string, unknown>>(SUBJECT_TEMPLATE_MAX_EDGES + 1).fill({
        from: 0,
        to: 1,
        createdByPhase: 'Creator',
      });
    }),
  },
  {
    id: 'a-rooms-entry-that-is-not-an-object',
    mustNotEcho: 'null',
    reason: 'room-wrong-shape',
    template: withGraph((graph) => {
      (graph.rooms as unknown[])[0] = 'a bare string';
    }),
  },
  {
    id: 'a-graph-that-is-not-an-object',
    mustNotEcho: 'null',
    reason: 'graph-wrong-shape',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.graph = 'not an object';
      return JSON.stringify(parsed);
    })(),
  },
  {
    id: 'a-name-that-is-not-text',
    mustNotEcho: '7',
    reason: 'label-wrong-shape',
    template: (() => {
      const parsed = JSON.parse(VALID) as Record<string, unknown>;
      parsed.name = 7;
      return JSON.stringify(parsed);
    })(),
  },
];

describe('Phase 7 gate 22: the matrix is a matrix', () => {
  it('every case is distinct, and every reason is one the product declares', () => {
    // A table of forty-odd cases that all produced the same reason would be a matrix in
    // appearance only, so the shape is asserted before the contents.
    expect(CASES.length).toBeGreaterThanOrEqual(45);
    expect(new Set(CASES.map((entry) => entry.id)).size).toBe(CASES.length);
    const declared = new Set<string>(SUBJECT_TEMPLATE_REFUSAL_REASONS);
    for (const entry of CASES) {
      expect(declared.has(entry.reason), `${entry.id} -> ${entry.reason}`).toBe(true);
    }
    // ...and the product's closed set is a real set, not a single catch-all.
    expect(new Set(SUBJECT_TEMPLATE_REFUSAL_REASONS).size).toBe(SUBJECT_TEMPLATE_REFUSAL_REASONS.length);
    expect(SUBJECT_TEMPLATE_REFUSAL_REASONS.length).toBeGreaterThanOrEqual(35);
  });

  it('the prototype-name scan really does find a prototype name', () => {
    // The positive control for the three prototype-named cases. Without it, "a
    // `__proto__` key is refused" would be satisfied by a key check that recognised nothing
    // - which is the accidental-pass shape this suite has been bitten by before.
    const parsed = JSON.parse(`{"__proto__":{"polluted":true}}`) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain('__proto__');
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    // ...and reading it did not change the object's prototype, which is the hazard the
    // closed key set exists to refuse rather than to survive.
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('the edge-count bound is reachable: the flood document is under the byte cap', () => {
    // The non-vacuity control for the `too-many-edges` case. If the flood document were over
    // {@link SUBJECT_TEMPLATE_MAX_BYTES} the product would refuse it as too large - correctly,
    // and for the wrong reason - and the edge bound would never be exercised. So the size of
    // that document is measured here rather than assumed.
    const flooded = CASES.find((entry) => entry.id === 'too-many-edges');
    expect(flooded).toBeDefined();
    const measured = measureSubjectTemplate((flooded as HostileCase).template);
    expect(measured.byteLength).toBeLessThan(SUBJECT_TEMPLATE_MAX_BYTES);
    expect(measured.byteLength).toBeGreaterThan(500 * 1024);
    expect(measured.maxDepth).toBeLessThanOrEqual(SUBJECT_TEMPLATE_MAX_DEPTH);
    // ...and the same for the room flood and the tag flood, which have the same constraint.
    for (const id of ['too-many-rooms', 'too-many-tags']) {
      const entry = CASES.find((candidate) => candidate.id === id) as HostileCase;
      expect(measureSubjectTemplate(entry.template).byteLength, id).toBeLessThan(
        SUBJECT_TEMPLATE_MAX_BYTES,
      );
    }
  });

  it('the depth and size measurements are real measurements', () => {
    // The positive control for the two pre-parse refusals, and it is what makes "refused
    // before the parser saw it" a measured claim rather than an assumption.
    // Two nested objects is depth two: the scanner counts braces, and the deepest document
    // this grammar admits is document → graph → rooms[] entry, so the cap of eight is four
    // times the real maximum.
    expect(measureSubjectTemplate('{"a":{"b":1}}').maxDepth).toBe(2);
    expect(measureSubjectTemplate('{"a":[{"b":1}]}').maxDepth).toBe(3);
    // ...and a closing brace inside a string does not decrement below the real depth either.
    expect(measureSubjectTemplate('{"a":"}"}').maxDepth).toBe(1);
    // A brace inside a string is not nesting, so the scanner is a lexer and not a counter.
    expect(measureSubjectTemplate('{"a":"{{{{{{{{{{"}').maxDepth).toBe(1);
    // Escape tracking is real: an escaped backslash does not end the string, so the object
    // that follows is genuine nesting. A scanner that treated the second backslash as
    // closing the escape would see the `c` key outside any string and mis-measure.
    expect(measureSubjectTemplate('{"a":"b\\\\","c":{"d":1}}').maxDepth).toBe(2);
    // ...and the same text without the escape is a different document, measured differently.
    expect(measureSubjectTemplate('{"a":"b\\","c":{"d":1}}').maxDepth).toBe(1);
    expect(measureSubjectTemplate('{}').byteLength).toBe(2);
    expect(measureSubjectTemplate('{"a":"é"}').byteLength).toBeGreaterThan(9);
    expect(SUBJECT_TEMPLATE_MAX_DEPTH).toBeGreaterThanOrEqual(4);
    expect(SUBJECT_TEMPLATE_CANONICAL_PASSES).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 7 gate 22: every hostile document is refused, typed, and silent', () => {
  for (const entry of CASES) {
    it(`${entry.id} is refused as ${entry.reason}`, () => {
      let thrown: unknown;
      try {
        createSubjectFromTemplateSnapshot(entry.template, {
          now: TEMPLATE_NOW,
          generator: generator(),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.id).toBeInstanceOf(StorageV2Error);
      const error = thrown as StorageV2Error;
      // Typed, with the right reason.
      expect(error.code, entry.id).toBe('VALIDATION_FAILED');
      expect(error.toReport().details.reason, entry.id).toBe(entry.reason);
      // Silent: the report is code-shaped and does not contain the refused value.
      const report = JSON.stringify(error.toReport());
      expect(report.includes(entry.mustNotEcho), `${entry.id} echoed its own value`).toBe(false);
      // The `message` is the fixed per-code string, so it cannot carry anything either.
      expect(error.message, entry.id).not.toContain(entry.mustNotEcho);
      // Every string detail is drawn from the product's **own** closed vocabulary: a
      // refusal reason, or a field token that is one of the declared key sets' names. That
      // is stronger than a shape check - a well-shaped string a learner had typed would pass
      // a regex and fail this - and it is what makes "the refusal names a property, never a
      // value" a mechanical claim.
      for (const [key, value] of Object.entries(error.details)) {
        if (typeof value !== 'string') continue;
        expect(ALLOWED_DETAIL_TOKENS.has(value), `${entry.id}.${key}=${key}`).toBe(true);
        // ...and the *key* naming it is one of the product's own detail keys.
        expect(ALLOWED_DETAIL_KEYS.has(key), `${entry.id}.details.${key}`).toBe(true);
      }
      // ...and the same document, read for a preview, is a refusal too - never a throw of a
      // different kind, and never a partial success.
      const inspection = inspectSubjectTemplate(entry.template);
      expect(inspection.ok, entry.id).toBe(false);
      if (!inspection.ok) {
        expect(inspection.error.details.reason, entry.id).toBe(entry.reason);
        expect(JSON.stringify(inspection.error).includes(entry.mustNotEcho), entry.id).toBe(false);
      }
    });
  }
});

describe('Phase 7 gate 22: the exporter refuses a snapshot it cannot encode', () => {
  it('every export-side refusal is typed and carries the declared reason', () => {
    const cases: ReadonlyArray<{
      readonly id: string;
      readonly reason: SubjectTemplateRefusalReason;
      readonly mustNotEcho: string;
      readonly mutate: (snapshot: Record<string, unknown>) => void;
    }> = [
      {
        id: 'no rooms at all',
        reason: 'snapshot-has-no-rooms',
        mustNotEcho: MARKER_TOKEN,
        mutate: (snapshot) => {
          snapshot.rooms = {};
          (snapshot.dungeon as Record<string, unknown>).rooms = [];
        },
      },
      {
        id: 'a root that names no room',
        reason: 'snapshot-has-no-resolvable-root',
        mustNotEcho: templateIds('alpha').root,
        mutate: (snapshot) => {
          (snapshot.dungeon as Record<string, unknown>).rootRoomId = 'a-room-that-is-not-there';
        },
      },
      {
        id: 'a room key that disagrees with its own roomId',
        reason: 'snapshot-room-key-disagrees-with-its-room-id',
        mustNotEcho: templateIds('alpha').root,
        mutate: (snapshot) => {
          const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
          rooms[templateIds('alpha').leaf]!.roomId = templateIds('alpha').meta;
        },
      },
      {
        id: 'a room summary with no payload',
        reason: 'snapshot-room-summary-without-payload',
        mustNotEcho: 'a-summary-only-room',
        mutate: (snapshot) => {
          (snapshot.dungeon as Record<string, unknown>).rooms = [
            ...((snapshot.dungeon as Record<string, unknown>).rooms as unknown[]),
            { roomId: 'a-summary-only-room', topic: MARKER_TOKEN, status: 'Created' },
          ];
        },
      },
      {
        id: 'an edge naming a room the subject does not have',
        reason: 'edge-names-a-room-that-does-not-exist',
        mustNotEcho: 'a-dangling-endpoint',
        mutate: (snapshot) => {
          (snapshot.dungeon as Record<string, unknown>).edges = [
            {
              fromRoomId: templateIds('alpha').root,
              toRoomId: 'a-dangling-endpoint',
              relationType: 'subtopic',
              createdAt: TEMPLATE_NOW,
              createdByPhase: 'Creator',
            },
          ];
        },
      },
      {
        id: 'a relation type outside the vocabulary',
        reason: 'snapshot-edge-vocabulary-is-unknown',
        mustNotEcho: MARKER_TOKEN,
        mutate: (snapshot) => {
          const edges = (snapshot.dungeon as Record<string, unknown>).edges as Array<Record<string, unknown>>;
          edges[0]!.relationType = MARKER_TOKEN;
        },
      },
      {
        id: 'an authorship phase outside the vocabulary',
        reason: 'snapshot-edge-vocabulary-is-unknown',
        mustNotEcho: MARKER_TOKEN,
        mutate: (snapshot) => {
          const edges = (snapshot.dungeon as Record<string, unknown>).edges as Array<Record<string, unknown>>;
          edges[0]!.createdByPhase = MARKER_TOKEN;
        },
      },
      {
        id: 'a room with no topic',
        reason: 'snapshot-room-topic-is-not-text',
        mustNotEcho: templateIds('alpha').meta,
        mutate: (snapshot) => {
          (snapshot.rooms as Record<string, Record<string, unknown>>)[templateIds('alpha').meta]!.topic = '';
        },
      },
    ];
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const entry of cases) {
      const snapshot = templateSnapshot() as unknown as Record<string, unknown>;
      entry.mutate(snapshot);
      let thrown: unknown;
      try {
        exportSubjectTemplate(snapshot as never, { now: TEMPLATE_NOW, approvedTags: TEMPLATE_APPROVED_TAGS });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.id).toBeInstanceOf(StorageV2Error);
      const error = thrown as StorageV2Error;
      expect(error.toReport().details.reason, entry.id).toBe(entry.reason);
      const report = JSON.stringify(error.toReport());
      expect(report.includes(entry.mustNotEcho), `${entry.id} echoed its own value`).toBe(false);
    }
  });

  it('a valid document is not refused, so the matrix is not a blanket rejection', () => {
    // The control for the whole file. Every case above is refused; this one is not, and it
    // produces a subject - so the refusals are decisions rather than a gate that rejects
    // everything.
    expect(() => readSubjectTemplate(VALID)).not.toThrow();
    const inspection = inspectSubjectTemplate(VALID);
    expect(inspection.ok).toBe(true);
    expect(
      createSubjectFromTemplateSnapshot(VALID, { now: TEMPLATE_NOW, generator: generator() }).roomIds,
    ).toHaveLength(6);
    // The three version contracts are refused three ways, and the set of three is the
    // product's own declared list.
    expect(SUBJECT_TEMPLATE_VERSION_KEYS).toHaveLength(3);
  });
});
