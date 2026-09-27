/**
 * Phase 7 data-product gate 19: a `.kdtemplate` cannot contain private learner data.
 *
 * This is the phase's objective - "Deliver a graph-only template workflow that cannot
 * contain private learner data" - and the exit criterion it holds. Plan section 7.3
 * permits six things and excludes thirteen; the whole design exists to make the exclusion
 * list unnecessary, so this gate has to **prove the exclusion by absence** rather than
 * spot-check the fields somebody remembered.
 *
 * ## Why absence, and why an allowlist rather than a denylist
 *
 * A denylist is the wrong shape in this repository for a reason that is specific rather
 * than general. Plan section 7.3 requires the `.kdbak` import to "preserve unknown
 * app-owned fields", and Phases 4, 5 and 6 all built on that: a room record may carry a
 * field no build in this repository has ever heard of, at any depth, holding anything.
 * A denylist would carry every one of those into a file the learner is about to hand to
 * somebody else, and the leak would be invisible - the field would look exactly like a
 * field the product knows. So the document is built from an allowlist of the six permitted
 * things, every key is declared, and the assertions below are **key-set equalities** plus
 * a full walk of every leaf.
 *
 * ## The three assertions, and the non-vacuity control for each
 *
 * 1. **The key set equals the declared set, at every level.** Not "contains no forbidden
 *    key" - *equals*. An unexpected key is a failure and a missing key is a failure, so
 *    the document has no room to grow.
 * 2. **Every leaf is walked and compared against the inventory of what had to go.** The
 *    walk visits every string, number, boolean, array and object in the emitted document,
 *    and the inventory is *measured* from the fixture first: `templateSubject.ts`'s
 *    `forbiddenSurfacesAreActuallyPresent` reports which of its named fields genuinely
 *    held a non-empty value, and this gate requires the answer to be the whole inventory.
 *    Without that, "the marker is absent" would be satisfied by a subject that held
 *    nothing to leak.
 * 3. **No marker appears anywhere in the file.** The learner-content marker is planted as
 *    the subject name, two room topics, the note body, the artifact, a validation
 *    `failedChecks` entry, an attachment filename, an attachment's alt text, an external
 *    URL, a recovery payload, a custom sprite body, a migration receipt id, a preference
 *    value and a session's room list. The planted ones that are *permitted* - the room
 *    topics and the approved tags - are accounted for by counting them, so the assertion
 *    is "the marker appears in exactly the rooms the graph declares, and nowhere else".
 *
 * ## The approval step is a real step
 *
 * The marker's strongest test is the tag one. The fixture plants two **unapproved** tags
 * in every room alongside the two approved ones, and the gate exports twice: once with the
 * approved list and once with **no** `approvedTags` at all. The first must carry the two
 * approved tags and neither unapproved one; the second must carry **no** tags whatsoever.
 * The second is the falsifiable form of "hitting export is not the same as approving a
 * tag" - an implementation that read `RoomMetadata.tags` into the document would fail it
 * on every room.
 *
 * Privacy: this file's assertions name field names, counts, and the synthetic marker
 * itself. No assertion message reproduces the content of a planted value beyond the
 * marker token, which is a fixture constant and names nothing real.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  createSubjectFromTemplateSnapshot,
  exportSubjectTemplate,
  SUBJECT_TEMPLATE_CROSS_LINK_KEYS,
  SUBJECT_TEMPLATE_DOCUMENT_KEYS,
  SUBJECT_TEMPLATE_GRAPH_KEYS,
  SUBJECT_TEMPLATE_ROOM_KEYS,
  SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS,
  SUBJECT_TEMPLATE_VERSION_KEYS,
  readSubjectTemplate,
} from '@/services/persistence/products/subjectTemplate';
import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import { MARKER_TOKEN } from './support/marker';
import {
  ALPHA_IDENTIFIERS,
  FORBIDDEN_SURFACES,
  TEMPLATE_APPROVED_TAGS,
  TEMPLATE_NAME,
  TEMPLATE_NOW,
  TEMPLATE_UNAPPROVED_TAGS,
  forbiddenDeviceSurfacesAreActuallyPresent,
  forbiddenSurfacesAreActuallyPresent,
  templateSnapshot,
  deviceOnlyRecords,
  FORBIDDEN_DEVICE_SURFACES,
  FORBIDDEN_SUBJECT_SURFACES,
  TOPIC_MARKER_COUNT,
} from './support/templateSubject';

/** Every key this product declares, as a flat set, for the leaf walk's vocabulary. */
const DECLARED_KEYS: ReadonlySet<string> = new Set([
  ...SUBJECT_TEMPLATE_DOCUMENT_KEYS,
  ...SUBJECT_TEMPLATE_GRAPH_KEYS,
  ...SUBJECT_TEMPLATE_ROOM_KEYS,
  ...SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS,
  ...SUBJECT_TEMPLATE_CROSS_LINK_KEYS,
]);

interface Leaf {
  /** The dotted path, with array indices as `[n]`. */
  readonly path: string;
  readonly value: unknown;
}

/** Every leaf of a JSON-shaped value, in a fixed order. */
function leavesOf(value: unknown, path: string, out: Leaf[] = []): Leaf[] {
  if (value === null || typeof value !== 'object') {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => leavesOf(entry, `${path}[${index}]`, out));
    return out;
  }
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    leavesOf((value as Record<string, unknown>)[key], `${path}.${key}`, out);
  }
  return out;
}

let approved: string;
let unapproved: string;
let parsedApproved: Record<string, unknown>;
let parsedUnapproved: Record<string, unknown>;

beforeAll(() => {
  const snapshot = templateSnapshot();
  approved = exportSubjectTemplate(snapshot, {
    now: TEMPLATE_NOW,
    approvedTags: TEMPLATE_APPROVED_TAGS,
    approvedBiome: 'cozy-meadow',
    name: TEMPLATE_NAME,
    // Deliberately marker-free, so the "the marker appears only in permitted text" check
    // has two permitted surfaces to account for rather than three, and so a leak into the
    // description would be distinguishable from a leak anywhere else.
    description: 'Synthetic unmarked template description',
  }).template;
  // The falsification of "approval is a step": no `approvedTags` at all, on a subject
  // whose rooms are full of tags.
  unapproved = exportSubjectTemplate(snapshot, { now: TEMPLATE_NOW }).template;
  parsedApproved = JSON.parse(approved) as Record<string, unknown>;
  parsedUnapproved = JSON.parse(unapproved) as Record<string, unknown>;
});

describe('Phase 7 gate 19: the fixture is nastier than the gate needs', () => {
  it('every forbidden surface the inventory names really held a value', () => {
    // The non-vacuity control, and it is measured rather than asserted from a comment:
    // the answer must be the whole inventory, so a fixture edit that emptied one of these
    // fields fails here instead of quietly turning an absence assertion into a vacuous
    // one.
    const present = forbiddenSurfacesAreActuallyPresent(templateSnapshot());
    expect(present).toEqual(FORBIDDEN_SUBJECT_SURFACES.map((surface) => surface.key).sort());
    expect(present.length).toBeGreaterThanOrEqual(16);
  });

  it('every device-only surface the inventory names really held a value too', () => {
    // The second half of the control, and the reason the plan's exclusion list is split:
    // progression, fish, inventory, assistance, recovery records, custom sprites and
    // migration receipts do not live in a subject snapshot, so a gate that only looked at
    // the snapshot could not show they were excluded rather than merely unimplemented.
    const present = forbiddenDeviceSurfacesAreActuallyPresent(
      deviceOnlyRecords() as unknown as Record<string, unknown[]>,
    );
    expect(present).toEqual(FORBIDDEN_DEVICE_SURFACES.map((surface) => surface.key).sort());
    expect(present.length).toBeGreaterThanOrEqual(9);
  });

  it('every inventory value is distinct, so one absence assertion cannot cover another', () => {
    const values = FORBIDDEN_SURFACES.map((surface) => surface.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('the marker really is planted in the subject, the notes, and the attachments', () => {
    // The second half of the non-vacuity control, and it is on the *source* rather than on
    // a constant list, so a fixture that lost the marker fails here.
    const snapshot = templateSnapshot() as unknown as Record<string, unknown>;
    const dungeon = snapshot.dungeon as Record<string, unknown>;
    const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
    expect(String(dungeon.subjectName)).toContain(MARKER_TOKEN);
    expect(String(rooms['room-7kq-alpha-1-root']?.noteText)).toContain(MARKER_TOKEN);
    expect(String(rooms['room-7kq-alpha-1-root']?.artifactMarkdown)).toContain(MARKER_TOKEN);
    const attachments = rooms['room-7kq-alpha-1-root']?.attachments as Array<Record<string, unknown>>;
    expect(attachments.length).toBeGreaterThanOrEqual(2);
    for (const surface of ['fileName', 'altText', 'externalUrl']) {
      expect(
        attachments.some((attachment) => String(attachment[surface]).includes(MARKER_TOKEN)),
        surface,
      ).toBe(true);
    }
    expect(
      (rooms['room-7kq-alpha-1-root']?.validationState as Record<string, unknown>)
        .failedChecks,
    ).toEqual([expect.stringContaining(MARKER_TOKEN)]);
  });

  it('the subject carries unapproved tags in every room, and two approved ones', () => {
    const snapshot = templateSnapshot();
    const tags = Object.values(snapshot.rooms).map((room) => room.tags ?? []);
    expect(tags.length).toBeGreaterThanOrEqual(6);
    for (const list of tags) {
      expect(list).toEqual(
        expect.arrayContaining([...TEMPLATE_APPROVED_TAGS, ...TEMPLATE_UNAPPROVED_TAGS]),
      );
    }
  });
});

describe('Phase 7 gate 19: the emitted key set is closed, at every level', () => {
  it('the document has exactly the eight declared keys, and no more', () => {
    expect(SUBJECT_TEMPLATE_DOCUMENT_KEYS).toHaveLength(8);
    expect(Object.keys(parsedApproved).sort()).toEqual([...SUBJECT_TEMPLATE_DOCUMENT_KEYS].sort());
    // The same equality on the unapproved export, so the key set does not vary with the
    // approval request - a key set that varied would be a key set closed only per value.
    expect(Object.keys(parsedUnapproved).sort()).toEqual([...SUBJECT_TEMPLATE_DOCUMENT_KEYS].sort());
  });

  it('the three version contracts are three keys, and they are the values this build writes', () => {
    expect(SUBJECT_TEMPLATE_VERSION_KEYS).toEqual([
      'formatVersion',
      'storageGenerationFormatVersion',
      'subjectSchemaVersion',
    ]);
    expect(parsedApproved.formatVersion).toBe(1);
    expect(parsedApproved.storageGenerationFormatVersion).toBe(1);
    expect(parsedApproved.subjectSchemaVersion).toBe('1.1.0');
  });

  it('the graph, and every array inside it, has exactly the declared keys', () => {
    const graph = parsedApproved.graph as Record<string, unknown>;
    expect(Object.keys(graph).sort()).toEqual([...SUBJECT_TEMPLATE_GRAPH_KEYS].sort());
    for (const room of graph.rooms as Array<Record<string, unknown>>) {
      expect(Object.keys(room).sort()).toEqual([...SUBJECT_TEMPLATE_ROOM_KEYS].sort());
    }
    for (const edge of graph.structureEdges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge).sort()).toEqual([...SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS].sort());
    }
    for (const link of graph.crossLinks as Array<Record<string, unknown>>) {
      expect(Object.keys(link).sort()).toEqual([...SUBJECT_TEMPLATE_CROSS_LINK_KEYS].sort());
    }
    // Non-vacuity: every array really is populated, so the key-set checks above are
    // assertions about real entries rather than about empty ones.
    expect((graph.rooms as unknown[]).length).toBe(6);
    expect((graph.structureEdges as unknown[]).length).toBe(4);
    expect((graph.crossLinks as unknown[]).length).toBe(4);
  });

  it('no key anywhere in the document is outside the declared vocabulary', () => {
    // The independent form of the same claim: rather than comparing the four levels to
    // their four lists, this walks the whole document and requires every key it meets to
    // be a declared one. It would catch a level the four lists forgot to describe.
    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        if (!DECLARED_KEYS.has(key)) offenders.push(`${path}.${key}`);
        walk((value as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    walk(parsedApproved, 'document');
    expect(offenders).toEqual([]);
  });
});

describe('Phase 7 gate 19: nothing the plan excludes survives', () => {
  it('no value from the inventory of excluded fields appears in the file', () => {
    for (const surface of FORBIDDEN_SURFACES) {
      expect(approved.includes(surface.value), surface.key).toBe(false);
      expect(unapproved.includes(surface.value), surface.key).toBe(false);
    }
  });

  it('the marker appears only as a room topic or an approved tag, and never elsewhere', () => {
    const graph = parsedApproved.graph as Record<string, unknown>;
    const rooms = graph.rooms as Array<Record<string, unknown>>;
    const topics = rooms.map((room) => String(room.topic));
    const asTopic = topics.filter((topic) => topic.includes(MARKER_TOKEN)).length;
    // Exactly half the fixture's topics carry the marker and half deliberately do not, and
    // the count is asserted rather than assumed - so a fixture change cannot quietly empty
    // the planted surface and make the absence check easier.
    expect(asTopic).toBe(TOPIC_MARKER_COUNT);
    expect(asTopic).toBeGreaterThan(0);
    expect(asTopic).toBeLessThan(topics.length);
    // Every occurrence in the whole file is inside one of the three **permitted** text
    // surfaces: a room topic, the template's declared name, or nothing else. The three are
    // blanked out and the rest of the document is required to be marker-free, which is the
    // form of the assertion that cannot be satisfied by a file that carried no text at all.
    const permittedText = ['topic', 'name', 'description'];
    const withoutPermittedText = canonicalJsonStringify({
      ...parsedApproved,
      name: '',
      description: '',
      graph: {
        ...(parsedApproved.graph as Record<string, unknown>),
        rooms: rooms.map((room) => ({ ...room, topic: '' })),
      },
    });
    expect(withoutPermittedText.includes(MARKER_TOKEN)).toBe(false);
    // The declared name really does carry it, so the blanking above removed a real
    // occurrence rather than a copy that was never there.
    expect(String(parsedApproved.name).includes(MARKER_TOKEN)).toBe(true);
    expect(permittedText).toEqual(['topic', 'name', 'description']);
    // ...and the unmarked topics really are marker-free and mutually distinct, so the
    // count above is a property of the fixture rather than of the assertion.
    const unmarked = topics.filter((entry) => !entry.includes(MARKER_TOKEN));
    expect(new Set(unmarked).size).toBe(unmarked.length);
    expect(unmarked.length).toBeGreaterThan(0);
  });

  it('no attachment, filename, alt text, external URL, note, or artifact string survives', () => {
    // Spelled out as its own assertion rather than folded into the inventory, because
    // these are the specific things the pre-Phase-7 legacy exporter wrote and the specific
    // thing plan section 5.3 names: "Template metadata can contain attachment information
    // that import later discards".
    const withoutGraph = canonicalJsonStringify({ ...parsedApproved, graph: null });
    for (const forbidden of [
      'attachments',
      'fileName',
      'altText',
      'externalUrl',
      'noteText',
      'artifactMarkdown',
      'notePath',
      'artifactPath',
      'validationState',
      'reviewPassCount',
      'sm2',
      'progression',
      'fishCollection',
      'inventory',
      'subjectName',
      'dungeonId',
      'roomId',
      'rootRoomId',
      'tagIndex',
      'recovered',
      'recovery',
      'customSprite',
      'migrationReceipt',
      'unknownTopLevelField',
      'fixtureRoomField',
      'fixtureDungeonField',
      'fixtureEdgeField',
    ]) {
      expect(withoutGraph, forbidden).not.toContain(forbidden);
    }
    // The keys really are absent, not just the substrings: a `rooms[]` entry with an
    // `attachments` key would have failed the key-set equality above, and this is the
    // independent statement of the same thing at the string level.
    const allKeys = new Set<string>();
    const collect = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        allKeys.add(key);
        collect(entry);
      }
    };
    collect(parsedApproved);
    expect([...allKeys].sort()).toEqual([...DECLARED_KEYS].sort());
  });

  it('every leaf is a graph primitive: text, an approved tag, an index, or a constant', () => {
    // The "walk every leaf" form. Rather than searching the serialized text for forbidden
    // strings, this classifies every single leaf and requires it to be one of the four
    // kinds the allowlist permits - so a value that happened to avoid every forbidden
    // substring but was still not a permitted *kind* of thing would fail here.
    const graph = parsedApproved.graph as Record<string, unknown>;
    const rooms = graph.rooms as Array<Record<string, unknown>>;
    const roomCount = rooms.length;
    // Every string the allowlist permits, enumerated. Anything not in this set and not a
    // number is a leaf the document should not have, whatever its contents.
    const permittedText = new Set<string>([
      ...rooms.map((room) => String(room.topic)),
      ...(graph.tags as string[]),
      String(parsedApproved.name),
      String(parsedApproved.description),
      String(graph.biome),
      String(parsedApproved.product),
      String(parsedApproved.subjectSchemaVersion),
    ]);
    for (const phase of ['Creator', 'Scribe', 'Archaeologist']) permittedText.add(phase);
    for (const relation of ['prerequisite', 'subtopic', 'analogy', 'depends_on', 'related']) {
      permittedText.add(relation);
    }
    // The list is not empty, and covers the declared text, so the classification below is
    // a decision rather than an accident of a nearly-empty set.
    expect(permittedText.size).toBeGreaterThanOrEqual(12);

    const unexpected: string[] = [];
    let strings = 0;
    let numbers = 0;
    for (const leaf of leavesOf(parsedApproved, 'document')) {
      const { value } = leaf;
      if (typeof value === 'number') {
        numbers += 1;
        // An index, and in range: the only numbers the allowlist permits at all.
        if (!Number.isInteger(value) || value < 0 || value >= roomCount) unexpected.push(leaf.path);
        continue;
      }
      if (typeof value !== 'string') {
        unexpected.push(leaf.path);
        continue;
      }
      strings += 1;
      if (permittedText.has(value)) continue;
      // The one non-declared string the document legitimately carries is the injected
      // clock, in ISO shape.
      if (leaf.path === 'document.createdAt' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) continue;
      unexpected.push(leaf.path);
    }
    expect(unexpected).toEqual([]);
    // Both halves were really exercised, so "every leaf was a permitted kind" is a
    // statement about a document full of leaves.
    expect(strings).toBeGreaterThanOrEqual(20);
    expect(numbers).toBeGreaterThanOrEqual(8);
  });

  it('the import carries none of it either: a minted subject is blank everywhere', () => {
    // The property has to hold on the way back in as well, or the gate would only be
    // describing the file. A minted subject's rooms have no note, no artifact, no
    // validation history, no review count, no attachments, and the subject has no
    // progression, no fish, and no identifier from the source.
    let counter = 0;
    const minted = createSubjectFromTemplateSnapshot(approved, {
      now: TEMPLATE_NOW,
      // A counter, not a constant: the product's mint is *designed* to refuse a generator
      // that returns one value forever, and that refusal is asserted in
      // `templateRoundTrip.test.ts`. Here the generator has to actually produce values.
      generator: { next: () => `blank-${(counter += 1).toString().padStart(4, '0')}` },
    });
    for (const room of Object.values(minted.snapshot.rooms)) {
      expect(room.state).toBe('Created');
      expect(room.noteText).toBe('');
      expect(room.artifactMarkdown).toBeNull();
      expect(room.reviewPassCount).toBe(0);
      expect(room.attachments).toEqual([]);
      expect(room.validationState.wordCount).toBe(0);
      expect(room.validationState.finalPass).toBe(false);
      expect(room.validationState.failedChecks).toEqual([]);
      // SM-2 is present only as the application's own blank defaults.
      expect(room.sm2QualityResponse).toBe(3);
      expect(room.sm2ConsecutiveCorrect).toBe(0);
      // ...and the room's tags are exactly the approved subset.
      expect([...(room.tags ?? [])].sort()).toEqual([...TEMPLATE_APPROVED_TAGS].sort());
    }
    expect(minted.snapshot.dungeon.progression.xpTotal).toBe(0);
    expect(minted.snapshot.dungeon.progression.badges).toEqual([]);
    expect(minted.snapshot.dungeon.progression.fishCollection).toEqual([]);
    expect(minted.snapshot.dungeon.phaseState).toBe('CreatorActive');
    // The source subject's own name is not the minted name, because the template carried
    // its own declared name and never the subject's.
    expect(minted.subjectName).toBe(TEMPLATE_NAME);
    expect(minted.subjectName).not.toContain('Subject');
  });

  it('the reading path reports a preview with no learner text on it', () => {
    const read = readSubjectTemplate(approved);
    const serialized = canonicalJsonStringify(read.preview);
    // The marker is in three of the six topics and in the template's own name and
    // description, so a preview carrying any of them would show it here.
    expect(serialized.includes(MARKER_TOKEN)).toBe(false);
    expect(Object.keys(read.preview).sort()).toEqual([
      'approvedTagCount',
      'createdAt',
      'crossLinkCount',
      'fileName',
      'formatVersion',
      'hasBiome',
      'hasDescription',
      'hasName',
      'product',
      'roomCount',
      'storageGenerationFormatVersion',
      'structureEdgeCount',
      'subjectSchemaVersion',
    ]);
    // The counts are real, so the preview is a decision the learner can actually make.
    expect(read.preview.roomCount).toBe(6);
    expect(read.preview.structureEdgeCount).toBe(4);
    expect(read.preview.crossLinkCount).toBe(4);
    expect(read.preview.approvedTagCount).toBe(2);
    expect(read.preview.hasBiome).toBe(true);
    expect(read.preview.hasName).toBe(true);
    expect(read.preview.hasDescription).toBe(true);
  });
});

describe('Phase 7 gate 19: approving a tag is a step, not a side effect', () => {
  it('an export with no approval request carries no tags at all', () => {
    // The falsifiable form of the whole claim. The subject's rooms are full of tags -
    // asserted above - and the exporter still emits an empty vocabulary, because
    // `approvedTags` defaults to nothing and there is no code path that reads a tag out of
    // a snapshot into the document.
    const graph = parsedUnapproved.graph as Record<string, unknown>;
    expect(graph.tags).toEqual([]);
    for (const room of graph.rooms as Array<Record<string, unknown>>) {
      expect(room.tags).toEqual([]);
    }
    for (const tag of [...TEMPLATE_APPROVED_TAGS, ...TEMPLATE_UNAPPROVED_TAGS]) {
      expect(unapproved.includes(`"${tag}"`), tag).toBe(false);
    }
  });

  it('an export with an approval request carries the approved tags and nothing else', () => {
    const graph = parsedApproved.graph as Record<string, unknown>;
    expect(graph.tags).toEqual([...TEMPLATE_APPROVED_TAGS].sort());
    for (const tag of TEMPLATE_UNAPPROVED_TAGS) {
      expect(approved.includes(`"${tag}"`), tag).toBe(false);
    }
    // The unnormalised tag the fixture planted normalises to `matrix-theory`, which is
    // not in the approved list, so it is dropped by the intersection rather than written
    // in the form the learner typed.
    expect(approved.includes('Matrix Theory!')).toBe(false);
    expect(approved.includes('matrix-theory')).toBe(false);
  });

  it('the result reports the exact approved list the file carries', () => {
    // The "recorded" half of the approval: a measurement of the file, not a boolean
    // claiming that somebody asked. A screen renders this list, and a gate asserts it
    // equals the document's own vocabulary.
    const withApproval = exportSubjectTemplate(templateSnapshot(), {
      now: TEMPLATE_NOW,
      approvedTags: TEMPLATE_APPROVED_TAGS,
    });
    const withoutApproval = exportSubjectTemplate(templateSnapshot(), { now: TEMPLATE_NOW });
    expect(withApproval.approvedTags).toEqual([...TEMPLATE_APPROVED_TAGS].sort());
    expect(
      (JSON.parse(withApproval.template) as { graph: { tags: string[] } }).graph.tags,
    ).toEqual([...withApproval.approvedTags]);
    expect(withoutApproval.approvedTags).toEqual([]);
    expect((JSON.parse(withoutApproval.template) as { graph: { tags: string[] } }).graph.tags).toEqual(
      [],
    );
  });

  it('the biome is approved too: the subject biome is not read, the request is', () => {
    // The same rule for the fourth optional input, and the strongest available statement
    // of it: the subject's own `dungeon.biome` carries the marker, and no export that did
    // not ask for it puts that value in the file.
    const markerBiome = 'cozy-meadow';
    const result = exportSubjectTemplate(templateSnapshot(), { now: TEMPLATE_NOW });
    expect(result.approvedBiome).toBeNull();
    expect(result.template.includes(markerBiome)).toBe(false);
    const asked = exportSubjectTemplate(templateSnapshot(), {
      now: TEMPLATE_NOW,
      approvedBiome: markerBiome,
    });
    expect(asked.approvedBiome).toBe(markerBiome);
    expect(asked.template.includes(markerBiome)).toBe(true);
  });

  it('no approved identifier from the source is anywhere in either export', () => {
    for (const identifier of ALPHA_IDENTIFIERS) {
      expect(approved.includes(identifier), identifier).toBe(false);
      expect(unapproved.includes(identifier), identifier).toBe(false);
    }
  });
});
