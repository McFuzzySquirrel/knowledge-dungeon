/**
 * Phase 7 verifier gate V5 - hostile input, and the promise that a refusal leaks nothing.
 *
 * ## The three properties
 *
 * 1. **Typed.** Every hostile document is refused with a `StorageV2Error` whose `reason`
 *    is drawn from the product's own closed set. An untyped throw, a `RangeError` from a
 *    parser, or a `TypeError` from the detail constructor would each be a way for a
 *    malformed file to escape the code/reason contract a screen renders, so this gate
 *    asserts the *class* and the vocabulary, not merely "it threw".
 * 2. **Sanitised.** Every string in `toReport().details` satisfies the application's own
 *    `isSanitizedDetailText`, and the whole report - plus the error's `message` - is
 *    swept for the hostile document's own marker strings. A refusal that quoted the key
 *    it found, the topic it read, or the filename it refused is exactly the leak this
 *    asserts is absent.
 * 3. **Inert.** A refusal must not have touched the device. Each case fingerprints every
 *    generation, the whole legacy `localStorage` set, and the active-generation pointer
 *    before and after, and requires them equal. And the fingerprint is proved *able* to
 *    move, so an inert-looking result cannot be a fingerprint that never changes.
 *
 * ## The cases
 *
 * Malformed JSON; an unexpected key at each of the four levels; a missing key at each
 * level; prototype-named keys at each level; nesting far past the declared depth; a four
 * mebibyte file; each of the three version contracts wrong; an edge naming a room that
 * does not exist; a self-loop; a duplicate edge; two structure parents for one room; an
 * empty graph; a root that names nothing; a reserved-word tag; a duplicate approved tag;
 * a room tag that is not in the approved list; a hand-normalised tag; over-long text;
 * over-large graphs; and a genuine pre-Phase-7 legacy document.
 *
 * Phase: 7.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportSubjectTemplate,
  importSubjectTemplate,
  inspectSubjectTemplate,
  readSubjectTemplate,
  SUBJECT_TEMPLATE_REFUSAL_REASONS,
  type SubjectTemplateRefusalReason,
} from '@/services/persistence/products/subjectTemplate';
import { isSanitizedDetailText, StorageV2Error } from '@/services/persistence/v2/schema';
import { APPROVED_TAGS, NOW, nastySubject } from './support/nastySubject';
import {
  countingGenerator,
  fingerprintGeneration,
  legacyFingerprint,
  listGenerations,
  openDevice,
  seedSubject,
  uniqueDatabaseName,
} from './support/device';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const REASONS = new Set<string>(SUBJECT_TEMPLATE_REFUSAL_REASONS);

const VALID = JSON.parse(
  exportSubjectTemplate(nastySubject(), { now: NOW, approvedTags: [...APPROVED_TAGS] }).template,
) as Record<string, unknown>;

/** A deep copy, so each case mutates its own document. */
function document(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
}

/**
 * Insert a raw key/value pair immediately after the first occurrence of `anchor`.
 *
 * String surgery rather than an object literal, because a `__proto__` key written into a
 * JS object literal becomes the prototype and is then dropped by `JSON.stringify` - the
 * case would silently stop testing anything.
 */
function withExtraRawKey(raw: string, key: string, value: string, anchor = '{'): string {
  const at = raw.indexOf(anchor);
  return `${raw.slice(0, at + anchor.length)}"${key}":${value},${raw.slice(at + anchor.length)}`;
}

/** The same, aimed at the first room object inside the graph. */
function replaceFirstRoomKey(raw: string, key: string, value: string): string {
  const anchor = '"rooms":[';
  const at = raw.indexOf(anchor);
  if (at < 0) throw new Error('room anchor not found');
  return `${raw.slice(0, at + anchor.length)}{"${key}":${value},${raw.slice(at + anchor.length)}`;
}

/** Every marker a hostile document carries, which no refusal may echo. */
const HOSTILE_MARKERS = [
  `${'P7'}7-HOSTILE-KEY`,
  `${'P7'}7-HOSTILE-TOPIC`,
  `${'P7'}7-HOSTILE-TAG`,
  `${'P7'}7-HOSTILE-NAME`,
  'hostile.example',
  'photo-of-my-cat.png',
];

/** Assert the error is a typed refusal in the product's vocabulary, and leaks nothing. */
function assertTypedRefusal(thrown: unknown, label: string): SubjectTemplateRefusalReason {
  expect(thrown, label).toBeInstanceOf(StorageV2Error);
  const error = thrown as StorageV2Error;
  const reason = error.details.reason;
  expect(typeof reason, label).toBe('string');
  expect(REASONS.has(reason as string), `${label}: ${String(reason)}`).toBe(true);
  for (const [key, value] of Object.entries(error.details)) {
    if (typeof value !== 'string') continue;
    expect(isSanitizedDetailText(value), `${label}: detail ${key}`).toBe(true);
  }
  const report = JSON.stringify(error.toReport());
  for (const marker of HOSTILE_MARKERS) {
    expect(report.includes(marker), `${label}: report echoes ${marker}`).toBe(false);
    expect(error.message.includes(marker), `${label}: message echoes ${marker}`).toBe(false);
    expect(String(error.stack ?? '').includes(marker), `${label}: stack echoes ${marker}`).toBe(false);
  }
  return reason as SubjectTemplateRefusalReason;
}

interface Case {
  readonly label: string;
  readonly raw: string;
}

const CASES: Case[] = [
  { label: 'malformed json', raw: '{"product":"kdtemplate",' },
  { label: 'not json at all', raw: 'this is not json' },
  { label: 'a bare array', raw: '[]' },
  { label: 'a bare string', raw: '"kdtemplate"' },
  { label: 'null', raw: 'null' },
  { label: 'a number', raw: '42' },
  {
    label: 'an unexpected key at the document level',
    raw: JSON.stringify({ ...document(), noteText: 'P77-HOSTILE-NAME' }),
  },
  {
    label: 'a missing key at the document level',
    raw: JSON.stringify((() => { const d = document(); delete d.description; return d; })()),
  },
  // `JSON.parse` creates `__proto__` as a genuine own data property, so a raw literal is
  // the only way to put one in front of the reader. A JS object literal would set the
  // prototype instead and `JSON.stringify` would drop it, so the case would be vacuous.
  {
    label: 'a prototype-named key at the document level',
    raw: withExtraRawKey(JSON.stringify(document()), '__proto__', '{"polluted":"P77-HOSTILE-KEY"}'),
  },
  {
    label: 'a constructor-named key at the document level',
    raw: withExtraRawKey(JSON.stringify(document()), 'constructor', '"P77-HOSTILE-KEY"'),
  },
  {
    label: 'a prototype-named key on the first room',
    raw: replaceFirstRoomKey(JSON.stringify(document()), '__proto__', '"P77-HOSTILE-KEY"'),
  },
  {
    label: 'a prototype-named key inside graph',
    raw: withExtraRawKey(JSON.stringify(document()), '__proto__', '{"polluted":"P77-HOSTILE-KEY"}', '"graph":{'),
  },
  {
    label: 'an unexpected key inside graph',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).tagIndex = { 'P77-HOSTILE-TAG': ['room-x'] };
      return d;
    })()),
  },
  {
    label: 'a missing key inside graph',
    raw: JSON.stringify((() => {
      const d = document();
      delete (d.graph as Record<string, unknown>).biome;
      return d;
    })()),
  },

  {
    label: 'an unexpected key on a room',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { rooms: Array<Record<string, unknown>> }).rooms[0] as Record<string, unknown>).noteText = 'P77-HOSTILE-NAME';
      return d;
    })()),
  },
  {
    label: 'a missing key on a room',
    raw: JSON.stringify((() => {
      const d = document();
      delete ((d.graph as { rooms: Array<Record<string, unknown>> }).rooms[0] as Record<string, unknown>).tags;
      return d;
    })()),
  },

  {
    label: 'an unexpected key on a structure edge',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { structureEdges: Array<Record<string, unknown>> }).structureEdges[0] as Record<string, unknown>).createdAt = 'P77-HOSTILE-NAME';
      return d;
    })()),
  },
  {
    label: 'a missing key on a structure edge',
    raw: JSON.stringify((() => {
      const d = document();
      delete ((d.graph as { structureEdges: Array<Record<string, unknown>> }).structureEdges[0] as Record<string, unknown>).createdByPhase;
      return d;
    })()),
  },
  {
    label: 'an unexpected key on a cross-link',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { crossLinks: Array<Record<string, unknown>> }).crossLinks[0] as Record<string, unknown>).createdAt = 'P77-HOSTILE-NAME';
      return d;
    })()),
  },
  {
    label: 'a missing key on a cross-link',
    raw: JSON.stringify((() => {
      const d = document();
      delete ((d.graph as { crossLinks: Array<Record<string, unknown>> }).crossLinks[0] as Record<string, unknown>).relationType;
      return d;
    })()),
  },
  {
    label: 'a wrong product format version',
    raw: JSON.stringify({ ...document(), formatVersion: 99 }),
  },
  {
    label: 'a wrong storage generation format version',
    raw: JSON.stringify({ ...document(), storageGenerationFormatVersion: 99 }),
  },
  {
    label: 'a wrong subject schema version',
    raw: JSON.stringify({ ...document(), subjectSchemaVersion: '9.9.9' }),
  },
  {
    label: 'a non-integer format version',
    raw: JSON.stringify({ ...document(), formatVersion: 1.5 }),
  },
  {
    label: 'a non-semver subject schema version',
    raw: JSON.stringify({ ...document(), subjectSchemaVersion: '1.1' }),
  },
  {
    label: 'an edge naming a room that does not exist',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { structureEdges: Array<Record<string, unknown>> }).structureEdges[0] as Record<string, unknown>).to = 99;
      return d;
    })()),
  },
  {
    label: 'a negative edge endpoint',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { structureEdges: Array<Record<string, unknown>> }).structureEdges[0] as Record<string, unknown>).from = -1;
      return d;
    })()),
  },
  {
    label: 'a self-loop edge',
    raw: JSON.stringify((() => {
      const d = document();
      const edge = (d.graph as { structureEdges: Array<Record<string, unknown>> }).structureEdges[0] as Record<string, unknown>;
      edge.to = edge.from;
      return d;
    })()),
  },
  {
    label: 'a duplicate edge',
    raw: JSON.stringify((() => {
      const d = document();
      const edges = (d.graph as { structureEdges: Array<Record<string, unknown>> }).structureEdges;
      edges.push({ ...(edges[0] as Record<string, unknown>) });
      return d;
    })()),
  },
  {
    label: 'two structure parents for one room',
    raw: JSON.stringify((() => {
      const d = document();
      // Room 1 already has room 0 as its parent; give it a second one.
      const graph = d.graph as { structureEdges: Array<Record<string, unknown>> };
      graph.structureEdges.push({ from: 2, to: 1, createdByPhase: 'Creator' });
      return d;
    })()),
  },
  {
    label: 'an empty room list',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).rooms = [];
      return d;
    })()),
  },
  {
    label: 'a root that names nothing',
    raw: JSON.stringify({ ...document(), graph: { ...(document().graph as object), rootIndex: 42 } }),
  },
  {
    label: 'a non-integer root index',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).rootIndex = '0';
      return d;
    })()),
  },
  {
    label: 'a duplicate approved tag',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).tags = ['dup', 'dup'];
      return d;
    })()),
  },
  {
    label: 'a reserved-word approved tag',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).tags = ['__proto__'];
      return d;
    })()),
  },
  {
    label: 'a room tag that is not in the approved list',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { rooms: Array<{ topic: string; tags: string[] }> }).rooms[0] as { tags: string[] }).tags = ['not-approved'];
      return d;
    })()),
  },
  {
    label: 'a hand-normalised tag',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).tags = ['Vector-Maths'];
      ((d.graph as { rooms: Array<{ topic: string; tags: string[] }> }).rooms[0] as { tags: string[] }).tags = ['Vector-Maths'];
      return d;
    })()),
  },
  {
    label: 'an over-long topic',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { rooms: Array<{ topic: string; tags: string[] }> }).rooms[0] as { topic: string }).topic = 'x'.repeat(5000);
      return d;
    })()),
  },
  {
    label: 'an empty topic',
    raw: JSON.stringify((() => {
      const d = document();
      ((d.graph as { rooms: Array<{ topic: string; tags: string[] }> }).rooms[0] as { topic: string }).topic = '';
      return d;
    })()),
  },
  {
    label: 'too many rooms',
    raw: JSON.stringify((() => {
      const d = document();
      const graph = d.graph as { rooms: Array<{ topic: string; tags: string[] }> };
      graph.rooms = Array.from({ length: 5000 }, () => ({ topic: 't', tags: [] }));
      return d;
    })()),
  },
  {
    label: 'too many tags',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as Record<string, unknown>).tags = Array.from({ length: 400 }, (_value, index) => `tag-${index}`);
      return d;
    })()),
  },
  {
    label: 'a null graph',
    raw: JSON.stringify({ ...document(), graph: null }),
  },
  {
    label: 'a room that is an array',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as { rooms: unknown[] }).rooms[0] = ['topic'];
      return d;
    })()),
  },
  {
    label: 'a structure edge that is a string',
    raw: JSON.stringify((() => {
      const d = document();
      (d.graph as { structureEdges: unknown[] }).structureEdges[0] = 'nope';
      return d;
    })()),
  },
  { label: 'a legacy pre-phase-7 document', raw: JSON.stringify({ format: 'knowledge-dungeon-template', schemaVersion: '1.1.0', exportedAt: 'P77-HOSTILE-NAME', subjectName: 'P77-HOSTILE-NAME', rootRoomId: 'room-x', rooms: [{ roomId: 'room-x', topic: 'P77-HOSTILE-TOPIC' }], edges: [], tagIndex: {}, roomTemplates: {} }) },
  { label: 'nesting far past the declared depth', raw: `${'['.repeat(20000)}${']'.repeat(20000)}` },
  { label: 'four mebibytes of json', raw: `{"product":"kdtemplate","pad":"${'x'.repeat(4 * 1024 * 1024)}"}` },
];

describe('phase 7 verifier V5: hostile input is refused, typed, sanitised, and inert', () => {
  let repository: StorageV2Repository;

  beforeEach(async () => {
    repository = await openDevice(uniqueDatabaseName('v5'));
    await seedSubject(repository, 'subject-inert-check', nastySubject({ subjectName: 'Inert check' }));
  });

  afterEach(() => {
    repository.close();
  });

  async function fingerprint(): Promise<string> {
    const generations = await listGenerations(repository);
    const parts: string[] = [legacyFingerprint(), (await repository.readActiveGenerationId()) ?? 'none'];
    for (const entry of generations) {
      parts.push(`${entry.id}:${entry.status}:${entry.source}`);
      parts.push(await fingerprintGeneration(repository, entry.id));
    }
    return JSON.stringify(parts);
  }

  it('refuses every hostile document with a typed reason and leaks nothing', () => {
    const seen = new Set<string>();
    for (const entry of CASES) {
      let thrown: unknown;
      try {
        readSubjectTemplate(entry.raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${entry.label}: was accepted`).toBeDefined();
      const reason = assertTypedRefusal(thrown, entry.label);
      seen.add(reason);
    }
    // A gate that only ever saw one reason would pass a product that refused everything
    // for one reason, so the distinct set is asserted to be broad.
    expect(seen.size).toBeGreaterThanOrEqual(12);
  });

  it('refuses a hostile document on the inspection path too, as a result rather than a throw', () => {
    for (const entry of CASES.slice(0, 20)) {
      const inspection = inspectSubjectTemplate(entry.raw);
      expect(inspection.ok, entry.label).toBe(false);
      if (inspection.ok) continue;
      const rebuilt = new StorageV2Error(inspection.error.code, inspection.error.details);
      assertTypedRefusal(rebuilt, `inspect: ${entry.label}`);
    }
  });

  it('refuses a hostile document with an import and leaves the device byte-identical', async () => {
    const before = await fingerprint();
    for (const entry of CASES) {
      let thrown: unknown;
      try {
        await importSubjectTemplate({
          repository,
          template: entry.raw,
          now: NOW,
          generator: countingGenerator('p7hostile'),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `import: ${entry.label}`).toBeDefined();
      assertTypedRefusal(thrown, `import: ${entry.label}`);
    }
    expect(await fingerprint()).toBe(before);
  });

  it('proves the device fingerprint can move, so an inert result is meaningful', async () => {
    const before = await fingerprint();
    await importSubjectTemplate({
      repository,
      template: JSON.stringify(VALID),
      now: NOW,
      generator: countingGenerator('p7move'),
    });
    expect(await fingerprint()).not.toBe(before);
  });

  it('proves the legacy-`localStorage` fingerprint can move too', async () => {
    const before = legacyFingerprint();
    localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-moved-in']));
    expect(legacyFingerprint()).not.toBe(before);
  });
});
