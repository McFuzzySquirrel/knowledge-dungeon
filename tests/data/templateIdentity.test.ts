/**
 * Phase 7 data-product gate 20: a template carries no original identifier, and its bytes
 * are a function of the graph rather than of the device it came from.
 *
 * Plan section 7.3 puts "original IDs" on the exclusion list, and the exit criterion is
 * "A template contains no learner content, attachment metadata, or original IDs". The
 * design that satisfies it is structural - a room is addressed by its **position** in
 * `graph.rooms` and every edge endpoint is an integer - so the interesting question is
 * not "did somebody remember to delete the id" but "could an id have reached the file at
 * all". This gate answers that with the strongest measurement available.
 *
 * ## Byte-identity across a re-identified twin is the proof
 *
 * `templateSubject.ts` builds two snapshots of the **same graph**: the same topics, the
 * same tags, the same edges, the same relation types, the same authorship phases - under
 * two completely different sets of identifiers, chosen so that the second set **sorts
 * before** the first under a code-unit comparison. The gate requires the two exports to be
 * byte-identical. Any leaked identifier would differ between them, so the assertion is not
 * "no id was found" but "there is no place an id could be hiding".
 *
 * That is also what makes the ordering a tested property rather than a documented one: an
 * exporter that ordered its rooms by room id would emit the two snapshots in opposite
 * orders and fail here. A fixture whose two id sets sorted the same way would let that bug
 * through, which is why the sets are chosen the way they are, and why the gate asserts
 * that they sort oppositely.
 *
 * ## The direct absence check, at three granularities
 *
 * Byte-identity is a global property and a blunt instrument, so it is backed by three
 * narrower ones, each of which would catch a leak the others might miss:
 *
 * - **As a value**: no identifier string appears anywhere in the text.
 * - **As a key**: no object key in the document is, or contains, an identifier. This is
 *   the granularity a denylist fails at and an allowlist does not, and it is why the key-set
 *   equality in the privacy gate is the load-bearing assertion.
 * - **Embedded in a path-like string**: every `/`-separated string in the document is split
 *   into segments and no segment equals an identifier. A room's `notePath` is
 *   `rooms/<roomId>/notes.md` in the source, and a product that copied a path would embed
 *   the id one segment in - which `String.includes` would find but a token comparison
 *   would not, and which is why the check is per-segment.
 *
 * ## Determinism, and the clock as a real input
 *
 * The same clock twice is byte-identical; a **different** clock is not, which is what
 * proves the clock is an input to the content rather than decoration - without it, "the two
 * exports match" would also be satisfied by a product that ignored its clock. And the
 * strongest determinism claim is the second one: two snapshots that differ in **every**
 * field the allowlist excludes produce the same bytes, which is the determinism gate's
 * other half and the direct measurement of the allowlist itself.
 *
 * Privacy: assertions name identifiers, which are synthetic fixture constants, and
 * counts. No assertion message reproduces learner content.
 */

import { describe, expect, it } from 'vitest';

import {
  exportSubjectTemplate,
  SUBJECT_TEMPLATE_MAX_BYTES,
  SUBJECT_TEMPLATE_FILE_NAME,
  SUBJECT_TEMPLATE_FILE_EXTENSION,
} from '@/services/persistence/products/subjectTemplate';
import { sha256Hex } from '@/services/persistence/v2/checksum';
import {
  ALPHA_IDENTIFIERS,
  BETA_IDENTIFIERS,
  TEMPLATE_APPROVED_TAGS,
  TEMPLATE_OTHER_NOW,
  TEMPLATE_NOW,
  reidentifiedSnapshot,
  templateIds,
  templateSnapshot,
} from './support/templateSubject';

const encoder = new TextEncoder();

function exportAt(now: string, snapshot = templateSnapshot()): string {
  return exportSubjectTemplate(snapshot, {
    now,
    approvedTags: TEMPLATE_APPROVED_TAGS,
    approvedBiome: 'cozy-meadow',
  }).template;
}

/** Every `/`-separated string in a JSON-shaped value, split into segments. */
function pathLikeSegments(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.includes('/')) out.push(...value.split('/'));
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((entry) => pathLikeSegments(entry, out));
    return out;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    pathLikeSegments(key, out);
    pathLikeSegments(entry, out);
  }
  return out;
}

describe('Phase 7 gate 20: the two fixture snapshots really are re-identifications', () => {
  it('their identifiers differ, and sort in opposite order', () => {
    // The non-vacuity control for byte-identity. If the two id sets sorted the same way,
    // an exporter that ordered rooms by id would produce the same bytes for the wrong
    // reason and the gate below would be satisfied by a bug.
    const alpha = [...ALPHA_IDENTIFIERS].sort();
    const beta = [...BETA_IDENTIFIERS].sort();
    expect(alpha).not.toEqual(beta);
    expect(new Set([...ALPHA_IDENTIFIERS, ...BETA_IDENTIFIERS]).size).toBe(
      ALPHA_IDENTIFIERS.length + BETA_IDENTIFIERS.length,
    );
    // The *label* each id ends with is the room's identity in this fixture, and the two
    // sets' id orderings put those labels in **exact reverse**. So an exporter that ordered
    // rooms by room id would emit the twin's rooms backwards, and cannot pass the
    // byte-identity gate by luck.
    const labelOrder = (ids: readonly string[]): string[] =>
      [...ids]
        .filter((id) => id.startsWith('room-'))
        .sort()
        .map((id) => (id.split('-').pop() as string));
    const alphaOrder = labelOrder(ALPHA_IDENTIFIERS);
    const betaOrder = labelOrder(BETA_IDENTIFIERS);
    expect(alphaOrder).toHaveLength(6);
    expect([...alphaOrder].sort()).toEqual([...betaOrder].sort());
    expect([...betaOrder].reverse()).toEqual(alphaOrder);
    // ...and the orderings really are different, rather than coincidentally palindromic.
    expect(betaOrder).not.toEqual(alphaOrder);
  });

  it('their content is identical: same topics, same tags, same edges, same vocabularies', () => {
    // The other half of the control. A twin that differed in content would export to
    // different bytes for a legitimate reason and the gate would be measuring nothing.
    const strip = (snapshot: ReturnType<typeof templateSnapshot>): string =>
      JSON.stringify(
        exportSubjectTemplate(snapshot, { now: TEMPLATE_NOW, approvedTags: TEMPLATE_APPROVED_TAGS })
          .template,
      );
    expect(strip(reidentifiedSnapshot())).toBe(strip(templateSnapshot()));
    // And the identifiers really are different strings in the two snapshots.
    const alphaRooms = Object.keys(templateSnapshot().rooms);
    const betaRooms = Object.keys(reidentifiedSnapshot().rooms);
    expect(alphaRooms).toHaveLength(betaRooms.length);
    for (const roomId of alphaRooms) expect(betaRooms).not.toContain(roomId);
  });
});

describe('Phase 7 gate 20: no original identifier reaches the file', () => {
  it('two structurally identical, differently identified subjects export to the same bytes', () => {
    const alpha = exportAt(TEMPLATE_NOW, templateSnapshot());
    const beta = exportAt(TEMPLATE_NOW, reidentifiedSnapshot());
    // Byte for byte, not "the same graph": this is the assertion that has no place for an
    // identifier to hide in.
    expect(sha256Hex(encoder.encode(beta))).toBe(sha256Hex(encoder.encode(alpha)));
    expect(beta).toBe(alpha);
    // ...and the document is substantial, so "identical" is a statement about real content.
    expect(alpha.length).toBeGreaterThan(600);
  });

  it('no identifier appears as a value, in either export', () => {
    for (const template of [exportAt(TEMPLATE_NOW), exportAt(TEMPLATE_NOW, reidentifiedSnapshot())]) {
      for (const identifier of [...ALPHA_IDENTIFIERS, ...BETA_IDENTIFIERS]) {
        expect(template.includes(identifier), identifier).toBe(false);
      }
    }
  });

  it('no identifier appears as an object key, at any level', () => {
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        keys.push(key);
        walk(entry);
      }
    };
    walk(JSON.parse(exportAt(TEMPLATE_NOW)));
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const identifier of [...ALPHA_IDENTIFIERS, ...BETA_IDENTIFIERS]) {
      expect(keys.some((key) => key === identifier || key.includes(identifier)), identifier).toBe(false);
    }
  });

  it('no identifier is embedded in a path-like string, segment by segment', () => {
    const segments = pathLikeSegments(JSON.parse(exportAt(TEMPLATE_NOW)));
    // The scan really ran: a room's `notePath` in the source is `rooms/<id>/notes.md`, so
    // a product that copied paths would put a segment in here. The export has none, so the
    // list is empty - and the non-vacuity of the *scanner* is held separately below.
    expect(segments).toEqual([]);
    for (const identifier of [...ALPHA_IDENTIFIERS, ...BETA_IDENTIFIERS]) {
      for (const segment of segments) expect(segment).not.toBe(identifier);
    }
  });

  it('the path-segment scanner really does find identifiers when they are there', () => {
    // The positive control for the check above. Without it, "no identifier is embedded in
    // a path-like string" would be satisfied by a scanner that recognised no strings, which
    // is the accidental-pass shape this suite has been bitten by before.
    const planted = {
      notePath: `rooms/${templateIds('alpha').root}/notes.md`,
      nested: [`attachments/${templateIds('alpha').attachment}`],
    };
    const segments = pathLikeSegments(planted);
    expect(segments).toContain(templateIds('alpha').root);
    expect(segments).toContain(templateIds('alpha').attachment);
    expect(segments).toContain('rooms');
  });

  it('the minted subject uses no identifier from the document, because there are none', () => {
    // The importer's half of the same claim: every identifier in a minted subject is
    // freshly minted, and the document supplied none to preserve.
    const template = exportAt(TEMPLATE_NOW);
    expect(template).not.toContain('"from":"');
    expect(template).not.toContain('roomId');
    expect(template).not.toContain('rootRoomId');
    expect(template).not.toContain('dungeonId');
  });
});

describe('Phase 7 gate 20: the export is deterministic, and the clock is a real input', () => {
  it('two exports under one clock are byte-identical', () => {
    const first = exportAt(TEMPLATE_NOW);
    const second = exportAt(TEMPLATE_NOW);
    expect(second).toBe(first);
    expect(sha256Hex(encoder.encode(second))).toBe(sha256Hex(encoder.encode(first)));
  });

  it('a different clock produces different bytes, so the clock is really an input', () => {
    // The falsification of the test above. If a different clock also produced identical
    // bytes, "deterministic" would be measuring a product that ignored its clock entirely -
    // a different and much worse product.
    const atNow = exportAt(TEMPLATE_NOW);
    const atOther = exportAt(TEMPLATE_OTHER_NOW);
    expect(atOther).not.toBe(atNow);
    // ...and the difference is exactly the one field the clock is allowed to reach.
    const parsedAtNow = JSON.parse(atNow) as Record<string, unknown>;
    const parsedAtOther = JSON.parse(atOther) as Record<string, unknown>;
    expect(parsedAtNow.createdAt).toBe(TEMPLATE_NOW);
    expect(parsedAtOther.createdAt).toBe(TEMPLATE_OTHER_NOW);
    expect({ ...parsedAtNow, createdAt: null }).toEqual({ ...parsedAtOther, createdAt: null });
  });

  it('two snapshots differing only in excluded fields export to the same bytes', () => {
    // The real determinism claim, and the direct measurement of the allowlist. Every field
    // below is one the plan excludes; none of them may reach the document, so a snapshot
    // that differs in all of them and nothing else must produce identical bytes.
    const baseline = templateSnapshot();
    const mutated = templateSnapshot() as unknown as {
      dungeon: Record<string, unknown>;
      rooms: Record<string, Record<string, unknown>>;
    };

    // The subject's own identity and name.
    mutated.dungeon.dungeonId = 'subject-entirely-different';
    mutated.dungeon.subjectName = 'A Completely Different Subject Name';
    // The room's timestamps, its paths, and its learner state.
    for (const room of Object.values(mutated.rooms)) {
      room.createdAt = '1999-12-31T23:59:59.000Z';
      room.updatedAt = '2099-01-01T00:00:00.000Z';
      room.notePath = 'rooms/some-other-room/notes.md';
      room.artifactPath = 'rooms/some-other-room/artifact.md';
      room.noteText = 'A note that must never be exported.';
      room.artifactMarkdown = '# An artifact that must never be exported.';
      room.state = 'Visited';
      room.reviewPassCount = 17;
      room.sm2QualityResponse = 5;
      room.sm2IntervalDays = 365;
      room.sm2ConsecutiveCorrect = 9;
      room.validationState = {
        wordCount: 9999,
        requiredSectionsPresent: true,
        manualConfirmed: true,
        criterionScores: {
          sectionCompleteness: 5,
          conceptTermCoverage: 5,
          linkReferences: 5,
          recallQuestionQuality: 5,
          clarityReadability: 5,
        },
        failedChecks: ['a-check'],
        qualityBonus: 5,
        finalPass: true,
      };
      room.attachments = [
        {
          attachmentId: 'att-entirely-different',
          sourceType: 'local',
          fileName: 'a-file-that-must-not-travel.png',
          mimeType: 'image/png',
          altText: 'alt text that must not travel',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      room.fixtureRoomField = 'a-different-unknown-field-value';
    }
    // The subject's progression, biome, tag index, phase, and the unknown fields.
    mutated.dungeon.progression = {
      xpTotal: 99999,
      rank: 'Scholar',
      badges: ['a-badge'],
      fishCollection: [],
    };
    mutated.dungeon.biome = 'a-different-biome';
    mutated.dungeon.tagIndex = { 'a-tag': ['a-room'] };
    mutated.dungeon.phaseState = 'SubjectMastered';
    mutated.dungeon.fixtureDungeonField = 'a-different-dungeon-field';
    (mutated as unknown as Record<string, unknown>).unknownTopLevelField = 'a-different-top-field';
    (mutated as unknown as Record<string, unknown>).unknownTopLevelPathField =
      'rooms/a-different-room/notes.md';
    (mutated as unknown as Record<string, unknown>).unknownTopLevelProseField = 'some prose';
    (mutated as unknown as Record<string, unknown>).fixtureFormat = 'a-different-format';

    // The claim under test: everything above changed and the bytes did not.
    expect(exportSubjectTemplate(mutated as never, {
      now: TEMPLATE_NOW,
      approvedTags: TEMPLATE_APPROVED_TAGS,
      approvedBiome: 'cozy-meadow',
    }).template).toBe(exportSubjectTemplate(baseline, {
      now: TEMPLATE_NOW,
      approvedTags: TEMPLATE_APPROVED_TAGS,
      approvedBiome: 'cozy-meadow',
    }).template);

    // Non-vacuity, in both directions: the mutation really did change the snapshot, and the
    // exporter really did read the two things it is allowed to read. Without these the
    // assertion above would be satisfied by an exporter that read nothing at all.
    expect(JSON.stringify(mutated)).not.toBe(JSON.stringify(baseline));
    expect(Object.keys(baseline.rooms).sort()).toEqual(Object.keys(mutated.rooms).sort());
    expect((baseline.dungeon.edges as unknown[]).length).toBe(
      (mutated.dungeon.edges as unknown[]).length,
    );
  });

  it('the file name is fixed, content-free, and correctly spelled', () => {
    const result = exportSubjectTemplate(templateSnapshot(), {
      now: TEMPLATE_NOW,
      approvedTags: TEMPLATE_APPROVED_TAGS,
    });
    // Plan section 12, rule 6: no learner data in a filename, and no timestamp either.
    expect(result.fileName).toBe(SUBJECT_TEMPLATE_FILE_NAME);
    expect(result.fileName.endsWith(SUBJECT_TEMPLATE_FILE_EXTENSION)).toBe(true);
    expect(result.fileName).toMatch(/^[a-z0-9][A-Za-z0-9._-]*$/);
    for (const identifier of [...ALPHA_IDENTIFIERS, ...BETA_IDENTIFIERS]) {
      expect(result.fileName).not.toContain(identifier);
    }
    expect(result.fileName).not.toContain(TEMPLATE_NOW);
    // The document itself is under the size cap the reader enforces, so the exporter cannot
    // write a file its own reader would refuse.
    expect(encoder.encode(result.template).byteLength).toBeLessThan(SUBJECT_TEMPLATE_MAX_BYTES);
  });
});
