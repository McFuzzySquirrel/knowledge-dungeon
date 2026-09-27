/**
 * Phase 6 data-product gate 2: a replaced subject matches the backup semantically.
 *
 * Plan section 7.3 calls replace "explicit, destructive, and confirmed", and plan
 * Phase 6's exit criterion is "A replaced subject matches the backup semantically".
 * This gate holds both halves:
 *
 * - **The refusals that make it explicit.** A replace without a confirmation flag, a
 *   replace without a named target, a replace whose target is not the archive's own
 *   subject, and a replace of a subject the device does not have are all refused -
 *   and the first two are refused *before the archive is even read*, so a mis-wired
 *   call site cannot destroy anything however good the file it hands over. There is
 *   no "auto" mode and no way to reach replace without asking for it.
 * - **The fidelity.** After a confirmed replace, the device's subject equals the
 *   archive's subject semantically: same room count, same room ids, same edges, same
 *   tag index, same note and artifact text, same SM-2 values, same review counts,
 *   same attachments, same progression including the fish, same sessions, and the
 *   same unknown app-owned fields at every level. "Semantically" is the load-bearing
 *   word - the comparison is canonical-JSON equality of the record *values*, so key
 *   order and envelope bookkeeping are not what is being asserted.
 * - **The destruction is bounded.** Replace destroys exactly the named subject's
 *   records and nothing else. The other subject, the four device-global stores, and
 *   the retained generations are byte-identical, and the counts of what was
 *   destroyed are on the result so a screen can say what happened.
 * - **No remapping happened.** A replace preserves identifiers exactly, so the
 *   mapping is empty and the subject id is the one the archive named.
 *
 * Privacy: the assertions read ids, counts, and canonical record values compared for
 * equality. No assertion copies a subject name, a topic, a note, a filename, or a URL
 * into a failure message - a mismatch is reported as "these two values differ", never
 * by showing either.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import { StorageV2Error, type StorageRecordEnvelope } from '@/services/persistence/v2/schema';
import {
  exportSubjectBackup,
  importSubjectBackup,
  readSubjectArchiveContents,
} from '@/services/persistence/products/subjectBackup';
import {
  NASTY_ATTACHMENT_IDS,
  NASTY_DEVICE_NOW,
  NASTY_GENERATION_ID,
  NASTY_OTHER_SUBJECT_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  resetLegacyStorage,
} from './support/nastySubject';

const NOW = '2026-10-01T00:00:00.000Z';

/** A fresh device per test, so one replace cannot influence the next assertion. */
async function freshDevice(suffix: string): Promise<{
  repository: Awaited<ReturnType<typeof createNastySubjectDevice>>['repository'];
  archive: Uint8Array;
}> {
  resetLegacyStorage();
  const device = await createNastySubjectDevice(`kd-data-gate-replace-${suffix}`);
  const archive = (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
  return { repository: device.repository, archive };
}

async function valuesOf(
  repository: Awaited<ReturnType<typeof createNastySubjectDevice>>['repository'],
  generationId: string,
  store: 'subjects' | 'progression' | 'sessions' | 'assistance' | 'attachmentMetadata' | 'attachmentBlobs',
): Promise<Map<string, unknown>> {
  const snapshot = await repository.readRecords(generationId);
  const out = new Map<string, unknown>();
  for (const envelope of snapshot.records[store] as StorageRecordEnvelope<unknown>[]) {
    out.set(envelope.recordId, envelope.value);
  }
  return out;
}

beforeEach(() => {
  resetLegacyStorage();
});

describe('Phase 6 gate 2: replace is explicit, confirmed, and bounded', () => {
  it('an unconfirmed replace is refused before the archive is read', async () => {
    const { repository, archive } = await freshDevice('unconfirmed');
    const before = await repository.readActiveGenerationId();
    // Four ways a replace can be un-confirmed, including a truthy value of the wrong
    // type: the product asks for `true` exactly, so a call site that passes a string
    // is refused rather than coerced.
    const unconfirmed: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { mode: 'replace' },
      { mode: 'replace', confirmReplace: false },
      { mode: 'replace', replaceSubjectId: NASTY_SUBJECT_ID },
      { mode: 'replace', confirmReplace: 'yes' },
    ];
    for (const request of unconfirmed) {
      let thrown: unknown = null;
      try {
        await importSubjectBackup({ repository, bytes: archive, now: NOW, ...request });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(request)).toBeInstanceOf(StorageV2Error);
      const failure = thrown as StorageV2Error;
      expect(failure.code).toBe('VALIDATION_FAILED');
      // Two distinct refusals, because they are two distinct mistakes: the learner
      // was not asked, or the caller did not say which subject.
      expect(['replace-not-confirmed', 'replace-target-not-named']).toContain(failure.details.reason);
      // ...and the device did not move.
      expect(await repository.readActiveGenerationId()).toBe(before);
    }
  });

  it('a replace naming a different subject is refused, and nothing is destroyed', async () => {
    const { repository, archive } = await freshDevice('disagree');
    const before = await repository.readActiveGenerationId();
    const subjectsBefore = await valuesOf(repository, before as string, 'subjects');
    let thrown: unknown = null;
    try {
      await importSubjectBackup({
        repository,
        bytes: archive,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: NASTY_OTHER_SUBJECT_ID,
        confirmReplace: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).details.reason).toBe('replace-target-disagrees');
    expect(await repository.readActiveGenerationId()).toBe(before);
    const subjectsAfter = await valuesOf(repository, before as string, 'subjects');
    expect([...subjectsAfter.keys()].sort()).toEqual([...subjectsBefore.keys()].sort());
  });

  it('a replace of a subject the device does not have is refused, and the disagreement check comes first', async () => {
    const { repository, archive } = await freshDevice('absent');
    const before = await repository.readActiveGenerationId();
    const beforeSubjects = await valuesOf(repository, before as string, 'subjects');

    // First: a target the archive does not name. The disagreement is caught before
    // the device is even consulted, because "replace this archive's subject" and
    // "replace that other subject" are different requests and the first one is
    // nonsense on its own.
    let disagreement: unknown = null;
    try {
      await importSubjectBackup({
        repository,
        bytes: archive,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: 'subject-data-gate-never-existed',
        confirmReplace: true,
      });
    } catch (error) {
      disagreement = error;
    }
    expect(disagreement).toBeInstanceOf(StorageV2Error);
    expect((disagreement as StorageV2Error).details.reason).toBe('replace-target-disagrees');

    // Second: the target **is** the archive's own subject, but the device no longer
    // holds it. Deliberately constructed by deleting the record through the real
    // repository, so the state is a state storage-v2 accepts and the refusal is the
    // product's rather than the fixture's. "Replace existing" on a subject that does
    // not exist is not a replace, and turning it into one is how a mode becomes a
    // silent overwrite.
    await repository.deleteRecords(before as string, { subjects: [NASTY_SUBJECT_ID] });
    expect((await valuesOf(repository, before as string, 'subjects')).has(NASTY_SUBJECT_ID)).toBe(false);
    const activeAfterDelete = await repository.readActiveGenerationId();
    const subjectsAfterDelete = await valuesOf(repository, activeAfterDelete as string, 'subjects');

    let absent: unknown = null;
    try {
      await importSubjectBackup({
        repository,
        bytes: archive,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: NASTY_SUBJECT_ID,
        confirmReplace: true,
      });
    } catch (error) {
      absent = error;
    }
    expect(absent).toBeInstanceOf(StorageV2Error);
    expect((absent as StorageV2Error).code).toBe('RECORD_NOT_FOUND');
    expect(await repository.readActiveGenerationId()).toBe(activeAfterDelete);
    expect([...(await valuesOf(repository, activeAfterDelete as string, 'subjects')).keys()].sort()).toEqual(
      [...subjectsAfterDelete.keys()].sort(),
    );
    expect([...beforeSubjects.keys()]).toContain(NASTY_SUBJECT_ID);
  });

  it('a confirmed replace preserves every identifier and matches the backup', async () => {
    const { repository, archive } = await freshDevice('faithful');
    const contents = readSubjectArchiveContents(archive);
    const result = await importSubjectBackup({
      repository,
      bytes: archive,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: NASTY_SUBJECT_ID,
      confirmReplace: true,
    });

    expect(result.mode).toBe('replace');
    expect(result.importedSubjectId).toBe(NASTY_SUBJECT_ID);
    expect(result.replacedSubjectId).toBe(NASTY_SUBJECT_ID);
    // No identifier was rewritten. A replace is not a copy with a flag.
    expect(result.idMapping).toEqual([]);
    expect(result.identifiersRemapped).toBe(0);
    expect(result.unresolvedReferenceCount).toBe(0);

    // Semantic equality with the archive, member by member.
    const subjects = await valuesOf(repository, result.generationId, 'subjects');
    expect(subjects.size).toBe(2);
    expect(canonicalJsonStringify(subjects.get(NASTY_SUBJECT_ID))).toBe(
      canonicalJsonStringify(contents.subject),
    );

    // The progression record the device now holds for the replaced subject is the
    // archive's, byte for byte. Only that record: the archive carries one subject, so
    // it has one progression record, and the other subject's is untouched and is
    // asserted in the "bounded" test below.
    const progression = await valuesOf(repository, result.generationId, 'progression');
    expect(canonicalJsonStringify(progression.get(NASTY_SUBJECT_ID))).toBe(
      canonicalJsonStringify(contents.progression[0]),
    );
    // The fish, explicitly: they live inside the progression record, so
    // `progression.json` is the member that carries them, and a comparison that did
    // not look would pass on a record with no fish at all.
    const held = progression.get(NASTY_SUBJECT_ID) as {
      bySubject: Record<string, { fishCollection: unknown[] }>;
    };
    expect(held.bySubject[NASTY_SUBJECT_ID]?.fishCollection.length).toBe(2);

    const sessions = await valuesOf(repository, result.generationId, 'sessions');
    const replacedSessions = [...sessions.entries()].filter(([recordId]) =>
      (sessions.get(recordId) as { subjectId: string }).subjectId === NASTY_SUBJECT_ID,
    );
    // The archive's two sessions replaced the device's three, and the session for a
    // subject that no longer exists was *not* this subject's, so it stayed. That is
    // the bounded destruction: exactly the named subject's records.
    expect(replacedSessions.length).toBe(contents.sessions.length);
    expect(replacedSessions.map(([recordId]) => recordId).sort()).toEqual(
      contents.sessions.map((session) => session.sessionId).sort(),
    );
    expect(sessions.has('session-data-gate-nasty-orphan')).toBe(true);

    const metadata = await valuesOf(repository, result.generationId, 'attachmentMetadata');
    const replacedMetadata = [...metadata.values()].filter(
      (value) => (value as { subjectId: string }).subjectId === NASTY_SUBJECT_ID,
    );
    expect(replacedMetadata.length).toBe(contents.attachmentMetadata.length);
    for (const record of contents.attachmentMetadata) {
      expect(
        replacedMetadata.some(
          (value) => (value as { attachmentId: string }).attachmentId === record.attachmentId,
        ),
        'attachment metadata replaced',
      ).toBe(true);
    }

    // The blob's `storedAt` is the *import* clock, not the archive's: it is a fact
    // about the device the records are being written to, and it is the one value a
    // replace does not carry over verbatim. The bytes and the content hash are the
    // archive's, unchanged.
    const blobs = await valuesOf(repository, result.generationId, 'attachmentBlobs');
    const blob = blobs.get(`blob:${NASTY_ATTACHMENT_IDS.stored}`) as
      | { storedAt: string; byteLength: number; contentHash: string }
      | undefined;
    expect(blob?.storedAt).toBe(NOW);
    expect(blob?.byteLength).toBeGreaterThan(0);
    expect(blob?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // The activation gate agrees.
    const validation = await repository.validateGeneration(result.generationId);
    expect(validation.ok, JSON.stringify(validation.problems)).toBe(true);
    // Exactly one disclosure, and it is the one the base generation already had: the
    // device's own session for a subject the learner deleted. A replace does not
    // invent it and does not hide it, and its presence here proves the disclosure
    // came from the repository's own relationship check rather than being filtered
    // away by the importer.
    expect(result.disclosedWarnings).toEqual([
      { code: 'unknown-subject-reference', scope: 'relationship', count: 1, severity: 'warning' },
    ]);
    expect(result.blockingPolicy).toBe('error-blocks-warning-discloses');
    expect(result.recordCounts.subjects).toBe(2);
    expect(result.recordCounts.sessions).toBe(3);
  });

  it('the destruction is bounded, and the previous generation is retained', async () => {
    const { repository, archive } = await freshDevice('bounded');
    const result = await importSubjectBackup({
      repository,
      bytes: archive,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: NASTY_SUBJECT_ID,
      confirmReplace: true,
    });
    // Exactly the named subject's records were destroyed, and the counts are on the
    // result so a confirmation dialog can say what "replace" means before it runs.
    expect(result.destroyedRecordCounts.subjects).toBe(1);
    expect(result.destroyedRecordCounts.progression).toBe(1);
    // Two of the device's three sessions belong to the replaced subject; the third
    // belongs to a subject that no longer exists and is not this subject's history,
    // so it stays. The filter is by `subjectId`, and nothing broader.
    expect(result.destroyedRecordCounts.sessions).toBe(2);
    expect(result.destroyedRecordCounts.attachments).toBe(2);

    // The unrelated subject and the device-global stores are byte-identical.
    const before = await repository.readRecords(NASTY_GENERATION_ID);
    const after = await repository.readRecords(result.generationId);
    expect(canonicalJsonStringify(after.records.subjects.find(
      (envelope) => envelope.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    )?.value)).toBe(canonicalJsonStringify(before.records.subjects.find(
      (envelope) => envelope.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    )?.value));
    for (const store of ['preferences', 'shortcuts', 'customSprites', 'recovery'] as const) {
      expect(canonicalJsonStringify(after.records[store].map((e) => e.value)), store).toBe(
        canonicalJsonStringify(before.records[store].map((e) => e.value)),
      );
    }
    // The replaced generation is still readable, superseded, with its own subject.
    const retained = await repository.readGeneration(NASTY_GENERATION_ID);
    expect(retained?.descriptor?.status).toBe('superseded');
    expect(
      retained?.records.subjects.some((envelope) => envelope.value.subjectId === NASTY_SUBJECT_ID),
    ).toBe(true);
    expect(result.previousGenerationRetained).toBe(true);
  });

  it('a replace preserves the external-only disclosure, and fabricates no hash', async () => {
    const { repository, archive } = await freshDevice('disclosure');
    const result = await importSubjectBackup({
      repository,
      bytes: archive,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: NASTY_SUBJECT_ID,
      confirmReplace: true,
    });
    expect(result.externalOnlyAttachments.length).toBe(1);
    const disclosure = result.externalOnlyAttachments[0];
    expect(disclosure?.attachmentId).toBe(NASTY_ATTACHMENT_IDS.external);
    expect(disclosure?.contentHash).toBeNull();
    expect(disclosure?.byteLength).toBeNull();
    expect(disclosure?.reason).toBe('historical-external-url');
    expect(disclosure?.sourceType).toBe('external');
    // The record the device holds says the same thing: external-only, no hash.
    const metadata = await valuesOf(repository, result.generationId, 'attachmentMetadata');
    const record = metadata.get(`meta:${NASTY_ATTACHMENT_IDS.external}`) as {
      availability: string;
      contentHash: string | null;
      externalUrl?: string;
    };
    expect(record.availability).toBe('external-only');
    expect(record.contentHash).toBeNull();
    // The record still names the URL so the application can still show the image it
    // already has, and nothing in this module ever dereferences it.
    expect(record.externalUrl).toBe(contents0(archive).externalUrl);
  });

  it('copy and replace disagree about a subject the device already has, and the disagreement is the point', async () => {
    // The same device, the same archive, two modes. Copy adds a second subject and
    // leaves the first alone; replace makes the first subject *be* the archive and
    // leaves the count at two subjects. If the two modes were the same code with a
    // flag, the counts below would be equal.
    const copied = await freshDevice('mode-copy');
    const copyResult = await importSubjectBackup({
      repository: copied.repository,
      bytes: copied.archive,
      now: NOW,
    });
    expect(copyResult.recordCounts.subjects).toBe(3);
    expect(copyResult.importedSubjectId).not.toBe(NASTY_SUBJECT_ID);

    const replaced = await freshDevice('mode-replace');
    const replaceResult = await importSubjectBackup({
      repository: replaced.repository,
      bytes: replaced.archive,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: NASTY_SUBJECT_ID,
      confirmReplace: true,
    });
    expect(replaceResult.recordCounts.subjects).toBe(2);
    expect(replaceResult.importedSubjectId).toBe(NASTY_SUBJECT_ID);
  });
});

/** The archive's own external URL, read through the production reader. */
function contents0(archive: Uint8Array): { externalUrl: string } {
  const contents = readSubjectArchiveContents(archive);
  const record = contents.attachmentMetadata.find(
    (entry) => entry.attachmentId === NASTY_ATTACHMENT_IDS.external,
  );
  return { externalUrl: record?.externalUrl as string };
}
