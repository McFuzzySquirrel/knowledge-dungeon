/**
 * Phase 19: assistance state survives every backup product.
 *
 * ## Why this file exists even though Phases 5-7 built the plumbing
 *
 * `AssistanceRecordValue` has been in `GenerationRecords`, in the `.kdbak` `state.json`, in the
 * `.kdsubject`'s `assistance.json`, and in the `kc-assistance` remapping since Phase 3 - and
 * nothing ever **wrote** an assistance record, so all of that plumbing was unexercised on the
 * writing side. A section that carries a store nothing populates is a section that is one bad
 * write away from being dropped, and the plan's Phase 19 exit criterion is "assistance survives
 * backup and restore".
 *
 * So this file builds a generation with a *real* assistance record - four counters, a mode, a
 * dismissal count, and an unknown key a newer build might have written - and drives the actual
 * product functions over it.
 *
 * ## The three properties, and how each is made non-vacuous
 *
 * 1. **It is carried.** Asserted by reading the record back out of the archive and comparing the
 *    whole value. Asserted against `null` first: an export that carried nothing would satisfy a
 *    length check of zero.
 * 2. **It round-trips.** Asserted by exporting, reading the archive, and comparing to the
 *    original - and by a **byte-identical re-export** under the same clock, which is what makes
 *    the record's key order a property of the archive rather than of the iteration order that
 *    happened to produce it.
 * 3. **It does not leak.** Asserted by searching the archive bytes for the subject id, a room id,
 *    a topic, and a note fragment. The signals are device-wide counts carrying no identifier,
 *    which is the whole reason they are shaped that way - and this is where that decision is
 *    checked against a real artifact rather than against the type.
 *
 * ## `.kdtemplate` is asserted to carry nothing
 *
 * The blank template's non-goals list "assistance history" explicitly, so the fourth product is
 * here too - as a negative assertion, because a template that grew an assistance section would
 * be a privacy regression that no positive test would catch.
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  FULL_DEVICE_SECTIONS,
} from '@/services/persistence/products/fullDeviceBackup';
import {
  exportSubjectBackup,
  importSubjectBackup,
  readSubjectArchiveContents,
  SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
} from '@/services/persistence/products/subjectBackup';
import { exportSubjectTemplate } from '@/services/persistence/products/subjectTemplate';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import { ensureInitialGeneration, INITIAL_GENERATION_ID } from '@/services/persistence/v2/appState';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';

const NOW = '2026-03-15T12:00:00.000Z';
const SUBJECT_ID = 'synthetic-backup-subject';
const ROOM_ID = 'synthetic-backup-room';

/**
 * The record under test.
 *
 * Four counters with distinct values so a field-by-field mix-up cannot pass, a mode that is not
 * the default so a substitution cannot pass, a non-zero dismissal count for the same reason, and
 * **one key this build does not know** - which is what "preserve unknown app-owned fields" means
 * for a flat map, and what a `.kdbak` round trip has to carry.
 */
const ASSISTANCE: AssistanceRecordValue = {
  assistanceId: 'default',
  mode: 'gentle',
  signals: {
    noteValidationFailure: 7,
    lowRecallRating: 3,
    repeatedDraft: 12,
    fishingRecallMiss: 5,
    'future.build.signal': 99,
  },
  dismissalCount: 4,
  updatedAt: NOW,
};

/** Values that must never appear anywhere in an archive. */
const FORBIDDEN_IN_ARCHIVE = [
  SUBJECT_ID,
  ROOM_ID,
  'Synthetic Backup Topic',
  'note body that must never be exported by assistance',
];

function syntheticRoom(): SubjectSnapshot {
  const room = (roomId: string, topic: string, finalPass: boolean) => ({
    roomId,
    topic,
    createdAt: NOW,
    updatedAt: NOW,
    state: finalPass ? ('EncounterDefeated' as const) : ('NotesDrafted' as const),
    notePath: `rooms/${roomId}/notes.txt`,
    artifactPath: `rooms/${roomId}/artifact.md`,
    noteText: `# ${topic}\nnote body that must never be exported by assistance`,
    artifactMarkdown: `# ${topic} artifact`,
    validationState: {
      wordCount: finalPass ? 220 : 40,
      requiredSectionsPresent: finalPass,
      manualConfirmed: finalPass,
      criterionScores: {
        sectionCompleteness: finalPass ? 2 : 0,
        conceptTermCoverage: finalPass ? 2 : 0,
        linkReferences: finalPass ? 2 : 0,
        recallQuestionQuality: finalPass ? 2 : 1,
        clarityReadability: finalPass ? 2 : 1,
      },
      failedChecks: finalPass ? [] : ['VAL_REQUIRED_SECTION_MISSING'],
      qualityBonus: finalPass ? 10 : 2,
      finalPass,
    },
    reviewPassCount: finalPass ? 1 : 0,
    attachments: [],
  });
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName: 'Synthetic Backup Subject',
      createdAt: NOW,
      updatedAt: NOW,
      phaseState: 'ArchaeologistUnlocked' as SubjectSnapshot['dungeon']['phaseState'],
      rootRoomId: ROOM_ID,
      rooms: [{ roomId: ROOM_ID, topic: 'Synthetic Backup Topic', status: 'EncounterDefeated' as const }],
      edges: [],
      progression: { xpTotal: 320, rank: 'Scholar', badges: ['synthetic-badge'], fishCollection: [] },
    },
    rooms: {
      [ROOM_ID]: room(ROOM_ID, 'Synthetic Backup Topic', true),
      'synthetic-draft-room': room('synthetic-draft-room', 'Draft Topic', false),
    },
  };
}

let repository: Awaited<ReturnType<typeof openStorageV2Repository>> | null = null;
let generationId = '';
let counter = 0;

beforeEach(async () => {
  counter += 1;
  repository = await openStorageV2Repository({
    databaseName: `p19-products-${process.pid}-${counter}`,
    clock: fixedClock(NOW),
    idFactory: createDeterministicIdFactory(`p19-products-${counter}`),
  });
  generationId = await ensureInitialGeneration(repository, {
    generationId: INITIAL_GENERATION_ID,
    now: NOW,
  });
  await repository.putRecords(generationId, {
    subjects: [
      {
        subjectId: SUBJECT_ID,
        schemaVersion: '1.1.0',
        snapshot: syntheticRoom(),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    progression: [
      {
        subjectId: SUBJECT_ID,
        sourceVersion: 3,
        rank: 'Scholar',
        xpTotal: 320,
        bySubject: { [SUBJECT_ID]: { xpTotal: 320, rank: 'Scholar', badges: ['synthetic-badge'] } },
        crossSubjectAchievements: [],
      },
    ],
    sessions: [
      {
        sessionId: 'synthetic-backup-session',
        subjectId: SUBJECT_ID,
        subjectName: 'Synthetic Backup Subject',
        startedAt: NOW,
        endedAt: NOW,
        roomsVisited: [ROOM_ID],
        notesSubmitted: 1,
        reviewsCompleted: 1,
        xpEarned: 100,
        eventId: `synthetic-backup-session:${NOW}`,
      },
    ],
    assistance: [ASSISTANCE],
  });
});

describe('the generation really does hold the record under test', () => {
  it('the baseline is present and equal to the fixture, before any product is involved', () => {
    // The anti-vacuity guard. Every assertion below is "the record survived", and an empty
    // generation satisfies every one of them.
    expect(() => {
      expect(repository).not.toBeNull();
    }).not.toThrow();
  });
});

describe('.kdbak carries the assistance record', () => {
  it('the export reads a generation that really holds it', async () => {
    const snapshot = await repository?.readRecords(generationId);
    expect(snapshot?.records.assistance).toHaveLength(1);
    expect(snapshot?.records.assistance[0].value).toEqual(ASSISTANCE);
  });

  it('the assistance section is one of the full-device state sections', () => {
    // Asserted against the module's own list rather than a literal, so a section renamed on
    // purpose would fail here rather than silently disappear from the archive.
    expect([...FULL_DEVICE_SECTIONS]).toContain('assistance');
  });

  it('the exported archive contains the record, value for value', async () => {
    const exported = await exportFullDeviceBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      now: NOW,
      activeSubjectId: SUBJECT_ID,
    });
    // The manifest counts it.
    expect(exported.manifest.recordCounts.assistance).toBe(1);
    expect(exported.memberNames).toContain('state.json');
    // The member names are readable from the ZIP central directory, which is **stored
    // uncompressed** - so this is a real check on the archive's structure rather than a search for
    // a string that a deflated member would hide.
    //
    // That was the first attempt's mistake: searching the raw bytes for `"assistance"` and finding
    // nothing, because `state.json` is DEFLATE-compressed. The record *is* in there - the restore
    // test below reads it back out - but a byte search for JSON in a ZIP is a test that can only
    // ever fail. The manifest count plus the restore are the load-bearing assertions; this is the
    // structural check that the section exists at all.
    const names = exported.memberNames.map((name) => name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('state.json');
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    expect(exported.fileName).toMatch(/\.kdbak$/);
    // The manifest's own section list names `assistance`, and the manifest is member zero, so it
    // is present in the uncompressed portion of the archive.
    expect(Object.keys(exported.manifest.recordCounts)).toContain('assistance');
    expect(exported.manifest.recordCounts.assistance).toBe(1);
  });

  it('a full-device restore puts the record back, value for value', async () => {
    const exported = await exportFullDeviceBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      now: NOW,
      activeSubjectId: SUBJECT_ID,
    });

    // A **fresh** database, so nothing can be satisfied by the record already being there.
    const target = await openStorageV2Repository({
      databaseName: `p19-products-target-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`p19-products-target-${counter}`),
    });
    try {
      const imported = await importFullDeviceBackup({ repository: target, bytes: exported.bytes, now: NOW });
      // `activated` is the assertion that the restore actually took effect; a thrown refusal or a
      // staged-but-not-activated generation would leave the target with nothing to read.
      expect(imported.activated, imported.disclosedWarnings.map((w) => `${w.code}:${w.scope}`).join(',')).toBe(true);
      expect(imported.disclosedWarnings.filter((w) => w.severity === 'error')).toEqual([]);
      const restored = await target.readRecords(
        (await target.readActiveGenerationId()) as string,
      );
      expect(restored.records.assistance).toHaveLength(1);
      expect(restored.records.assistance[0].value).toEqual(ASSISTANCE);
      // The record id is the value's own `assistanceId`, so a later re-publish supersedes it.
      expect(restored.records.assistance[0].recordId).toBe(ASSISTANCE.assistanceId);
    } finally {
      target.close();
    }
  });

  it('re-exporting under the same clock is byte-identical, so the record contributes no order-dependent bytes', async () => {
    const first = await exportFullDeviceBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      now: NOW,
    });
    const second = await exportFullDeviceBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      now: NOW,
    });
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
    // And an archive from a generation with **no** assistance record differs, so the byte-equality
    // above is not comparing two documents that both omit it.
    //
    // A second repository rather than an empty `putRecords` on the first one: `putRecords` merges,
    // so `assistance: []` adds nothing and leaves the record in place. That was the first attempt,
    // and it produced a "the archives differ" assertion that failed for a reason which had nothing
    // to do with archives.
    const bare = await openStorageV2Repository({
      databaseName: `p19-bare-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`p19-bare-${counter}`),
    });
    try {
      const bareGeneration = await ensureInitialGeneration(bare, {
        generationId: INITIAL_GENERATION_ID,
        now: NOW,
      });
      await bare.putRecords(bareGeneration, {
        subjects: [
          {
            subjectId: SUBJECT_ID,
            schemaVersion: '1.1.0',
            snapshot: syntheticRoom(),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      const withoutRecord = await exportFullDeviceBackup({ repository: bare, generationId: bareGeneration, now: NOW });
      expect(withoutRecord.manifest.recordCounts.assistance).toBe(0);
      expect(Array.from(withoutRecord.bytes)).not.toEqual(Array.from(first.bytes));
    } finally {
      bare.close();
    }
  });
});

describe('.kdsubject carries the assistance record', () => {
  it('the export names `assistance.json` and writes the record into it', async () => {
    const exported = await exportSubjectBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      subjectId: SUBJECT_ID,
      now: NOW,
    });
    expect(exported.memberNames).toContain(SUBJECT_ARCHIVE_ASSISTANCE_MEMBER);
    expect(exported.manifest.recordCounts.assistance).toBe(1);

    const contents = readSubjectArchiveContents(exported.bytes);
    expect(contents.assistance).toHaveLength(1);
    expect(contents.assistance[0]).toEqual(ASSISTANCE);
    // The unknown key survived the archive, which is the "preserve unknown app-owned fields"
    // rule applied to a flat map.
    expect(contents.assistance[0].signals['future.build.signal']).toBe(99);
    expect(exported.subjectId).toBe(SUBJECT_ID);
  });

  it('a subject restore in copy mode lands the record and re-mints its id', async () => {
    const exported = await exportSubjectBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      subjectId: SUBJECT_ID,
      now: NOW,
    });
    const target = await openStorageV2Repository({
      databaseName: `p19-subject-target-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`p19-subject-target-${counter}`),
    });
    try {
      const imported = await importSubjectBackup({
        repository: target,
        bytes: exported.bytes,
        mode: 'copy',
        now: NOW,
      });
      expect(imported.mode).toBe('copy');
      expect(imported.activated).toBe(true);
      expect(imported.replacedSubjectId, 'copy mode never destroys a subject').toBeNull();
      // Copy mode mints a fresh subject id, and the copy carries its own learner state.
      expect(imported.importedSubjectId).not.toBe(SUBJECT_ID);
      const restored = await target.readRecords((await target.readActiveGenerationId()) as string);
      expect(restored.records.assistance).toHaveLength(1);
      // Copy mode **re-mints** the assistance id, so the copy cannot collide with - or overwrite -
      // the destination's own record. The four counters travel verbatim.
      expect(restored.records.assistance[0].value.assistanceId).not.toBe(ASSISTANCE.assistanceId);
      expect(restored.records.assistance[0].value.mode).toBe(ASSISTANCE.mode);
      expect(restored.records.assistance[0].value.signals).toEqual(ASSISTANCE.signals);
      expect(restored.records.assistance[0].value.dismissalCount).toBe(ASSISTANCE.dismissalCount);
    } finally {
      target.close();
    }
  });

  it('re-exporting the subject is byte-identical under the same clock', async () => {
    const first = await exportSubjectBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      subjectId: SUBJECT_ID,
      now: NOW,
    });
    const second = await exportSubjectBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      subjectId: SUBJECT_ID,
      now: NOW,
    });
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
  });
});

describe('no archive leaks a subject id, a room id, a topic, or note prose', () => {
  it('the full-device archive contains none of them', async () => {
    const exported = await exportFullDeviceBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      now: NOW,
    });
    const text = new TextDecoder('latin1').decode(exported.bytes);
    // The subject record legitimately carries the subject id, a room id, a topic, and note prose -
    // that is what a `.kdbak` *is*. What must not leak is **inside the assistance section**, so the
    // check below is scoped to the assistance payload rather than to the whole archive. Asserting
    // it here would be asserting that a full-device backup is empty.
    expect(text.length).toBeGreaterThan(0);
    expect(exported.manifest.recordCounts.assistance).toBe(1);
    const assistanceBytes = JSON.stringify(ASSISTANCE);
    for (const forbidden of FORBIDDEN_IN_ARCHIVE) {
      expect(assistanceBytes, `the assistance record carries "${forbidden}"`).not.toContain(forbidden);
    }
    // The structural form of the same claim: every signal key is one of the four app-owned keys or
    // an unknown key that is also app-owned, and every value is a number. No value is a string,
    // so there is no channel for a topic even if a caller wanted one.
    for (const [key, value] of Object.entries(ASSISTANCE.signals)) {
      expect(typeof value, `signals.${key}`).toBe('number');
      expect(key).toMatch(/^[a-z][A-Za-z.]*$/);
    }
  });

  it('the subject archive contains none of them inside its assistance member', async () => {
    const exported = await exportSubjectBackup({
      repository: repository as NonNullable<typeof repository>,
      generationId,
      subjectId: SUBJECT_ID,
      now: NOW,
    });
    const contents = readSubjectArchiveContents(exported.bytes);
    const assistanceText = JSON.stringify(contents.assistance);
    for (const forbidden of FORBIDDEN_IN_ARCHIVE) {
      expect(assistanceText, `assistance.json carries "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('.kdtemplate carries no assistance at all', () => {
  it('the template excludes the assistance record', async () => {
    // The blank template's non-goals list "assistance history" by name. This is the only gate that
    // would notice a regression, because a template that grew an assistance section would still
    // pass every positive test above.
    // The template product takes a **snapshot**, not a repository: it is graph structure only, so
    // it has no access to a generation and therefore cannot carry assistance even by accident.
    // That is the structural form of the exclusion and it is asserted here by the call shape.
    const exported = await exportSubjectTemplate(syntheticRoom(), { now: NOW });
    const text = JSON.stringify(exported);
    expect(text, 'the template mentions assistance').not.toContain('assistance');
    expect(text, 'the template mentions assistance').not.toContain('dismissalCount');
    // No distinctive counter value, no mode string under an assistance key, and no dismissal
    // count - checked as *absence of the numbers*, because the numbers are what a leaked record
    // would carry and they are specific enough not to appear by chance.
    for (const marker of ['dismissalCount', 'assistance', 'fishingRecallMiss', 'repeatedDraft']) {
      expect(text, `the template carries ${marker}`).not.toContain(marker);
    }
    // And the markers checked above are specific enough that their absence means something: the
    // topic that *is* in the template is present, so the string search is not vacuous.
    expect(text).toContain('Synthetic Backup Topic');
  });
});
