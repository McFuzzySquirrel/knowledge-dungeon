/**
 * Phase 7 verifier gate V4 - the tag and biome approval, attacked as a falsifiable claim.
 *
 * The implementer claims two things about the approval step:
 *
 * 1. `approvedTags` is a list the caller passes, and **absent means empty** - there is no
 *    code path in the product that reads a tag out of a snapshot into the document, so
 *    "the export ran" cannot imply "the tags were approved".
 * 2. A room's own tags are **intersected** with the approved list, so an unapproved tag
 *    sitting in the subject cannot reach the file even by accident. `approvedBiome` is
 *    the same: the exporter does not read `DungeonMetadata.biome`.
 *
 * Both are falsifiable, so this gate falsifies them:
 *
 * - a subject whose rooms are full of tags, exported with **no** `approvedTags` at all,
 *   and with `approvedTags: []`, and with `approvedTags: undefined` explicitly: the file
 *   must carry no tag anywhere, and `result.approvedTags` must be empty;
 * - the same subject with a list that omits one of its tags: the omitted tag must be
 *   absent from `graph.tags` **and** from every room's tag list;
 * - a subject with a biome, exported with no `approvedBiome`: `graph.biome` must be
 *   `null` and the biome string must not appear in the bytes;
 * - the *reported* approval list equals the document's own list, so the number a screen
 *   shows is a measurement of the file rather than a claim about the user;
 * - the UI is the other half: the tag and biome checkboxes must start unticked, and
 *   changing the chosen subject must reset them.
 *
 * Phase: 7.
 */

import { describe, expect, it } from 'vitest';

import { exportSubjectTemplate, SUBJECT_TEMPLATE_FILE_NAME } from '@/services/persistence/products/subjectTemplate';
import { APPROVED_TAGS, MARK, NOW, nastySubject } from './support/nastySubject';

interface Emitted {
  readonly text: string;
  readonly graph: {
    tags: string[];
    biome: string | null;
    rooms: Array<{ topic: string; tags: string[] }>;
  };
  readonly approvedTags: readonly string[];
  readonly approvedBiome: string | null;
}

function emit(request: Omit<Parameters<typeof exportSubjectTemplate>[1], 'now'>, label = 'p7'): Emitted {
  const result = exportSubjectTemplate(nastySubject(), { ...request, now: NOW });
  const parsed = JSON.parse(result.template) as { graph: Emitted['graph'] };
  void label;
  return {
    text: result.template,
    graph: parsed.graph,
    approvedTags: result.approvedTags,
    approvedBiome: result.approvedBiome,
  };
}

describe('phase 7 verifier V4: the tag and biome approval cannot supply itself', () => {
  it('carries no tag at all when no approved list is passed, even though every room has tags', () => {
    const emitted = emit({});
    expect(emitted.graph.tags).toEqual([]);
    for (const room of emitted.graph.rooms) expect(room.tags).toEqual([]);
    expect(emitted.approvedTags).toEqual([]);
    expect(emitted.text).not.toContain('tag-');
  });

  it('carries no tag when the approved list is explicitly absent or empty', () => {
    expect(emit({ approvedTags: [] }).graph.tags).toEqual([]);
    expect(emit({ approvedTags: undefined }).graph.tags).toEqual([]);
    // And the fixture really does have tags to leak.
    const rooms = nastySubject().rooms as unknown as Record<string, { tags: string[] }>;
    expect(Object.values(rooms).flatMap((room) => room.tags).length).toBeGreaterThan(5);
  });

  it('excludes an unapproved tag from the vocabulary and from every room', () => {
    const emitted = emit({ approvedTags: [APPROVED_TAGS[0] as string] });
    expect(emitted.graph.tags).toEqual([APPROVED_TAGS[0]]);
    for (const room of emitted.graph.rooms) {
      for (const tag of room.tags) expect(tag).toBe(APPROVED_TAGS[0]);
    }
    for (const secret of ['tag-secret-unapproved-1', 'tag-secret-unapproved-2', 'tag-secret-unapproved-3']) {
      expect(emitted.text).not.toContain(secret);
    }
  });

  it('carries no biome unless one is approved, even though the subject has one', () => {
    const emitted = emit({});
    expect(emitted.graph.biome).toBeNull();
    expect(emitted.approvedBiome).toBeNull();
    expect(emitted.text).not.toContain(`${MARK}BIOME`);
    const rooms = nastySubject().rooms as unknown as Record<string, unknown>;
    expect(Object.keys(rooms)).toHaveLength(4);
  });

  it('carries a biome only when it is approved, and only the approved value', () => {
    const emitted = emit({ approvedBiome: 'a-different-biome' });
    expect(emitted.graph.biome).toBe('a-different-biome');
    expect(emitted.approvedBiome).toBe('a-different-biome');
    expect(emitted.text).not.toContain(`${MARK}BIOME`);
  });

  it('reports exactly the list the document carries, not a superset or a subset', () => {
    const emitted = emit({ approvedTags: ['vector-maths', '  Linear Algebra  ', 'vectors'] });
    // The application's own normalisation: lowercased, punctuation stripped, sorted.
    expect(emitted.approvedTags).toEqual(['linear-algebra', 'vector-maths', 'vectors']);
    expect([...emitted.approvedTags].sort()).toEqual([...(emitted.graph.tags as string[])].sort());
  });

  it('drops a tag that normalises to nothing rather than refusing the export', () => {
    const emitted = emit({ approvedTags: ['...', 'vector-maths'] });
    expect(emitted.approvedTags).toEqual(['vector-maths']);
  });

  it('offers a content-free file name that carries no subject name, template name, or clock', () => {
    const result = exportSubjectTemplate(nastySubject(), {
      now: NOW,
      name: `${MARK}TEMPLATE-NAME`,
      description: `${MARK}DESCRIPTION`,
    });
    expect(result.fileName).toBe(SUBJECT_TEMPLATE_FILE_NAME);
    expect(result.fileName).not.toContain('P7');
    expect(result.fileName).not.toContain('2026');
    expect(result.fileName.endsWith('.kdtemplate')).toBe(true);
  });

  it('refuses a reserved-word tag in both its raw and its normalised form', () => {
    for (const tag of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => exportSubjectTemplate(nastySubject(), { now: NOW, approvedTags: [tag] })).toThrow();
    }
    // The raw form is the one that would be silently renamed, so it is refused rather
    // than normalised; a tag that normalises onto a prototype name is refused too.
    expect(() =>
      exportSubjectTemplate(nastySubject(), { now: NOW, approvedTags: ['__proto__ '] }),
    ).toThrow();
  });
});
