/**
 * Phase 6 verifier gate V5 - id-reference validity, and the two claims the remap
 * module makes about its own residual.
 *
 * Exit criterion: "All ID references remain valid after copy import."
 *
 * The remap module states its policy in three passes plus a residual:
 *
 * - 25 declared locations, rewritten by declaration;
 * - a whole-token sweep of every remaining string;
 * - two protected sets, `PROTECTED_TEXT_FIELDS` and `FIXED_VOCABULARY_FIELDS`;
 * - and "A string that contains a mapped id as a *substring* but not as a whole
 *   token ... is carried **verbatim** and counted in
 *   `SubjectRemapResult.unresolvedReferenceCount` ... **The same count covers an
 *   undeclared location that holds an id in an object key**, for the reason given
 *   above."
 *
 * This file attacks that last sentence, and the protection sets, from four
 * directions:
 *
 * - **H1, the residual claim.** An undeclared field holding a room id in an
 *   **object key**. Object keys are never swept (`rewriteValue` iterates
 *   `Object.entries` and keeps `key` as-is), and `rewriteString` - the only thing
 *   that increments the counter - is never called for a key. If the residual
 *   really covers this class, the count moves. If it does not, a copy silently
 *   carries a stale reference *and* reports that nothing was carried verbatim.
 * - **H2, an undeclared subject-id location.** `DungeonMetadata.dungeonId` is the
 *   authoritative subject id in the migration path (`migrations.ts`:
 *   `snapshot.dungeon.dungeonId || subject.subjectId`) and in the app's own
 *   navigation (`setActiveSubjectId(snapshot.dungeon.dungeonId)`), and it is not
 *   in the declared table. When it happens to equal `subjectId` the whole-token
 *   sweep rewrites it by coincidence. When it does not, the copy keeps a
 *   `dungeonId` naming a subject that does not exist - uncounted.
 * - **H3, the protected sets corrupting a real reference.**
 *   `RoomAttachment.relativePath` is protected, and the justification in the module
 *   header is that "a room id appearing in it would be a coincidence". The
 *   Electron attachment path writes `rooms/<roomId>/attachments/<file>` - a room
 *   id as a whole path segment, the exact shape `notePath` and `artifactPath` are
 *   rewritten for and are excluded from protection to handle.
 * - **H4, the protected sets correctly protecting.** The same attack from the other
 *   side: a room topic, a tag, a biome, and an edge `relationType` that are each
 *   exactly a room id must all survive, or the module corrupts the learner's words.
 *
 * Every case is a live measurement. No `it.fails`.
 */

import { describe, expect, it } from 'vitest';


import {
  SUBJECT_VERBATIM_DISCLOSURE_CODES,
  remapSubjectRecords,
} from '@/services/persistence/products/idRemapping';
import {
  exportSubjectBackup,
  importSubjectBackup,
} from '@/services/persistence/products/subjectBackup';
import {
  ALPHA,
  ATT_ALPHA,
  R_SIDE,
  forgeDevice,
  readActiveValues,
  type ForgedDevice,
} from './support/forge';

const NOW = '2026-05-06T07:08:09.000Z';

/** A counter generator, so a minted id is predictable per call. */
function counter(prefix = 'probe'): { next: () => string } {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${prefix}-${n.toString().padStart(4, '0')}`;
    },
  };
}

const SUBJECT_ID = 'subj-probe-1';
const ROOM_A = 'room-probe-a';
const ROOM_B = 'room-probe-b';

function probeSubject(extra: Record<string, unknown> = {}) {
  return {
    subjectId: SUBJECT_ID,
    schemaVersion: '1.1.0',
    snapshot: {
      dungeon: {
        schemaVersion: '1.1.0',
        dungeonId: SUBJECT_ID,
        subjectName: 'Probe',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        phaseState: 'ArchaeologistActive',
        rootRoomId: ROOM_A,
        rooms: [{ roomId: ROOM_A, topic: 'A', status: 'Created' }],
        edges: [],
        progression: { xpTotal: 0, rank: 'Novice', badges: [] },
      },
      rooms: {
        [ROOM_A]: {
          roomId: ROOM_A,
          topic: 'A',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          state: 'Created',
          notePath: `rooms/${ROOM_A}/notes.txt`,
          artifactPath: `rooms/${ROOM_A}/artifact.md`,
          noteText: '',
          artifactMarkdown: null,
          validationState: {},
          reviewPassCount: 0,
          attachments: [],
          ...extra,
        },
        [ROOM_B]: {
          roomId: ROOM_B,
          topic: 'B',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          state: 'Created',
          notePath: `rooms/${ROOM_B}/notes.txt`,
          artifactPath: `rooms/${ROOM_B}/artifact.md`,
          noteText: '',
          artifactMarkdown: null,
          validationState: {},
          reviewPassCount: 0,
          attachments: [],
        },
      },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as never;
}

/** A probe subject that trips both declared verbatim rules at once. */
function forgeCaseWithBothVerbatimRules() {
  const subject = probeSubject({
    attachments: [
      {
        attachmentId: 'att-probe-0002',
        sourceType: 'local',
        fileName: 'att-probe-0002.png',
        mimeType: 'image/png',
        // Names ROOM_B, which this copy remaps, and addresses a file the copy did
        // not move - so the first verbatim rule applies.
        relativePath: `rooms/${ROOM_B}/attachments/att-probe-0002.png`,
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }) as unknown as { subjectId: string; snapshot: { dungeon: Record<string, unknown> } };
  return {
    ...subject,
    // Disagrees with its own subjectId, so the second rule applies.
    snapshot: { ...subject.snapshot, dungeon: { ...subject.snapshot.dungeon, dungeonId: 'subj-probe-1-legacy' } },
  };
}

function remap(subject: unknown) {
  return remapSubjectRecords({
    subject: subject as never,
    progression: [],
    sessions: [],
    assistance: [],
    attachmentMetadata: [],
    attachmentBlobs: [],
    existing: { taken: new Set<string>() },
    generator: counter(),
    now: NOW,
  });
}

/** The remapped room keys, for a readable assertion message. */
function roomKeys(subject: unknown): string[] {
  const snapshot = (subject as { snapshot: { rooms: Record<string, unknown> } }).snapshot;
  return Object.keys(snapshot.rooms);
}

describe('Phase 6 verifier V5: id-reference validity', () => {
  it('H1: an undeclared room id in an object KEY is carried verbatim AND is not counted', () => {
    const result = remap(
      probeSubject({
        probeLinksByRoom: {
          [ROOM_B]: { href: `rooms/${ROOM_B}` },
        },
      }),
    );
    const rooms = (result.subject.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> }).rooms;
    const root = rooms[roomKeys(result.subject)[0] as string] as Record<string, Record<string, unknown>>;
    const links = root.probeLinksByRoom as Record<string, unknown>;

    // The key still names the SOURCE room.
    expect(Object.keys(links)).toEqual([ROOM_B]);
    // Finding 5's corrected position: the header now says an id in an object key is
    // neither swept nor counted. Measured, and the module now agrees: the residual
    // count is the same as for an equivalent record with no key-held id at all.
    const withoutKeyCase = remap(probeSubject());
    expect(result.unresolvedReferenceCount).toBe(withoutKeyCase.unresolvedReferenceCount);
    // ...and it is not disclosed by the *new* channel either, because no declared
    // rule covers an undeclared key - which is the accepted gap, now stated.
    expect(result.verbatimDisclosures).toEqual(withoutKeyCase.verbatimDisclosures);
  });

  it('the verbatim disclosure channel is a closed code set of counts, carrying no identifier', () => {
    // The shape the whole new disclosure rests on: a code from a closed set and a
    // number. A bystander id in here would be a privacy leak rather than a
    // disclosure, so the shape itself is asserted, not just its content.
    expect(SUBJECT_VERBATIM_DISCLOSURE_CODES).toEqual([
      'attachment-relative-path-names-a-remapped-id',
      'stale-subject-dungeon-id',
    ]);
    for (const code of SUBJECT_VERBATIM_DISCLOSURE_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    // The device-wide case: a real device state produces disclosures, and the whole
    // disclosure set is counts and code-shaped tokens only.
    const forged = remap(forgeCaseWithBothVerbatimRules());
    const serialised = JSON.stringify(forged.verbatimDisclosures);
    for (const identifier of [ROOM_A, ROOM_B, SUBJECT_ID, 'subj-probe-1-legacy']) {
      expect(serialised, `a disclosure leaked ${identifier}`).not.toContain(identifier);
    }
    expect(serialised).not.toMatch(/[0-9a-f]{64}/);
    for (const entry of forged.verbatimDisclosures) {
      expect(SUBJECT_VERBATIM_DISCLOSURE_CODES).toContain(entry.code);
      expect(Number.isInteger(entry.count)).toBe(true);
      expect(Object.keys(entry).sort()).toEqual(['code', 'count']);
    }
  });

  it('H1b: the same id in a VALUE is swept and counted differently, so the difference is the key', () => {
    const byValue = remap(probeSubject({ probeLastVisited: ROOM_B }));
    const byKey = remap(probeSubject({ probeLinksByRoom: { [ROOM_B]: { href: 'x' } } }));
    const baseline = remap(probeSubject());
    // A value that is exactly an id is rewritten and is not a residual.
    expect(byValue.unresolvedReferenceCount).toBe(baseline.unresolvedReferenceCount);
    const rooms = (byValue.subject.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> }).rooms;
    const root = rooms[roomKeys(byValue.subject)[0] as string] as Record<string, unknown>;
    expect(root.probeLastVisited).not.toBe(ROOM_B);
    // A key that is exactly an id is neither rewritten nor counted.
    expect(byKey.unresolvedReferenceCount).toBe(baseline.unresolvedReferenceCount);
  });

  it('H2: dungeon.dungeonId is a subject-id location that is not declared, and it is swept only by coincidence', async () => {
    // The app's own writer makes `dungeonId` the subject id, and the migration
    // reads it first. So the two agree on a real device, and the whole-token sweep
    // rewrites it - correct outcome, undeclared mechanism.
    const agreeing = remap(probeSubject());
    const agreeingDungeon = (agreeing.subject.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;
    expect(agreeingDungeon.dungeonId).toBe(agreeing.subject.subjectId);
    expect(agreeingDungeon.dungeonId).not.toBe(SUBJECT_ID);

    // When the subject disagrees with itself - a shape the storage-v2 validator
    // does not refuse, and a hand-made archive can carry - the copy keeps the stale
    // `dungeonId`, which now names no subject on the device, and the residual count
    // does not mention it.
    const base = probeSubject() as unknown as {
      subjectId: string;
      snapshot: { dungeon: Record<string, unknown> };
    };
    const stale = {
      ...base,
      snapshot: { ...base.snapshot, dungeon: { ...base.snapshot.dungeon, dungeonId: 'subj-probe-1-legacy' } },
    };
    const result = remap(stale);
    const outDungeon = (result.subject.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;
    // Carried verbatim: it names no subject the archive declares, so no mapping is
    // minted for it.
    expect(outDungeon.dungeonId).toBe('subj-probe-1-legacy');
    // Finding 6's fix: `dungeonId` is a **declared** location now, so the
    // self-disagreement is its own disclosure with its own closed code, rather than
    // being an undeclared id that happens to be swept. This is the assertion that
    // would have failed before the fix, when the only trace was a substring mention
    // counted as prose.
    const disclosed = result.verbatimDisclosures.find(
      (entry) => entry.code === 'stale-subject-dungeon-id',
    );
    expect(disclosed, 'the stale dungeonId was not disclosed by its own code').toBeDefined();
    expect(disclosed!.count).toBe(1);
  });

  it('H2b: a device whose subject disagrees with its own dungeonId copies into a subject whose dungeonId points nowhere', async () => {
    const device: ForgedDevice = await forgeDevice({ staleDungeonId: true });
    const before = await readActiveValues(device);
    const source = before.subjects.find((r) => r.subjectId === ALPHA);
    const sourceDungeon = (source!.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;
    expect(sourceDungeon.dungeonId).toBe('subj-alpha-0001-legacy-dungeon');
    expect(sourceDungeon.dungeonId).not.toBe(ALPHA);

    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: (
        await exportSubjectBackup({
          repository: device.repository,
          generationId: device.generationId,
          subjectId: ALPHA,
          now: NOW,
          payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
        })
      ).bytes,
      now: NOW,
    });
    const after = await readActiveValues(device);
    const copy = after.subjects.find((r) => r.subjectId === result.importedSubjectId);
    const copyDungeon = (copy!.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;
    // The copy's own subject id is new...
    expect(copy!.subjectId).toBe(result.importedSubjectId);
    // ...and the dungeon id it carries names a subject that does not exist anywhere
    // on the device, and the import disclosed nothing about it.
    expect(copyDungeon.dungeonId).toBe('subj-alpha-0001-legacy-dungeon');
    expect(after.subjects.some((r) => r.subjectId === copyDungeon.dungeonId as string)).toBe(false);
    // Three prose mentions from the forged subject, plus the stale dungeon id, which
    // the snapshot sweep still counts as a string that *mentions* an identifier
    // without being one. So the two channels describe the same value in two
    // vocabularies: the verbatim channel says "deliberately kept, by rule", the
    // residual says "mentions an identifier". Both statements are true of it, and a
    // screen that adds the two numbers will over-count by one - recorded in the
    // report as an INFO, not a defect, because each channel keeps its own documented
    // meaning. What the fix changed is that the value is now *named* by a code
    // rather than being invisible, which is the part that was missing.
    expect(result.unresolvedReferenceCount).toBe(4);
    expect(
      result.verbatimDisclosures.map((entry) => entry.code),
      'the stale dungeonId is disclosed by its own code, not only by the prose bucket',
    ).toEqual(['stale-subject-dungeon-id']);
    expect(result.verbatimDisclosures[0]!.count).toBe(1);
    // The relationship validator has no opinion: it looks at `record.subjectId`,
    // which is correct, and never at `dungeonId`.
    expect(result.disclosedWarnings.map((w) => w.code)).not.toContain('unknown-subject-reference');
  });

  it('H3: PROTECTED_TEXT_FIELDS protects relativePath, which the product writes as rooms/<roomId>/attachments/<file>', () => {
    // The exact string `electron/main.ts` builds.
    const relativePath = `rooms/${ROOM_A}/attachments/att-1234.png`;
    const result = remap(
      probeSubject({
        attachments: [
          {
            attachmentId: 'att-1234',
            sourceType: 'local',
            fileName: 'att-1234.png',
            mimeType: 'image/png',
            relativePath,
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const rooms = (result.subject.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> }).rooms;
    const roomAKey = roomKeys(result.subject).find((key) => rooms[key]?.attachments !== undefined) as string;
    const attachment = (rooms[roomAKey]?.attachments as Array<Record<string, string>>)[0] as Record<string, string>;
    // The room was remapped...
    expect(roomAKey).not.toBe(ROOM_A);
    // ...and the path still names the source room, because `relativePath` is in the
    // protected text set. The identical shape in `notePath` IS rewritten, which is
    // the inconsistency: two fields of the same shape, opposite treatment.
    expect(attachment.relativePath).toBe(relativePath);
    const notePath = rooms[roomAKey]?.notePath as string;
    expect(notePath).not.toBe(`rooms/${ROOM_A}/notes.txt`);
    expect(notePath).toBe(`rooms/${roomAKey}/notes.txt`);
    // Finding 4's corrected position: the behaviour is kept - the path addresses a
    // file this copy did not move, so rewriting it would name a directory that was
    // never created - and it is now *disclosed* through its own closed code rather
    // than being silently carried. Before the fix this was invisible on the result.
    const disclosed = result.verbatimDisclosures.find(
      (entry) => entry.code === 'attachment-relative-path-names-a-remapped-id',
    );
    expect(disclosed, 'the carried relativePath was not disclosed').toBeDefined();
    expect(disclosed!.count).toBe(1);
  });

  it('H4: the protected sets correctly protect prose that equals a room id', () => {
    const subject = probeSubject({ topic: ROOM_B, tags: [ROOM_B] }) as unknown as {
      snapshot: { dungeon: Record<string, unknown> };
    };
    subject.snapshot.dungeon.biome = ROOM_B;
    const result = remap(subject as never);
    const snapshot = result.subject.snapshot as unknown as {
      dungeon: Record<string, unknown>;
      rooms: Record<string, Record<string, unknown>>;
    };
    // The room's topic, which is exactly another room's id.
    const roomAKey = roomKeys(result.subject)[0] as string;
    expect(snapshot.rooms[roomAKey]?.topic).toBe(ROOM_B);
    expect(snapshot.rooms[roomAKey]?.tags).toEqual([ROOM_B]);
    // The biome.
    expect(snapshot.dungeon.biome).toBe(ROOM_B);
  });

  it('H4b: a tag index keyed by a room id keeps the tag and rewrites the value', () => {
    const subject = probeSubject() as unknown as { snapshot: { dungeon: Record<string, unknown> } };
    subject.snapshot.dungeon.tagIndex = { [ROOM_B]: [ROOM_A, ROOM_B] };
    const result = remap(subject as never);
    const dungeon = (result.subject.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;
    const tagIndex = dungeon.tagIndex as Record<string, string[]>;
    // The tag name survives - it is the learner's own word.
    expect(Object.keys(tagIndex)).toEqual([ROOM_B]);
    // The values are room ids and were rewritten.
    const minted = roomKeys(result.subject);
    expect(tagIndex[ROOM_B]).toEqual(minted);
    expect(tagIndex[ROOM_B]).not.toContain(ROOM_A);
  });

  it('H5: prose that merely mentions a room id survives verbatim and IS counted', () => {
    const withProse = remap(probeSubject({ probeSummary: `Reach ${ROOM_B} first.` }));
    const baseline = remap(probeSubject());
    // The prose is untouched...
    const rooms = (withProse.subject.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> }).rooms;
    const roomAKey = roomKeys(withProse.subject)[0] as string;
    expect(rooms[roomAKey]?.probeSummary).toBe(`Reach ${ROOM_B} first.`);
    // ...and, unlike H1, the count DOES move. The difference between this case and
    // H1 is the only thing that separates "disclosed residual" from "silent
    // stale reference".
    expect(withProse.unresolvedReferenceCount).toBe(baseline.unresolvedReferenceCount + 1);
  });

  it('H6: a room id in a non-segment position inside a path is carried verbatim and counted', () => {
    const result = remap(probeSubject({ notePath: `rooms/${ROOM_A}/notes-${ROOM_B}.txt` }));
    const rooms = (result.subject.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> }).rooms;
    const roomAKey = roomKeys(result.subject)[0] as string;
    // The whole-segment rewrite moved ROOM_A and left the embedded ROOM_B, because
    // `notes-<id>.txt` is not a segment that equals the id.
    expect(rooms[roomAKey]?.notePath).toBe(`rooms/${roomAKey}/notes-${ROOM_B}.txt`);
    expect(result.unresolvedReferenceCount).toBeGreaterThan(0);
  });

  it('the residual the product discloses is a real number for a real device state', async () => {
    const device = await forgeDevice();
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: (
        await exportSubjectBackup({
          repository: device.repository,
          generationId: device.generationId,
          subjectId: ALPHA,
          now: NOW,
          payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
        })
      ).bytes,
      now: NOW,
    });
    // The forged subject has exactly three prose mentions of a room id: the root
    // room's note text, the undeclared `forgeField.summary`, and the second
    // session's `forgeNote`. The fourth string that mentions an id - the
    // key-held one in `forgeLinksByRoom` - is not among them, which is H1.
    expect(result.unresolvedReferenceCount).toBe(3);
    // The key-held id (H1) is in the forged subject too, and is not among them.
    const after = await readActiveValues(device);
    const copy = after.subjects.find((r) => r.subjectId === result.importedSubjectId);
    const copyRooms = (copy!.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> }).rooms;
    // `canonicalJsonStringify` sorts every object key, so the room order in the
    // archive is alphabetical rather than the source's insertion order. The forged
    // extras are on the root room, so it is found by its content.
    const rootKey = Object.keys(copyRooms).find((key) => (copyRooms[key] as Record<string, unknown>).forgeField !== undefined) as string;
    expect(rootKey).toBeDefined();
    const rootRoom = copyRooms[rootKey] as Record<string, unknown>;
    const forgeField = rootRoom.forgeField as Record<string, unknown>;
    expect(forgeField.lastVisitedRoomId).not.toBe(R_SIDE);
    const links = rootRoom.forgeLinksByRoom as Record<string, unknown>;
    expect(Object.keys(links)).toEqual([R_SIDE]);
  });
});
