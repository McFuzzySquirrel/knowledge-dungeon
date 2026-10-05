/**
 * Phase 19, verification owner's **defect reproductions**. Both tests in this file are RED.
 *
 * ## Why a red file exists
 *
 * Phase 18's report led that phase's only blocker because it shipped reproductions rather than
 * prose. These are the Phase 19 equivalent: each test below is a minimal, self-contained
 * demonstration of a claim in `src/core/assistance/assistanceEngine.ts` that does not survive
 * probing, with the exact change that would close it. They are not written to be tolerant,
 * skipped, or weakened - they are the defect, executable.
 *
 * | # | Severity | Claim that fails |
 * | --- | --- | --- |
 * | 1 | **HIGH** | "Compared by UTC epoch, so the host time zone cannot change the answer." |
 * | 2 | **MEDIUM** | "Every `Array` derived from caller data is sorted with `compareCodeUnits` before anything reads it." |
 *
 * ## Neither test is a style disagreement
 *
 * Defect 1 produces **different suggestions on two devices holding byte-identical restored state**,
 * which is the exact failure the phase exists to prevent, and it is reachable through a real
 * `.kdsubject` round trip that the archive validator accepts. Defect 2 is an order-dependence in an
 * output field, currently unreachable because room ids are minted uniquely per device - so it is
 * filed as MEDIUM and named as latent rather than dressed up as a live bug.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { daysUntilDue, rankAssistance } from '@/core/assistance/assistanceEngine';
import { toAssistanceSubject } from '@/core/assistance/subjectInput';
import type { AssistanceRoomInput, AssistanceSubjectInput } from '@/core/assistance/types';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import { ensureInitialGeneration, INITIAL_GENERATION_ID } from '@/services/persistence/v2/appState';
import { exportSubjectBackup, importSubjectBackup } from '@/services/persistence/products/subjectBackup';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';

const NOW = '2026-03-16T00:00:00.000Z';
const STUDY = { roomsCleared: 1, notesSubmitted: 1, reviewsCompleted: 1, activeDays: 1, fishKept: 0 };
const bytesOf = (value: unknown): string => JSON.stringify(value);

// ── Defect 1: the stored review date is parsed in the host's time zone ───────

/**
 * The date a room's next review falls due, written as **UTC wall clock with no offset marker**.
 *
 * This is not an exotic shape. `new Date().toISOString().slice(0, 19)` produces it; so does a SQL
 * `DATETIME` column read back through `JSON.stringify`, an XML-RPC or SOAP payload, several
 * third-party study tools, and a hand edit. `toAssistanceRoom` accepts it:
 *
 *     typeof room.sm2NextReviewDate === 'string' && room.sm2NextReviewDate.length > 0
 *
 * There is no format validation on `sm2NextReviewDate` anywhere in `src/`, so the value reaches
 * `daysUntilDue` unchanged.
 */
const UTC_WALL_CLOCK_NO_MARKER = '2026-03-17T04:00:00';

describe('DEFECT 1 (HIGH): identical restored state ranks differently under different host time zones', () => {
  it('daysUntilDue must not depend on the host time zone, for a stored timestamp with no offset', () => {
    // **RED.** The assertion is the property the module header claims - "Compared by UTC epoch, so
    // the host time zone cannot change the answer" - and it fails for any stored timestamp that
    // carries no explicit offset.
    //
    // Measured, so the failure is legible rather than merely red:
    //   UTC 1, America/New_York 1, Asia/Kolkata 0, Australia/Adelaide 0, Pacific/Chatham 0
    // against a `Z`-suffixed control that is 1 in every one of those zones.
    const original = process.env.TZ;
    const offsetless: Record<string, number | null> = {};
    const withMarker: Record<string, number | null> = {};
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Adelaide', 'Pacific/Chatham']) {
        process.env.TZ = zone;
        offsetless[zone] = daysUntilDue(UTC_WALL_CLOCK_NO_MARKER, NOW);
        withMarker[zone] = daysUntilDue('2026-03-17T04:00:00.000Z', NOW);
      }
    } finally {
      process.env.TZ = original;
    }
    // The control really is zone-stable, so this is not "dates are hard".
    expect(new Set(Object.values(withMarker)).size).toBe(1);
    expect(
      offsetless,
      'daysUntilDue read the offset-less timestamp in the host time zone; see the fix below',
    ).toEqual(withMarker);
  });

  it('the ranked bytes must not depend on the host time zone, for the same state', () => {
    // **RED.** The engine's own output, not a helper's return value: in UTC the room is not due and
    // the learner is shown nothing, and in a half-hour-offset zone the *same bytes* produce an
    // `archaeologist.due-room` at priority 40 and a `device.due-today`. A suggestion appearing in one
    // country and not another, from identical state, is the failure this module exists to prevent.
    const room = (overrides: Partial<AssistanceRoomInput> = {}): AssistanceRoomInput => ({
      roomId: 'room-a',
      topic: 'Synthetic Topic',
      state: 'NotesCleared',
      noteWordCount: 0,
      missingSections: [],
      failedChecks: [],
      criterionScores: {},
      finalPass: true,
      reviewPassCount: 0,
      sm2QualityResponse: null,
      sm2NextReviewDate: null,
      tags: [],
      ...overrides,
    });
    const state: AssistanceSubjectInput[] = [
      {
        subjectId: 'synthetic-subject',
        subjectName: 'Synthetic Subject',
        rootRoomId: 'room-root',
        phaseState: 'ArchaeologistUnlocked',
        rooms: [
          room({ roomId: 'room-root' }),
          room({ roomId: 'room-due', sm2NextReviewDate: UTC_WALL_CLOCK_NO_MARKER }),
        ],
        edges: [{ fromRoomId: 'room-root', toRoomId: 'room-due', relationType: 'subtopic' }],
      },
    ];

    const original = process.env.TZ;
    const perZone: string[] = [];
    try {
      for (const zone of ['UTC', 'Asia/Kolkata', 'Australia/Adelaide']) {
        process.env.TZ = zone;
        perZone.push(
          bytesOf(
            rankAssistance({
              mode: 'standard',
              signals: {},
              subjects: state,
              nowIso: NOW,
              flagEnabled: true,
              study: STUDY,
            }),
          ),
        );
      }
    } finally {
      process.env.TZ = original;
    }
    for (const zone of ['Asia/Kolkata', 'Australia/Adelaide']) {
      expect(perZone[1], `${zone} ranked differently from UTC`).toBe(perZone[0]);
      expect(perZone[2], 'Australia/Adelaide ranked differently from UTC').toBe(perZone[0]);
    }
  });

  it('CONTEXT (green): a real .kdsubject accepts the offset-less date and carries it verbatim', async () => {
    // Reachability is the difference between a MEDIUM note and a HIGH finding, so it is driven
    // through the product functions rather than argued from the source.
    const SUBJECT_ID = 'synthetic-tz-subject';
    const ROOM_ID = 'synthetic-tz-room';
    const room = (dueIso: string) => ({
      roomId: ROOM_ID,
      topic: 'Synthetic TZ Topic',
      createdAt: NOW,
      updatedAt: NOW,
      state: 'EncounterDefeated' as const,
      notePath: `rooms/${ROOM_ID}/notes.txt`,
      artifactPath: `rooms/${ROOM_ID}/artifact.md`,
      noteText: 'synthetic',
      artifactMarkdown: 'synthetic',
      validationState: {
        wordCount: 220,
        requiredSectionsPresent: true,
        manualConfirmed: true,
        criterionScores: {
          sectionCompleteness: 2,
          conceptTermCoverage: 2,
          linkReferences: 2,
          recallQuestionQuality: 2,
          clarityReadability: 2,
        },
        failedChecks: [],
        qualityBonus: 10,
        finalPass: true,
      },
      reviewPassCount: 2,
      attachments: [],
      sm2QualityResponse: 5,
      sm2NextReviewDate: dueIso,
    });
    const snapshot = (dueIso: string): SubjectSnapshot =>
      ({
        dungeon: {
          schemaVersion: '1.1.0',
          dungeonId: SUBJECT_ID,
          subjectName: 'Synthetic TZ Subject',
          createdAt: NOW,
          updatedAt: NOW,
          phaseState: 'ArchaeologistUnlocked',
          rootRoomId: ROOM_ID,
          rooms: [{ roomId: ROOM_ID, topic: 'Synthetic TZ Topic', status: 'EncounterDefeated' }],
          edges: [],
          progression: { xpTotal: 320, rank: 'Scholar', badges: [], fishCollection: [] },
        },
        rooms: { [ROOM_ID]: room(dueIso) },
      }) as SubjectSnapshot;

    const source = await openStorageV2Repository({
      databaseName: `qa19-defect1-src-${process.pid}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory('qa19-defect1-src'),
    });
    const target = await openStorageV2Repository({
      databaseName: `qa19-defect1-dst-${process.pid}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory('qa19-defect1-dst'),
    });
    try {
      const generation = await ensureInitialGeneration(source, {
        generationId: INITIAL_GENERATION_ID,
        now: NOW,
      });
      await source.putRecords(generation, {
        subjects: [
          {
            subjectId: SUBJECT_ID,
            schemaVersion: '1.1.0',
            snapshot: snapshot(UTC_WALL_CLOCK_NO_MARKER),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      const exported = await exportSubjectBackup({
        repository: source,
        generationId: generation,
        subjectId: SUBJECT_ID,
        now: NOW,
      });

      const imported = await importSubjectBackup({
        repository: target,
        bytes: exported.bytes,
        mode: 'copy',
        now: NOW,
      });
      // The archive is **accepted**. If it were refused, the defect would be unreachable.
      expect(imported.activated, 'the archive refused the offset-less date, so this is unreachable').toBe(true);

      const restored = await target.readRecords((await target.readActiveGenerationId()) as string);
      const restoredSnapshot = restored.records.subjects[0].value.snapshot;
      // And the date is carried **verbatim** - the round trip is not what normalises it, which is
      // why fixing the adapter is the fix rather than fixing the products.
      const storedDates = Object.values(restoredSnapshot.rooms ?? {}).map((entry) => entry.sm2NextReviewDate);
      expect(storedDates).toEqual([UTC_WALL_CLOCK_NO_MARKER]);

      // Deliberately **no** assertion on the per-zone ranking here. This leg's whole job is
      // reachability - the archive accepts the value and carries it verbatim - and it must keep
      // passing after the defect is fixed. Asserting the divergence here too would encode the bug
      // as an expectation, so that fixing the engine would break the evidence that the bug was ever
      // reachable. The divergence is asserted by the two red tests above, which is where a fix
      // should be measured.
      //
      // Verified by mutation: with a one-line normalising fix in `daysUntilDie`, these two tests
      // stayed green and only the red pair turned green.
      const subject = toAssistanceSubject(restoredSnapshot);
      expect(subject, 'the restored snapshot did not reduce to a subject').not.toBeNull();
      expect((subject as AssistanceSubjectInput).rooms.length).toBeGreaterThan(0);
    } finally {
      source.close();
      target.close();
    }
  });

  it('CONTEXT (green): the fix, stated so it can be applied without re-deriving it', () => {
    // Two acceptable fixes, and the choice is the engine owner's:
    //
    // 1. **Reject the shape.** `toAssistanceRoom` treats a stored `sm2NextReviewDate` without an
    //    explicit offset (`Z` or `±HH:MM`) as absent, exactly as it already treats an empty string
    //    as absent. Smallest change; loses the review schedule for such a record until the next
    //    review pass rewrites it, which `src/core/validation/persistence/subjectMigration.ts` will do
    //    for any room whose value is `null`.
    // 2. **Normalise on read.** `daysUntilDue` appends `Z` when the string carries no offset, so
    //    the value is read as the UTC wall clock its writer meant. Preserves the data; makes an
    //    assumption about which wall clock the writer used, which is wrong for a record written in
    //    local time by this app.
    //
    // Either closes it. What does **not** close it is a third option - documenting the divergence -
    // because the divergence is already documented and the promise in the module header is what is
    // wrong. The header says "Compared by UTC epoch, so the host time zone cannot change the
    // answer"; that sentence has to go or become true.
    expect(UTC_WALL_CLOCK_NO_MARKER).not.toMatch(/(Z|[+-]\d{2}:?\d{2})$/);
    expect('2026-03-17T04:00:00.000Z').toMatch(/Z$/);
    // The observation that the red tests above measure is deliberately *not* asserted here, for the
    // same reason as in the reachability leg: once the fix lands, `daysUntilDue` returns 1 in every
    // zone for this input, and a test that encoded `Asia/Kolkata: 0` would then fail and take the
    // record of the bug with it.
  });
});

// ── Defect 2: `findSubjectIdForRoom` reads `subjects` in the caller's order ─

describe('DEFECT 2 (MEDIUM): the caller array order decides which subject a room is attributed to', () => {
  const room = (overrides: Partial<AssistanceRoomInput> = {}): AssistanceRoomInput => ({
    roomId: 'room-a',
    topic: 'Synthetic Topic',
    state: 'NotesDrafted',
    noteWordCount: 0,
    missingSections: [],
    failedChecks: [],
    criterionScores: {},
    finalPass: true,
    reviewPassCount: 0,
    sm2QualityResponse: null,
    sm2NextReviewDate: null,
    tags: [],
    ...overrides,
  });
  const subjectWith = (subjectId: string, roomId: string): AssistanceSubjectInput => ({
    subjectId,
    subjectName: 'Synthetic Subject',
    rootRoomId: `${roomId}-root`,
    phaseState: 'ScribeActive',
    rooms: [
      room({ roomId: `${roomId}-root` }),
      room({ roomId: roomId, finalPass: false, missingSections: ['Summary'] }),
    ],
    edges: [{ fromRoomId: `${roomId}-root`, toRoomId: roomId, relationType: 'subtopic' }],
  });

  it('the ranked bytes must not depend on the order of the subjects array', () => {
    // **RED.** Two subjects that both hold a room with the same id, in a different array order.
    //
    // `findSubjectIdForRoom` returns the **first** subject that owns the room, in the caller's
    // order, while every other rule in the module sorts a copy of `subjects` by `subjectId` first.
    // So the two orders disagree about `action.subjectId` - a field a surface renders and a
    // dismissal would be recorded against.
    //
    // MEDIUM rather than HIGH because the shipping id factory mints room ids uniquely per device,
    // which the control test below pins. It is filed as a defect because the module header states
    // the opposite as a blanket claim, and because the comment on `findSubjectIdForRoom` says
    // `tests/phase19/` "pins the multi-subject case explicitly rather than leaving it to chance" -
    // and `findSubjectIdForRoom` appears in no test in the repository. So the documented mitigation
    // is absent as well as the property being false.
    const sharedRoom = (subjectId: string, rootRoomId: string): AssistanceSubjectInput => ({
      subjectId,
      subjectName: 'Synthetic Subject',
      rootRoomId,
      phaseState: 'ScribeActive',
      rooms: [
        room({ roomId: rootRoomId }),
        room({ roomId: 'shared', finalPass: false, missingSections: ['Summary'] }),
      ],
      edges: [{ fromRoomId: rootRoomId, toRoomId: 'shared', relationType: 'subtopic' }],
    });
    const a = sharedRoom('subject-aaa', 'a-root');
    const b = sharedRoom('subject-zzz', 'b-root');

    const base = {
      mode: 'standard' as const,
      signals: {},
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    };
    // Non-vacuity: the collision is real in this input, so the test is not passing because the
    // two orders happen to agree on an unrelated field.
    const forward = rankAssistance({ ...base, subjects: [a, b] });
    const backward = rankAssistance({ ...base, subjects: [b, a] });
    // Non-vacuity, stated order-independently: the two subjects really do both hold a room with the
    // id `shared`, so the lookup has two candidate answers. Asserting a *particular* attribution
    // would encode the bug as an expectation and would fail once the fix lands.
    for (const candidate of [a, b]) {
      expect(
        candidate.rooms.map((entry) => entry.roomId),
        'the fixture no longer collides, so this test would prove nothing',
      ).toContain('shared');
    }
    // And the shared room really does produce a suggestion, so there is an output field to disagree
    // about rather than an empty result that trivially compares equal.
    const attribute = (result: ReturnType<typeof rankAssistance>): string =>
      result.suggestions
        .filter((suggestion) => suggestion.targetId === 'shared')
        .map((suggestion) => suggestion.action.subjectId)
        .join(',');
    expect(attribute(forward)).not.toBe('');
    void backward;

    // The property.
    expect(bytesOf(forward), 'the ranked bytes were order-independent after all').toBe(bytesOf(backward));

    // The fix is one line: sort inside `findSubjectIdForRoom` the way every other reader of
    // `subjects` already does -
    //   for (const subject of [...subjects].sort((l, r) => compareCodeUnits(l.subjectId, r.subjectId)))
    // or, better, resolve the owning subject inside the rule that already knows it, so there is no
    // second lookup with a different iteration order.
  });

  it('CONTEXT (green): with unique room ids - the shape the minting scheme produces - order is irrelevant', () => {
    // The control, and it is why this is MEDIUM and not HIGH. With distinct room ids the subjects
    // array order changes nothing, so no learner can reach the defect through the shipping id
    // factory.
    const a = subjectWith('subject-aaa', 'first');
    const b = subjectWith('subject-zzz', 'second');
    const base = {
      mode: 'standard' as const,
      signals: {},
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    };
    expect(bytesOf(rankAssistance({ ...base, subjects: [a, b] }))).toBe(
      bytesOf(rankAssistance({ ...base, subjects: [b, a] })),
    );
  });
});
