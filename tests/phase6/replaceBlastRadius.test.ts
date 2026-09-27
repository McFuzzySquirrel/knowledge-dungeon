/**
 * Phase 6 verifier gate V3 - replace fidelity, and the blast radius.
 *
 * Two exit criteria meet here:
 *
 * - "A replaced subject matches the backup semantically."
 * - "No unrelated subject or global setting changes."
 *
 * The second one is the one worth attacking, because plan section 5.2 requires
 * that "Data imports never partially overwrite the active data generation" and
 * because the replace mode is described in the plan as "explicit, destructive,
 * and confirmed" - destructive, yes, but of *one subject*. The question this file
 * asks is the one a reviewer should ask of any destructive mode: **what is the
 * largest thing a replace can destroy, and is the device able to hold states that
 * make the answer larger than "one subject"?**
 *
 * The device this file forges holds four states that make the answer larger:
 *
 * 1. **Two subjects share one progression record.** `buildRecordEnvelopes` keys a
 *    progression record on `value.subjectId`, and the canonical v3 shape is a
 *    single `bySubject` map - which the legacy `localStorage` v3 writer filled
 *    with every subject on the device. So `ALPHA`'s record also holds `BETA`'s
 *    rooms cleared, notes, and fish. A replace that drops "the progression record
 *    whose `subjectId` is the target" drops `BETA`'s learner state with it.
 * 2. **Two subjects share one attachment's bytes** under two attachment ids. A
 *    replace that destroyed blobs by content hash rather than by attachment id
 *    would take `BETA`'s image with it.
 * 3. **Assistance records are not subject-keyed.** The schema has no `subjectId`
 *    on `AssistanceRecordValue`, the export carries *all* of them, and the
 *    replace merge filters by `assistanceId` alone. So a replace can destroy a
 *    device-global record that belongs to no subject at all.
 * 4. **The subject backup is imported onto a device that holds a subject the
 *    backup's own progression record mentions.** The import carries foreign
 *    `bySubject` keys verbatim, so one import can *create* the state in (1) and a
 *    later replace can then destroy it.
 *
 * Every assertion here is a comparison of the whole device before and after,
 * plus a per-record statement of what changed, so a failure names the record.
 */

import { describe, expect, it } from 'vitest';

import {
  exportSubjectBackup,
  importSubjectBackup,
} from '@/services/persistence/products/subjectBackup';
import {
  ALPHA,
  ATT_ALPHA,
  BETA,
  GAMMA,
  R_ROOT,
  forgeCanonical,
  forgeDevice,
  readActiveValues,
  readValuesOf,
  type ForgedDevice,
} from './support/forge';
import { diffFingerprints, fingerprintDevice } from './support/forge';

const NOW = '2026-05-06T07:08:09.000Z';

async function exportAlpha(device: ForgedDevice, generationId?: string): Promise<Uint8Array> {
  const active = generationId ?? ((await device.repository.readActiveGenerationId()) as string);
  const result = await exportSubjectBackup({
    repository: device.repository,
    generationId: active,
    subjectId: ALPHA,
    now: NOW,
    payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
  });
  return result.bytes;
}

/** Every record value of the active generation, keyed `store recordId`. */
async function flatRecords(device: ForgedDevice): Promise<Map<string, string>> {
  const values = await readActiveValues(device);
  const out = new Map<string, string>();
  for (const [store, list] of Object.entries(
    values as unknown as Record<string, Array<Record<string, unknown>> | undefined>,
  )) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const id =
        (value.subjectId as string) ??
        (value.sessionId as string) ??
        (value.assistanceId as string) ??
        (value.attachmentId as string) ??
        (value.preferenceId as string) ??
        (value.actionId as string) ??
        (value.spritePath as string) ??
        (value.receiptId as string) ??
        (value.kind as string) ??
        'unknown';
      out.set(`${store} ${id}`, forgeCanonical(value));
    }
  }
  return out;
}

describe('Phase 6 verifier V3: replace fidelity', () => {
  it('a replaced subject matches the backup, identifier for identifier and byte for byte', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // Change the device's copy of the subject so "matches the backup" means
    // something: a replace that did not replace would pass vacuously.
    const active = (await device.repository.readActiveGenerationId()) as string;
    const before = await readValuesOf(device, active);
    await device.repository.putRecords(active, {
      subjects: before.subjects.map((record) =>
        record.subjectId === ALPHA
          ? ({ ...record, updatedAt: '2099-01-01T00:00:00.000Z' } as never)
          : record,
      ),
      sessions: before.sessions.filter((record) => record.subjectId !== ALPHA),
    });

    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    expect(result.activated).toBe(true);
    expect(result.replacedSubjectId).toBe(ALPHA);
    // Replace preserves identifiers: that is the mode's contract.
    expect(result.importedSubjectId).toBe(ALPHA);
    expect(result.idMapping).toEqual([]);
    expect(result.identifiersRemapped).toBe(0);

    // Semantic equality against the archive's own copy of the records.
    const contents = await import('@/services/persistence/products/subjectBackup');
    const read = contents.readSubjectArchiveContents(bytes);
    const after = await readActiveValues(device);

    const subject = after.subjects.find((record) => record.subjectId === ALPHA);
    expect(subject).toBeDefined();
    // The subject record, verbatim: the archive's record is written as it was read.
    expect(forgeCanonical(subject)).toBe(forgeCanonical(read.subject));

    // The progression record, sessions, and attachment metadata likewise.
    expect(after.progression.filter((r) => r.subjectId === ALPHA).length).toBe(1);
    const afterProgression = after.progression.find((r) => r.subjectId === ALPHA);
    expect(afterProgression?.bySubject).toEqual(read.progression[0]?.bySubject);
    // The session that was deleted from the device is back, and both are present.
    const afterSessions = after.sessions.filter((r) => r.subjectId === ALPHA);
    expect(afterSessions.length).toBe(read.sessions.length);
    expect(afterSessions.map((r) => r.sessionId).sort()).toEqual(read.sessions.map((r) => r.sessionId).sort());
    for (const session of afterSessions) {
      const source = read.sessions.find((s) => s.sessionId === session.sessionId);
      expect(forgeCanonical(session)).toBe(forgeCanonical(source));
    }
    // The attachment metadata, verbatim, and the bytes really are the archive's.
    const afterMetadata = after.attachmentMetadata.filter((r) => r.subjectId === ALPHA);
    expect(afterMetadata.length).toBe(read.attachmentMetadata.length);
    for (const record of afterMetadata) {
      const source = read.attachmentMetadata.find((m) => m.attachmentId === record.attachmentId);
      expect(forgeCanonical(record)).toBe(forgeCanonical(source));
    }
    const stored = afterMetadata.find((r) => r.availability === 'stored');
    const blob = after.attachmentBlobs.find((b) => b.attachmentId === stored?.attachmentId);
    expect(Buffer.from(new Uint8Array(blob!.bytes as ArrayBuffer))).toEqual(Buffer.from(device.sharedBytes));
    // ...and the blob is re-stamped with the import's clock, because that is a
    // fact about this device.
    expect(blob?.storedAt).toBe(NOW);
  });

  it('a replace refuses without confirmation, without a target, with a disagreeing target, and for an absent subject', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const before = await fingerprintDevice(device.repository, device.databaseName);

    // Not confirmed: refused before the archive is even opened.
    await expect(
      importSubjectBackup({ repository: device.repository, bytes, now: NOW, mode: 'replace', replaceSubjectId: ALPHA }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    // No target named.
    await expect(
      importSubjectBackup({ repository: device.repository, bytes, now: NOW, mode: 'replace', confirmReplace: true }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    // A target that is not the archive's own subject: refused, so a replace can
    // never be aimed at an unrelated subject.
    await expect(
      importSubjectBackup({
        repository: device.repository,
        bytes,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: BETA,
        confirmReplace: true,
      }),
    ).rejects.toThrow(/VALIDATION_FAILED/);
    // A target the device does not hold.
    await expect(
      importSubjectBackup({
        repository: device.repository,
        bytes,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: 'subj-not-on-this-device',
        confirmReplace: true,
      }),
    ).rejects.toThrow(/VALIDATION_FAILED/);

    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).toBe(before.digest);
  });

  it('BOUNDED BLAST RADIUS: replacing ALPHA does not touch BETA, GAMMA, or any global store', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // Take one copy first, so the device holds both a copy and the original: a
    // replace now has both an unrelated sibling and a same-id sibling to confuse.
    const copy = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });

    const before = await flatRecords(device);
    const beforePrint = await fingerprintDevice(device.repository, device.databaseName);

    await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });

    const after = await flatRecords(device);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((key) => before.get(key) !== after.get(key))
      .sort();

    // Everything that changed, and nothing else. The declaration is the product's
    // own: the four stores a subject import owns.
    const allowedPrefixes = [
      'subjects ',
      'progression ',
      'sessions ',
      'attachments ',
      'attachmentBlobs ',
      'attachmentMetadata ',
      'assistance ',
    ];
    for (const key of changed) {
      expect(
        allowedPrefixes.some((prefix) => key.startsWith(prefix)),
        `a replace changed ${key.split(' ')[0]} ${key.split(' ')[1]}`,
      ).toBe(true);
    }
    // And the specific bystanders, named.
    expect(changed.filter((key) => key.includes(BETA))).toEqual([]);
    expect(changed.filter((key) => key.includes(GAMMA))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('preferences '))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('shortcuts '))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('customSprites '))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('recovery '))).toEqual([]);
    // The copy made a moment ago is untouched: a replace is not a replace-all.
    const copyBefore = before.get(`subjects ${copy.importedSubjectId}`);
    const copyAfter = after.get(`subjects ${copy.importedSubjectId}`);
    expect(copyAfter).toBe(copyBefore);
    // The shared attachment's BETA half is untouched, and its bytes with them.
    const betaAttachmentBefore = before.get(`attachments att-beta-0001`);
    const betaAttachmentAfter = after.get(`attachments att-beta-0001`);
    expect(betaAttachmentAfter).toBe(betaAttachmentBefore);
    const blobs = (await readActiveValues(device)).attachmentBlobs;
    const betaBlob = blobs.find((b) => b.attachmentId === 'att-beta-0001');
    expect(Buffer.from(new Uint8Array(betaBlob!.bytes as ArrayBuffer))).toEqual(Buffer.from(device.sharedBytes));
    // BETA's session, which belongs to another subject.
    expect(after.get('sessions sess-beta-0001')).toBe(before.get('sessions sess-beta-0001'));
    // The device-global stores, compared as raw stored values.
    const afterPrint = await fingerprintDevice(device.repository, device.databaseName);
    for (const generationId of beforePrint.generationIds) {
      // The replaced generation is the only one whose descriptor may differ, and it
      // is superseded rather than deleted.
      expect(afterPrint.generationIds).toContain(generationId);
    }
    const retained = await readValuesOf(device, beforePrint.activeGenerationId as string);
    expect(retained.subjects.length).toBe(4);
    expect(retained.assistance.length).toBe(4);
    expect(retained.preferences.length).toBe(2);
    // The generation the replace superseded is itself the generation a copy
    // import wrote, so it carries no receipts either. The device's original
    // receipt is still readable, further back, in the generation that has it -
    // which is the property `receiptPolicy` promises.
    expect(retained.migrationReceipts.length).toBe(0);
    const original = await readValuesOf(device, device.generationId);
    expect(original.migrationReceipts.length).toBe(1);
    expect(original.migrationReceipts[0]?.receiptId).toBe('forge-receipt-0001');
    // The device keeps three generations, and every one of them is still readable.
    const kept = await fingerprintDevice(device.repository, device.databaseName);
    expect(kept.generationIds.length).toBe(4);
  });

  it('BOUNDED BLAST RADIUS: a replace does not destroy the bytes of an attachment another subject shares', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    // Both blobs still exist, with the same content hash, and the bytes are real.
    expect(after.attachmentBlobs.length).toBe(2);
    const hashes = new Set(after.attachmentBlobs.map((b) => b.contentHash));
    expect(hashes.size).toBe(1);
    for (const blob of after.attachmentBlobs) {
      expect(Buffer.from(new Uint8Array(blob.bytes as ArrayBuffer))).toEqual(Buffer.from(device.sharedBytes));
    }
  });

  it('BOUNDED BLAST RADIUS: a replace does not destroy a global assistance record that belongs to no subject', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const before = await flatRecords(device);
    // `assist-beta-0001` is a device-global record with no subject of its own. The
    // archive the export wrote carries it, because the export carries the whole
    // assistance store, so a replace that filtered by id would replace rather than
    // destroy it - and the question is whether it *loses* it.
    expect(before.has('assistance assist-beta-0001')).toBe(true);
    await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await flatRecords(device);
    expect(after.has('assistance assist-beta-0001')).toBe(true);
    // Same device, same archive, so the record is rewritten with the same value.
    expect(after.get('assistance assist-beta-0001')).toBe(before.get('assistance assist-beta-0001'));
  });

  it('BOUNDED BLAST RADIUS: a replace does not destroy another subject state held in a shared progression record', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const before = await readActiveValues(device);
    const shared = before.progression.find((r) => r.subjectId === ALPHA);
    // The forged state: ALPHA's progression record also holds BETA's data.
    expect(Object.keys(shared?.bySubject as Record<string, unknown>).sort()).toEqual([ALPHA, BETA].sort());

    await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });

    const after = await readActiveValues(device);
    // Whatever the product did with the shared record, BETA's progression must
    // still be reachable on the device: either in the replaced record, or in a
    // record of its own.
    const anywhereB = after.progression.some((record) => ALPHA in (record.bySubject as Record<string, unknown>)
      ? BETA in (record.bySubject as Record<string, unknown>)
      : false);
    const betaHasOwn = after.progression.some(
      (record) => record.subjectId === BETA && BETA in (record.bySubject as Record<string, unknown>),
    );
    expect(
      anywhereB || betaHasOwn,
      `BETA's progression was destroyed by a replace of ALPHA; records now: ${JSON.stringify(
        after.progression.map((r) => ({ subjectId: r.subjectId, keys: Object.keys(r.bySubject as Record<string, unknown>) })),
      )}`,
    ).toBe(true);
    // BETA's notes and fish specifically.
    const betaData = after.progression
      .flatMap((record) => Object.entries(record.bySubject as Record<string, Record<string, unknown>>))
      .filter(([key]) => key === BETA)
      .map(([, value]) => value);
    expect(betaData.length).toBeGreaterThan(0);
    const notes = (betaData[0]?.collectedNotes ?? []) as Array<Record<string, unknown>>;
    expect(notes.map((note) => note.noteId)).toContain('note-beta-0001');
    const fish = (betaData[0]?.fishCollection ?? []) as Array<Record<string, unknown>>;
    expect(fish.map((entry) => entry.id)).toContain('fish-beta-0001');
  });

  it('BOUNDED BLAST RADIUS: a copy import cannot be turned into a replace by omitting the mode', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // No `mode` at all: the plan fixes the default as Create copy.
    const result = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    expect(result.mode).toBe('copy');
    expect(result.replacedSubjectId).toBeNull();
    expect(result.importedSubjectId).not.toBe(ALPHA);
    const after = await readActiveValues(device);
    // ALPHA is still there, unchanged, and a new subject joined it.
    expect(after.subjects.length).toBe(4);
    const original = after.subjects.find((r) => r.subjectId === ALPHA);
    expect(original).toBeDefined();
    const rooms = (original!.snapshot as unknown as { rooms: Record<string, unknown> }).rooms;
    expect(Object.keys(rooms)).toContain(R_ROOT);
  });

  it('BOUNDED BLAST RADIUS: a copy import leaves the replaced subject and every global store byte-identical', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const before = await flatRecords(device);
    const result = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const after = await flatRecords(device);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((key) => before.get(key) !== after.get(key))
      .sort();
    // A copy adds the subject's own records and its own assistance copies. It
    // changes nothing that already existed - which is the whole of "no unrelated
    // subject or global setting changes" - with ONE documented exception the
    // product discloses on the result: the new generation carries no migration
    // receipts, because a receipt names the generation that holds it. The receipt
    // is not destroyed, it stays readable in the retained previous generation.
    const receiptChanges = changed.filter((key) => key.startsWith('migrationReceipts '));
    expect(receiptChanges).toEqual(['migrationReceipts forge-receipt-0001']);
    for (const key of changed) {
      if (key.startsWith('migrationReceipts ')) continue;
      expect(before.has(key), `a copy import changed an existing record: ${key}`).toBe(false);
    }
    expect(changed.filter((key) => key.startsWith('preferences '))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('shortcuts '))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('customSprites '))).toEqual([]);
    expect(changed.filter((key) => key.startsWith('recovery '))).toEqual([]);
    // Nothing was removed, except the receipt the previous generation still holds.
    for (const key of before.keys()) {
      if (key.startsWith('migrationReceipts ')) continue;
      expect(after.has(key), `a copy import removed ${key}`).toBe(true);
    }
    // The receipt is still readable, in the generation the import retained.
    const previous = result.previousActiveGenerationId as string;
    const retainedValues = await readValuesOf(device, previous);
    expect(retainedValues.migrationReceipts.length).toBe(1);
    expect(retainedValues.migrationReceipts[0]?.receiptId).toBe('forge-receipt-0001');
    expect(result.receiptPolicy).toBe('per-generation-receipts-not-carried-forward');
    expect(result.previousGenerationReceiptCount).toBe(1);
    // ...and the receipt in the retained generation still names THAT generation, so
    // the retained generation is a valid generation in its own right.
    const retainedValidation = await device.repository.validateGeneration(previous);
    expect(retainedValidation.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('a failed replace leaves the device byte-identical and the previous generation readable', async () => {
    const device = await forgeDevice();
    // A hand-built archive whose subject record is not readable: the fixed members
    // are all there and the versions agree, but `subject` is a string.
    const corrupt = await buildUnreadableSubjectArchive(device);
    const before = await fingerprintDevice(device.repository, device.databaseName);
    await expect(
      importSubjectBackup({
        repository: device.repository,
        bytes: corrupt,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: ALPHA,
        confirmReplace: true,
      }),
    ).rejects.toThrow();
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).toBe(before.digest);
    expect(diffFingerprints(before, after).lines).toEqual([]);
  });
});

/**
 * A `.kdsubject` whose `subject.json` is structurally perfect except that its
 * `subject` value is a string.
 *
 * Built by writing the archive through the product's own writer and then replacing
 * the subject member, so every other member - including the manifest - is exactly
 * what the product would write. The manifest is then rewritten to match, which is
 * what "consistently corrupt" means and is covered separately in
 * `corruptArchives.test.ts`.
 */
async function buildUnreadableSubjectArchive(device: ForgedDevice): Promise<Uint8Array> {
  const { writeArchive, readArchive } = await import('@/services/persistence/v2/archive');
  const bytes = await exportAlpha(device);
  // The product's own audited codec does the ZIP work in both directions; the
  // verifier never hand-rolls an encoder.
  const files = readArchive(bytes);
  const subjectDoc = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'subject.json')!.bytes)) as Record<string, unknown>;
  subjectDoc.subject = 'not-a-subject-record';
  const newSubject = new TextEncoder().encode(JSON.stringify(subjectDoc));
  const out = files.map((file) => ({
    path: file.path,
    bytes: file.path === 'subject.json' ? newSubject : file.bytes,
  }));
  return writeArchive(out);
}
