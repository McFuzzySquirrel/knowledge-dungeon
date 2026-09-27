/**
 * Phase 6 verifier gate V4 - a progression record is not owned by the subject it
 * is keyed on.
 *
 * ## What this file used to be
 *
 * Two live demonstrations of two defects. `ProgressionRecordValue` carries **both** a
 * `subjectId` and a `bySubject` map, storage-v2 keys the record on
 * `record.subjectId`, and the canonical v3 `localStorage` shape put **every subject
 * on the device** into one record. So:
 *
 * - **replace mode** dropped every record whose `subjectId` was the target, which
 *   dropped whatever else that record was carrying. A cross-device replace - an
 *   archive whose progression record held only the exported subject - **destroyed a
 *   bystander's rooms cleared, notes, fish, XP and streak**, and reported nothing.
 * - **copy mode** rewrote the *nested* fish, note and loot ids of every `bySubject`
 *   key, so importing a copy of subject A produced a *second, divergent copy* of
 *   subject B's progression. `progressionEnvelopeFrom` flattens every record's
 *   `bySubject`, last writer wins, ordered by `record.subjectId` - so which of the
 *   two identities of the same fish the application read was decided by a string sort
 *   of two opaque ids.
 *
 * **This file is now a positive control for the fix, plus an independent re-attack
 * of it.** Every case asserts the fixed behaviour exactly, and every case carries a
 * non-vacuity control.
 *
 * ## The rule the fix states, which these gates hold it to
 *
 * - The **target's own key** is the archive's, wholesale. A replace is authoritative
 *   about the subject it names, and if the archive carries none, the device's own
 *   entry for that subject is destroyed **and counted**.
 * - A **foreign key** is never destroyed and never merged: base-only preserved,
 *   archive-only applied, conflict keeps the **device's** value. All three counted.
 * - In copy mode, only `bySubject[record.subjectId]` is remapped; a foreign subtree is
 *   carried verbatim and not even swept.
 *
 * No `it.fails`: every case is a live assertion about behaviour that is right now.
 */

import { describe, expect, it } from 'vitest';

import { progressionEnvelopeFrom } from '@/services/persistence/v2/appState';
import { exportSubjectBackup, importSubjectBackup } from '@/services/persistence/products/subjectBackup';
import {
  mergeAssistanceForReplace,
  mergeProgressionForReplace,
} from '@/services/persistence/products/subjectBackup';
import { readArchive, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import type { ProgressionRecordValue } from '@/services/persistence/v2/schema';
import {
  ALPHA,
  ATT_ALPHA,
  BETA,
  GAMMA,
  forgeDevice,
  readActiveValues,
  type ForgedDevice,
} from './support/forge';

const NOW = '2026-05-06T07:08:09.000Z';

async function exportAlpha(device: ForgedDevice, subjectId = ALPHA): Promise<Uint8Array> {
  const result = await exportSubjectBackup({
    repository: device.repository,
    generationId: device.generationId,
    subjectId,
    now: NOW,
    payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
  });
  return result.bytes;
}

/** Every string in a value, so "carried verbatim" can be asserted byte for byte. */
function canonical(value: unknown): string {
  return canonicalJsonStringify(value);
}

/**
 * Rewrite `progression.json` so the archive's progression record holds only the
 * exported subject - the shape a device that never shared a record writes - and
 * repair every declared checksum, so the archive is *consistently* valid.
 *
 * The manifest is rebuilt from the new members, so what this exercises is the
 * product's merge and not its validation.
 */
async function withProgressionLimitedToOwnSubject(bytes: Uint8Array): Promise<Uint8Array> {
  const files = readArchive(bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as Record<string, unknown>;
  const progressionDoc = JSON.parse(
    new TextDecoder().decode(files.find((f) => f.path === 'progression.json')!.bytes),
  ) as { progression: ProgressionRecordValue[] };
  for (const record of progressionDoc.progression) {
    const bySubject = record.bySubject as Record<string, unknown>;
    for (const key of Object.keys(bySubject)) {
      if (key !== record.subjectId) delete bySubject[key];
    }
  }
  const newProgression = new TextEncoder().encode(canonicalJsonStringify(progressionDoc));
  const out = files.map((file) =>
    file.path === 'progression.json' ? { path: file.path, bytes: newProgression } : file,
  );
  const { fullDeviceManifestContentChecksum } = await import(
    '@/services/persistence/products/archiveValidation'
  );
  const members = await Promise.all(
    (manifest.members as Array<{ path: string; byteLength: number; sha256: string }>).map(async (member) => {
      const content = out.find((file) => file.path === member.path)!.bytes;
      return { path: member.path, byteLength: content.byteLength, sha256: sha256Hex(content) };
    }),
  );
  const newManifest = {
    ...manifest,
    members,
    totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
    contentChecksum: fullDeviceManifestContentChecksum(members as never),
  };
  return writeArchive([
    ...out.filter((file) => file.path !== 'manifest.json'),
    { path: 'manifest.json', bytes: new TextEncoder().encode(canonicalJsonStringify(newManifest)) },
  ] as never);
}

/** The progression entries a set of records holds for one subject id. */
function entriesFor(records: readonly ProgressionRecordValue[], subjectId: string): unknown[] {
  return records
    .flatMap((record) => Object.entries(record.bySubject as Record<string, unknown>))
    .filter(([key]) => key === subjectId)
    .map(([, value]) => value);
}

describe('Phase 6 verifier V4: the shared progression record, attacked again', () => {
  it('FIX 1: a cross-device replace PRESERVES the bystander\'s progression, and counts it', async () => {
    const device = await forgeDevice();
    const before = await readActiveValues(device);
    // The state that makes this reachable: the target's record also holds the
    // bystander, which is what the legacy v3 envelope shape produces.
    expect(Object.keys(before.progression.find((r) => r.subjectId === ALPHA)?.bySubject as Record<string, unknown>).sort()).toEqual([ALPHA, BETA].sort());

    // The archive as a *different* device would have written it.
    const bytes = await withProgressionLimitedToOwnSubject(await exportAlpha(device));
    const sanity = await import('@/services/persistence/products/subjectBackup');
    expect(sanity.readSubjectArchive(bytes).recordCounts.progression).toBe(1);

    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    expect(result.activated).toBe(true);

    const after = await readActiveValues(device);
    // THE FIX: the bystander's rooms cleared, notes, fish, XP and streak are all
    // still reachable, under the bystander's own key.
    const betaEntries = entriesFor(after.progression, BETA);
    expect(betaEntries, 'the bystander\'s progression was destroyed').toHaveLength(1);
    const beta = betaEntries[0] as Record<string, unknown>;
    expect((beta.collectedNotes as Array<Record<string, string>>).map((n) => n.noteId)).toContain('note-beta-0001');
    expect((beta.fishCollection as Array<Record<string, string>>).map((f) => f.id)).toContain('fish-beta-0001');
    expect(beta.xpTotal).toBe(11);
    expect(beta.streakCount).toBe(1);
    // ...and the application reads it: not merely present, reachable.
    const envelope = progressionEnvelopeFrom(after.progression);
    expect((envelope.bySubject as Record<string, unknown>)[BETA]).toBeDefined();
    // The subject record and the session survive too, as before the fix.
    expect(after.subjects.some((r) => r.subjectId === BETA)).toBe(true);
    expect(after.sessions.some((r) => r.subjectId === BETA)).toBe(true);
    // ...and the import says what it did, in counts.
    expect(result.foreignState.preservedProgressionKeys).toBe(1);
    expect(result.foreignState.destroyedProgressionKeys).toBe(0);
  });

  it('NON-VACUITY: the bystander\'s entry is preserved VERBATIM, not rebuilt', async () => {
    const device = await forgeDevice();
    const before = await readActiveValues(device);
    const betaBefore = entriesFor(before.progression, BETA)[0];
    const bytes = await withProgressionLimitedToOwnSubject(await exportAlpha(device));
    await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    const betaAfter = entriesFor(after.progression, BETA)[0];
    // Byte-for-byte, keys and all: "preserved" has to mean preserved, or a bystander
    // whose fish ids were renumbered would pass a weaker check.
    expect(canonical(betaAfter)).toBe(canonical(betaBefore));
  });

  it('THE OTHER DIRECTION: with a foreign key preserved, the target\'s own data is still fully replaced', async () => {
    const device = await forgeDevice();
    const bytes = await withProgressionLimitedToOwnSubject(await exportAlpha(device));
    // Change the device's own copy of the target's entry, so "replaced" means
    // something and a merge that kept the device's target entry would fail.
    const active = (await device.repository.readActiveGenerationId()) as string;
    const before = await readActiveValues(device);
    await device.repository.putRecords(active, {
      progression: before.progression.map((record) =>
        record.subjectId === ALPHA
          ? ({
              ...record,
              bySubject: {
                ...(record.bySubject as Record<string, unknown>),
                [ALPHA]: { xpTotal: 999, rank: 'Master', roomsCleared: 77, fishCollection: [], collectedNotes: [], inventory: [], equippedItems: [], badges: [], streakCount: 0 },
              },
            } as never)
          : record,
      ),
    });
    const dirtied = await readActiveValues(device);
    const targetBefore = entriesFor(dirtied.progression, ALPHA)[0] as Record<string, unknown>;
    expect(targetBefore.xpTotal).toBe(999);

    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    const targetAfter = entriesFor(after.progression, ALPHA)[0] as Record<string, unknown>;
    // The target's own entry is the ARCHIVE's, wholesale: the device's edited value
    // is gone, not merged.
    expect(targetAfter.xpTotal).toBe(40);
    expect(targetAfter.roomsCleared).toBe(2);
    expect(targetAfter.xpTotal).not.toBe(999);
    // And the bystander in the same record was still kept. Both halves at once.
    expect(entriesFor(after.progression, BETA)).toHaveLength(1);
    expect(result.foreignState.preservedProgressionKeys).toBe(1);
  });

  it('RE-ATTACK: a foreign key the ARCHIVE also carries is retained from the device, and counted', async () => {
    const device = await forgeDevice();
    // An archive whose progression record carries the bystander too - the same-device
    // export, which is the ordinary case.
    const bytes = await exportAlpha(device);
    const read = (await import('@/services/persistence/products/subjectBackup')).readSubjectArchiveContents(bytes);
    expect(Object.keys(read.progression[0]?.bySubject as Record<string, unknown>).sort()).toEqual([ALPHA, BETA].sort());

    const before = await readActiveValues(device);
    const betaBefore = entriesFor(before.progression, BETA)[0];
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    // A key both hold: the device's value wins, so a replace can never roll a
    // bystander *backwards* to what an archive happened to carry.
    expect(canonical(entriesFor(after.progression, BETA)[0])).toBe(canonical(betaBefore));
    // ...and it is counted as retained rather than as either a loss or a change.
    expect(result.foreignState.retainedProgressionKeys).toBe(1);
    expect(result.foreignState.preservedProgressionKeys).toBe(0);
    expect(result.foreignState.appliedProgressionKeys).toBe(0);
  });

  it('RE-ATTACK: a foreign key whose value DIFFERS on the two sides keeps the device\'s, and the archive\'s is discarded, not merged', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // Make the archive's bystander entry differ from the device's, with a marker only
    // the archive has. This is the case where "keep the device's" could silently drop
    // something the archive believed.
    const files = readArchive(bytes);
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as Record<string, unknown>;
    const document = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'progression.json')!.bytes)) as {
      progression: ProgressionRecordValue[];
    };
    (document.progression[0]!.bySubject as Record<string, Record<string, unknown>>)[BETA] = {
      xpTotal: 4242,
      rank: 'Master',
      roomsCleared: 9,
      collectedNotes: [{ noteId: 'archive-only-note', roomId: 'rm-beta-only' }],
      fishCollection: [{ id: 'archive-only-fish', subjectId: BETA }],
      inventory: [],
      equippedItems: [],
      badges: [],
      streakCount: 9,
      archiveMarker: 'ZX-ARCHIVE-ONLY',
    };
    const newProgression = new TextEncoder().encode(canonicalJsonStringify(document));
    const out = files.map((file) => (file.path === 'progression.json' ? { path: file.path, bytes: newProgression } : file));
    const { fullDeviceManifestContentChecksum } = await import('@/services/persistence/products/archiveValidation');
    const members = (manifest.members as Array<{ path: string; byteLength: number; sha256: string }>).map((member) => {
      const content = out.find((file) => file.path === member.path)!.bytes;
      return { path: member.path, byteLength: content.byteLength, sha256: sha256Hex(content) };
    });
    const corrupt = writeArchive([
      ...out.filter((file) => file.path !== 'manifest.json'),
      {
        path: 'manifest.json',
        bytes: new TextEncoder().encode(
          canonicalJsonStringify({
            ...manifest,
            members,
            totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
            contentChecksum: fullDeviceManifestContentChecksum(members as never),
          }),
        ),
      },
    ] as never);

    const before = await readActiveValues(device);
    const betaBefore = canonical(entriesFor(before.progression, BETA)[0]);
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: corrupt,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    // The device's value, untouched. The rule is a stated policy, not a merge: a
    // bystander's progression is never reconciled from an archive that only happened
    // to carry it.
    expect(canonical(entriesFor(after.progression, BETA)[0])).toBe(betaBefore);
    // The archive's version is not smuggled in under a second key either, which
    // would be the same fork by another route.
    expect(JSON.stringify(after.progression)).not.toContain('archive-only-fish');
    expect(JSON.stringify(after.progression)).not.toContain('ZX-ARCHIVE-ONLY');
    expect(after.progression.flatMap((r) => Object.keys(r.bySubject as Record<string, unknown>)).filter((k) => k === BETA)).toHaveLength(1);
    expect(result.foreignState.retainedProgressionKeys).toBe(1);
  });

  it('RE-ATTACK: an archive carrying NO progression destroys the target\'s own entry, counts it, and keeps the bystander', async () => {
    const device = await forgeDevice();
    const files = readArchive(await exportAlpha(device));
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as Record<string, unknown>;
    const document = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'progression.json')!.bytes)) as {
      progression: ProgressionRecordValue[];
    };
    // An empty, still-valid progression document: zero records.
    document.progression = [];
    const newProgression = new TextEncoder().encode(canonicalJsonStringify(document));
    const out = files.map((file) => (file.path === 'progression.json' ? { path: file.path, bytes: newProgression } : file));
    const { fullDeviceManifestContentChecksum } = await import('@/services/persistence/products/archiveValidation');
    const members = (manifest.members as Array<{ path: string; byteLength: number; sha256: string }>).map((member) => {
      const content = out.find((file) => file.path === member.path)!.bytes;
      return { path: member.path, byteLength: content.byteLength, sha256: sha256Hex(content) };
    });
    const noProgression = writeArchive([
      ...out.filter((file) => file.path !== 'manifest.json'),
      {
        path: 'manifest.json',
        bytes: new TextEncoder().encode(
          canonicalJsonStringify({
            ...manifest,
            members,
            recordCounts: { ...(manifest.recordCounts as Record<string, number>), progression: 0 },
            totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
            contentChecksum: fullDeviceManifestContentChecksum(members as never),
          }),
        ),
      },
    ] as never);

    const before = await readActiveValues(device);
    const targetBefore = canonical(entriesFor(before.progression, ALPHA)[0]);
    const betaBefore = canonical(entriesFor(before.progression, BETA)[0]);
    expect(targetBefore).not.toBe(betaBefore);

    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: noProgression,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    // The target's own entry is GONE - a replace is authoritative, so an archive with
    // no progression means the subject has none.
    expect(entriesFor(after.progression, ALPHA)).toEqual([]);
    // ...and the device's copy of it is what is lost, and it is counted.
    expect(result.foreignState.destroyedProgressionKeys).toBe(1);
    // The bystander is untouched: an archive that says nothing about it cannot take it.
    expect(canonical(entriesFor(after.progression, BETA)[0])).toBe(betaBefore);
    expect(result.foreignState.preservedProgressionKeys).toBe(1);
    // The record survives to carry the bystander, rather than being dropped as an
    // empty husk.
    const survivors = after.progression.filter((record) => record.subjectId === ALPHA);
    expect(survivors).toHaveLength(1);
    expect(Object.keys(survivors[0]!.bySubject as Record<string, unknown>)).toEqual([BETA]);
  });

  it('RE-ATTACK: a replace onto a record whose bystander was its ONLY state keeps the record and the bystander', async () => {
    // The degenerate shape: the target's progression record holds nothing of the
    // target's, only the bystander. A naive "does the archive describe the target?"
    // test would drop the record and take the bystander with it.
    const device = await forgeDevice();
    const active = (await device.repository.readActiveGenerationId()) as string;
    const before = await readActiveValues(device);
    await device.repository.putRecords(active, {
      progression: before.progression.map((record) =>
        record.subjectId === ALPHA
          ? ({ ...record, bySubject: { [BETA]: entriesFor(before.progression, BETA)[0] } } as never)
          : record,
      ),
    });
    const shaped = await readActiveValues(device);
    expect(Object.keys(shaped.progression.find((r) => r.subjectId === ALPHA)!.bySubject as Record<string, unknown>)).toEqual([BETA]);

    const bytes = await withProgressionLimitedToOwnSubject(await exportAlpha(device));
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const after = await readActiveValues(device);
    expect(entriesFor(after.progression, BETA)).toHaveLength(1);
    // The record survives, carrying the bystander, and the archive's own entry for the
    // target is present alongside it.
    const survivor = after.progression.find((record) => record.subjectId === ALPHA);
    expect(survivor).toBeDefined();
    expect(Object.keys(survivor!.bySubject as Record<string, unknown>).sort()).toEqual([ALPHA, BETA].sort());
    expect(result.foreignState.preservedProgressionKeys).toBe(1);
    expect(result.foreignState.destroyedProgressionKeys).toBe(0);
  });

  it('RE-ATTACK: two replaces in sequence do not lose the bystander, and the second is not a no-op for the target', async () => {
    const device = await forgeDevice();
    const bytes = await withProgressionLimitedToOwnSubject(await exportAlpha(device));
    const betaBefore = canonical(entriesFor((await readActiveValues(device)).progression, BETA)[0]);

    const first = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    expect(first.activated).toBe(true);
    expect(entriesFor((await readActiveValues(device)).progression, BETA)).toHaveLength(1);

    // A second replace, from the same archive, on the device the first one produced.
    const second = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    expect(second.activated).toBe(true);

    const after = await readActiveValues(device);
    // The bystander is still there, still byte-for-byte, after two rounds.
    expect(entriesFor(after.progression, BETA)).toHaveLength(1);
    expect(canonical(entriesFor(after.progression, BETA)[0])).toBe(betaBefore);
    // The target is present exactly once: a second replace did not accumulate records.
    expect(after.progression.filter((record) => record.subjectId === ALPHA)).toHaveLength(1);
    // The second round preserves the bystander again, because the archive says
    // nothing about it every time. That is the rule working, not a fresh loss: the
    // value is byte-identical to what the first round left, so the operation is
    // idempotent in effect even though the count is non-zero. The count is a
    // description of what this round did, not a tally of how much is at risk.
    expect(second.foreignState.preservedProgressionKeys).toBe(1);
    expect(second.foreignState.retainedProgressionKeys).toBe(0);
    expect(second.foreignState.destroyedProgressionKeys).toBe(0);
    // ...and a third round changes nothing either.
    const third = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const afterThird = await readActiveValues(device);
    expect(canonical(entriesFor(afterThird.progression, BETA)[0])).toBe(betaBefore);
    expect(afterThird.progression.filter((record) => record.subjectId === ALPHA)).toHaveLength(1);
    expect(third.foreignState.preservedProgressionKeys).toBe(1);
    // Every generation is still readable, so the rollback path is intact across rounds.
    const generations = [first.generationId, second.generationId];
    for (const generationId of generations) {
      const validation = await device.repository.validateGeneration(generationId);
      expect(validation.problems.filter((p) => p.severity === 'error')).toEqual([]);
    }
  });

  it('RE-ATTACK: the last-writer-wins flatten cannot be made to resurrect a stale value', async () => {
    // The mechanism the original defect rode on: `progressionEnvelopeFrom` merges
    // every record's `bySubject`, last writer wins, ordered by `record.subjectId`. A
    // copy import used to put a second, divergent entry for a bystander into a record
    // whose id sorts later, and the application then read the copy. This builds that
    // shape deliberately and shows the flatten resolves the *original* both times.
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const result = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const after = await readActiveValues(device);

    // The copy's progression record holds the bystander verbatim, and there is exactly
    // ONE identity per fish for the bystander anywhere on the device.
    const copyRecord = after.progression.find((r) => r.subjectId === result.importedSubjectId);
    expect(copyRecord).toBeDefined();
    const foreign = (copyRecord!.bySubject as Record<string, Record<string, unknown>>)[BETA];
    expect(foreign, 'the copy must still carry the bystander, verbatim').toBeDefined();
    const original = entriesFor(after.progression, BETA)[0] as Record<string, unknown>;
    expect(canonical(foreign)).toBe(canonical(original));

    // Every fish the device holds for the bystander, by subject id.
    const fishForBystander = after.progression
      .flatMap((record) => Object.entries(record.bySubject as Record<string, Record<string, unknown>>))
      .filter(([key]) => key === BETA)
      .flatMap(([, value]) => (value.fishCollection ?? []) as Array<Record<string, string>>)
      .map((fish) => fish.id);
    // A copy import carries the bystander's subtree into the copy's record verbatim,
    // so the same fish id appears in **two** records. That is duplication, not a
    // fork: the property the defect broke was *one identity per fish*, so the
    // assertion is on the number of distinct identities, and the strongest form of
    // it is that every occurrence is the same original id.
    expect(fishForBystander.length).toBeGreaterThan(0);
    expect(
      new Set(fishForBystander).size,
      `the bystander now has ${fishForBystander.length} fish ids: ${fishForBystander.join(', ')}`,
    ).toBe(1);
    expect(new Set(fishForBystander)).toEqual(new Set(['fish-beta-0001']));
    // ...and every note id for the bystander, likewise.
    const notesForBystander = after.progression
      .flatMap((record) => Object.entries(record.bySubject as Record<string, Record<string, unknown>>))
      .filter(([key]) => key === BETA)
      .flatMap(([, value]) => (value.collectedNotes ?? []) as Array<Record<string, string>>)
      .map((note) => note.noteId);
    expect(new Set(notesForBystander)).toEqual(new Set(['note-beta-0001']));
    // No minted fish or note id **for the bystander** anywhere. Scoped, because the
    // copy's own entry legitimately holds minted ids - those are the copy's.
    const bystanderOnly = JSON.stringify(
      after.progression.flatMap((record) =>
        Object.entries(record.bySubject as Record<string, Record<string, unknown>>),
      ).filter(([key]) => key === BETA).map(([, value]) => value),
    );
    expect(bystanderOnly).not.toContain('kc-fish-forge');
    expect(bystanderOnly).not.toContain('kc-note-forge');
    expect(bystanderOnly).not.toContain('kc-loot-forge');

    // And whatever order the flatten picks, it picks the *same* value, because the two
    // copies are byte-identical. Forced both ways:
    const forward = progressionEnvelopeFrom([...after.progression].sort((l, r) => (l.subjectId < r.subjectId ? -1 : 1)));
    const backward = progressionEnvelopeFrom([...after.progression].sort((l, r) => (l.subjectId < r.subjectId ? 1 : -1)));
    const forwardFish = ((forward.bySubject as Record<string, Record<string, unknown>>)[BETA].fishCollection as Array<Record<string, string>>).map((f) => f.id);
    const backwardFish = ((backward.bySubject as Record<string, Record<string, unknown>>)[BETA].fishCollection as Array<Record<string, string>>).map((f) => f.id);
    expect(forwardFish).toEqual(backwardFish);
    expect(forwardFish).toEqual(['fish-beta-0001']);
  });

  it('NON-VACUITY: the merge is a pure function, and the three foreign outcomes are distinguishable by count alone', () => {
    // Called directly, so the rule is held on its own terms and not only through an
    // import. A bystander key in three positions - base only, archive only, both -
    // must produce three different, individually counted outcomes.
    const base: ProgressionRecordValue[] = [
      {
        subjectId: ALPHA,
        sourceVersion: 3,
        rank: 'Novice',
        xpTotal: 1,
        bySubject: { [ALPHA]: { xpTotal: 1 }, [BETA]: { xpTotal: 2 }, 'subj-delta-0004': { xpTotal: 4 } },
        crossSubjectAchievements: [],
      } as never,
    ];
    const archive: ProgressionRecordValue[] = [
      {
        subjectId: ALPHA,
        sourceVersion: 3,
        rank: 'Master',
        xpTotal: 9,
        bySubject: { [ALPHA]: { xpTotal: 9 }, [BETA]: { xpTotal: 8 }, 'subj-gamma-0003': { xpTotal: 3 } },
        crossSubjectAchievements: [],
      } as never,
    ];
    const merged = mergeProgressionForReplace(base, archive, ALPHA);
    // One preserved, one applied, one retained: each distinguishable.
    expect(merged.preservedProgressionKeys).toBe(1);
    expect(merged.appliedProgressionKeys).toBe(1);
    expect(merged.retainedProgressionKeys).toBe(1);
    expect(merged.destroyedProgressionKeys).toBe(0);
    const map = merged.records[0]!.bySubject as Record<string, Record<string, number>>;
    // The target's own entry is the archive's, wholesale.
    expect(map[ALPHA]!.xpTotal).toBe(9);
    // The conflict keeps the device's value - not the archive's 8, and not a merge.
    expect(map[BETA]!.xpTotal).toBe(2);
    // Base-only preserved; archive-only applied.
    expect(map['subj-delta-0004']!.xpTotal).toBe(4);
    expect(map['subj-gamma-0003']!.xpTotal).toBe(3);
    // No other record was touched.
    expect(merged.records).toHaveLength(1);
    // Determinism: the same inputs produce byte-identical output, so the generation
    // checksum cannot depend on iteration order.
    const again = mergeProgressionForReplace(base, archive, ALPHA);
    expect(canonical(again.records)).toBe(canonical(merged.records));
    // ...and a record that is not the target's is left alone.
    const untouched = mergeProgressionForReplace(
      [...base, { subjectId: GAMMA, sourceVersion: 3, rank: 'Novice', xpTotal: 7, bySubject: { [GAMMA]: { xpTotal: 7 } }, crossSubjectAchievements: [] } as never],
      archive,
      ALPHA,
    );
    expect(untouched.records.filter((r) => r.subjectId === GAMMA)).toHaveLength(1);
  });

  it('the assistance store: neither side wins a collision, and a repeat import is a no-op', () => {
    // `AssistanceRecordValue` has no `subjectId`, and the repository's default id
    // factory is a seeded counter, so two devices collide *by construction*. The rule
    // is: identical is a no-op, different keeps the device's and preserves the
    // archive's under a fresh id, and no collision applies the archive's.
    let counter = 0;
    const generator = { next: () => `probe-${(counter += 1).toString().padStart(4, '0')}` };
    const deviceRecord = { assistanceId: 'assist-0001', mode: 'gentle' as const, signals: { hints: 9 }, dismissalCount: 0, updatedAt: NOW };
    // Truly the same value, and a second one that differs only in key *order*, because
    // "the same value" is decided by canonical JSON rather than by identity.
    const sameRecord = { ...deviceRecord };
    const reorderedRecord = {
      updatedAt: deviceRecord.updatedAt,
      dismissalCount: deviceRecord.dismissalCount,
      signals: deviceRecord.signals,
      mode: deviceRecord.mode,
      assistanceId: deviceRecord.assistanceId,
    };
    const differentRecord = { ...deviceRecord, mode: 'standard' as const };

    // Identical value: nothing happens, which is also what makes a repeat idempotent.
    const identical = mergeAssistanceForReplace([deviceRecord], [sameRecord], generator, new Set(['assist-0001']));
    expect(identical.identical).toBe(1);
    expect(identical.preserved).toBe(0);
    expect(identical.applied).toBe(0);
    expect(identical.records).toHaveLength(1);
    expect(identical.records[0]!.updatedAt).toBe(NOW);

    // Key order alone is not a difference: the comparison is canonical JSON, so this
    // is the same record and the no-op branch fires.
    const reordered = mergeAssistanceForReplace([deviceRecord], [reorderedRecord], generator, new Set(['assist-0001']));
    expect(reordered.identical).toBe(1);
    expect(reordered.preserved).toBe(0);
    expect(reordered.records).toHaveLength(1);

    // Different value: the device's record is kept, and the archive's is preserved
    // under a freshly minted id rather than overwriting anything.
    const conflict = mergeAssistanceForReplace([deviceRecord], [differentRecord], generator, new Set(['assist-0001']));
    expect(conflict.identical).toBe(0);
    expect(conflict.preserved).toBe(1);
    expect(conflict.applied).toBe(0);
    expect(conflict.records).toHaveLength(2);
    const kept = conflict.records.find((r) => r.assistanceId === 'assist-0001');
    expect(kept!.mode).toBe('gentle');
    const preserved = conflict.records.find((r) => r.assistanceId !== 'assist-0001');
    expect(preserved).toBeDefined();
    expect(preserved!.assistanceId).toMatch(/^kc-assistance-/);
    expect(preserved!.mode).toBe('standard');
    // Two records, two distinct keys: a store keyed on `assistanceId` cannot collapse them.
    expect(new Set(conflict.records.map((r) => r.assistanceId)).size).toBe(2);

    // No collision: applied as written, and a device record the archive never
    // mentioned is left alone.
    const applied = mergeAssistanceForReplace([deviceRecord], [{ ...deviceRecord, assistanceId: 'assist-0002' }], generator, new Set(['assist-0001']));
    expect(applied.applied).toBe(1);
    expect(applied.records.map((r) => r.assistanceId).sort()).toEqual(['assist-0001', 'assist-0002']);

    // A second run over a **product-reachable** state is a no-op. The product never
    // produces `conflict.records` for an archive it also holds - replacing with the
    // same archive twice finds identical values both times, which the case below
    // measures through the real import - so the reachable idempotence property is
    // asserted on a base whose ids are distinct, and the reachable *product* path is
    // asserted separately rather than through a hand-built state the product cannot
    // produce.
    const otherRecord = { ...deviceRecord, assistanceId: 'assist-0002', mode: 'standard' as const };
    const reachable = [deviceRecord, otherRecord];
    const sameTwice = mergeAssistanceForReplace(reachable, reachable, generator, new Set(['assist-0001', 'assist-0002']));
    expect(sameTwice.records).toHaveLength(2);
    expect(sameTwice.identical).toBe(2);
    expect(sameTwice.preserved).toBe(0);
    expect(sameTwice.applied).toBe(0);
    expect(canonical(sameTwice.records)).toBe(canonical(reachable));
    // ...and running it a third time changes nothing either.
    const thrice = mergeAssistanceForReplace(sameTwice.records, reachable, generator, new Set(['assist-0001', 'assist-0002']));
    expect(canonical(thrice.records)).toBe(canonical(reachable));
    expect(thrice.identical).toBe(2);
  });

  it('REPLACE with the same archive repeated is idempotent on the device, through the product', async () => {
    // The reachable version of the previous case, and the one a learner actually
    // performs: replace this backup, then replace it again. Neither the assistance
    // store nor the bystander may move after the first round.
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const before = await readActiveValues(device);
    const betaBefore = canonical(entriesFor(before.progression, BETA)[0]);
    const counts: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const result = await importSubjectBackup({
        repository: device.repository,
        bytes,
        now: NOW,
        mode: 'replace',
        replaceSubjectId: ALPHA,
        confirmReplace: true,
      });
      const values = await readActiveValues(device);
      counts.push(values.assistance.length);
      // Every round, the bystander is byte-identical and exactly one subject holds it.
      expect(canonical(entriesFor(values.progression, BETA)[0])).toBe(betaBefore);
      expect(entriesFor(values.progression, BETA)).toHaveLength(1);
      // Every round, the import says the same thing about the assistance store.
      expect(result.foreignState.identicalAssistanceRecords).toBe(2);
      expect(result.foreignState.preservedAssistanceRecords).toBe(0);
      expect(result.foreignState.appliedAssistanceRecords).toBe(0);
    }
    // The store did not grow at all across three rounds.
    expect(counts).toEqual([2, 2, 2]);
  });

  it('COPY MODE is where the assistance store grows, and the result does not say so', async () => {
    // The rule the merge states is about *replace*. Copy mode reaches the
    // device-global store by a different path - `[...base.assistance,
    // ...remap.assistance]` - and the consequence is recorded here rather than
    // asserted as acceptable. See the report: it is a pre-existing behaviour, newly
    // mis-reported, and it is the only place this file does not expect the product's
    // counters to describe what happened.
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const before = await readActiveValues(device);
    expect(before.assistance.length).toBe(2);

    const result = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const after = await readActiveValues(device);
    // Unbounded growth of a device-global store on the DEFAULT import mode.
    expect(after.assistance.length).toBe(4);
    // ...and the added records are byte-identical duplicates of the device's own,
    // apart from a minted id, so there is nothing to tell them apart by but the id.
    const added = after.assistance.filter(
      (record) => !before.assistance.some((own) => own.assistanceId === record.assistanceId),
    );
    expect(added.length).toBe(2);
    for (const record of added) {
      const original = before.assistance.find((own) => own.assistanceId.replace(/^assist-(alpha|beta)/, '') === '');
      void original;
      const twin = before.assistance.find((own) => canonical({ ...own, assistanceId: '' }) === canonical({ ...record, assistanceId: '' }));
      expect(twin, `added record ${record.assistanceId} is not a duplicate of a device record`).toBeDefined();
    }
    // The counters report nothing, which is the sharp part: `foreignState` is
    // documented as "all zeros in copy mode", and the assistance counters inside it
    // are zero while the store doubled.
    expect(result.foreignState.preservedAssistanceRecords).toBe(0);
    expect(result.foreignState.appliedAssistanceRecords).toBe(0);
    expect(result.foreignState.identicalAssistanceRecords).toBe(0);
    // ...and `carriedForwardStores` omits `assistance`, so a reader of that list would
    // conclude the store was untouched.
    expect(result.carriedForwardStores).not.toContain('assistance');
    expect(Object.keys(result.carriedForwardRecordCounts).sort()).toEqual([
      'customSprites',
      'preferences',
      'recovery',
      'shortcuts',
    ]);
    // Repeated imports keep growing it, without bound.
    for (let round = 0; round < 3; round += 1) {
      await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    }
    const grown = await readActiveValues(device);
    expect(grown.assistance.length).toBe(10);
  });
});

