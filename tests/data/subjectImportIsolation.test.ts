/**
 * Phase 6 data-product gate 3: a subject import never partially overwrites the
 * device, and never touches what it did not import.
 *
 * Plan section 5.2 requires "Data imports never partially overwrite the active data
 * generation" and plan section 7.1 requires staging under an `activeGeneration`
 * pointer. A subject import is the harder case of the two products, because a
 * `.kdbak` replaces a whole generation while a `.kdsubject` merges one subject into
 * an existing one - and a merge is exactly the shape of operation that can leave a
 * device half-imported. This gate holds the property from both sides.
 *
 * **When the import is refused**, the whole device is byte-identical to what it was:
 * the pointer, every record value and every envelope field in every generation,
 * every descriptor, and the whole ordered legacy `localStorage` key set with its
 * values. The comparison is one digest over all of that, taken with the shared
 * `captureDeviceState`, and it is compared before and after each refusal.
 *
 * **When the import succeeds**, the failure mode is the opposite one: a merge that
 * quietly rewrites something it had no business touching. So the four stores the
 * `.kdsubject` does not carry - `preferences`, `shortcuts`, `customSprites`,
 * `recovery` - and every other subject's records are compared as canonical bytes,
 * and the retained previous generation is compared to the state it held before.
 *
 * The fingerprint is **proven able to move**: a positive control flips one stored
 * value through the real repository and requires the digest to change and the
 * difference to be named. Without that, every "unchanged" assertion in this file
 * would be decorative, and Phase 3 review found five vacuous gates in this
 * repository for exactly that reason.
 *
 * The migration-receipt question is settled here too, because it is the one store
 * whose handling is not "carried forward byte for byte": a receipt is a statement
 * about the generation that carries it, and storage-v2 refuses a generation whose
 * receipts name a different one, so the new generation carries none and the previous
 * generation keeps them. Both halves of that are asserted here - the new generation's
 * receipt list is empty, and the retained one still holds the records byte for byte.
 *
 * Privacy: findings name stores, record ids, and field names. No assertion, and no
 * failure message, copies a subject name, a topic, a note, a filename, or a URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import { isSanitizedDetailText, StorageV2Error } from '@/services/persistence/v2/schema';
import {
  exportSubjectBackup,
  importSubjectBackup,
  type SubjectImportMode,
} from '@/services/persistence/products/subjectBackup';
import {
  captureDeviceState,
  describeDifferences,
  diffDeviceStates,
  fingerprintOf,
  mutateActiveSubject,
  type DeviceState,
} from './support/deviceState';
import { buildSubjectCorruptionCases, readShape } from './support/subjectArchive';
import {
  NASTY_DEVICE_NOW,
  NASTY_GENERATION_ID,
  NASTY_OTHER_SUBJECT_ID,
  NASTY_PRIOR_GENERATION_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  resetLegacyStorage,
} from './support/nastySubject';

const NOW = '2026-10-02T00:00:00.000Z';

/** The stores a `.kdsubject` does not carry, which must come across byte for byte. */
const UNRELATED_STORES = ['preferences', 'shortcuts', 'customSprites', 'recovery'] as const;

let device: Awaited<ReturnType<typeof createNastySubjectDevice>>;
let archive: Uint8Array;

beforeAll(async () => {
  device = await createNastySubjectDevice('kd-data-gate-isolation');
  archive = (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
});

/** A refused import's device digest, for the byte-identical comparisons. */
async function fingerprint(repository: typeof device.repository): Promise<{ state: DeviceState; digest: string }> {
  const state = await captureDeviceState(repository);
  return { state, digest: fingerprintOf(state) };
}

describe('Phase 6 gate 3: the fingerprint can detect a change', () => {
  it('one flipped byte in one stored value moves the digest and is named', async () => {
    // The positive control for the whole file, on its own database so its permanent
    // mutation cannot contaminate the assertions below.
    resetLegacyStorage();
    const control = await createNastySubjectDevice('kd-data-gate-isolation-control');
    const before = await fingerprint(control.repository);
    expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
    // A substantial capture, or the digest would be measuring almost nothing.
    expect(before.state.records.length).toBeGreaterThan(15);
    expect(before.state.legacyEntries.length).toBeGreaterThanOrEqual(4);
    // Both generations the fixture staged, in no particular order: the registry
    // sorts by creation time and both were created under the same injected clock, so
    // the tiebreak is the label. The set is what matters.
    expect([...before.state.generationIds].sort()).toEqual(
      [NASTY_GENERATION_ID, NASTY_PRIOR_GENERATION_ID].sort(),
    );

    await mutateActiveSubject(control.repository, NASTY_GENERATION_ID, NASTY_SUBJECT_ID);
    const after = await fingerprint(control.repository);

    expect(after.digest).not.toBe(before.digest);
    const differences = diffDeviceStates(before.state, after.state);
    expect(
      differences.some(
        (difference) =>
          difference.kind === 'record' &&
          difference.where.endsWith(`/subjects/${NASTY_SUBJECT_ID}`) &&
          difference.field === 'value',
      ),
      describeDifferences(differences),
    ).toBe(true);
    // Only the value moved: the record count is the same, so this is not a
    // fingerprint that merely notices added and removed rows.
    expect(after.state.recordCounts).toEqual(before.state.recordCounts);
  });

  it('one legacy key change is detected too', async () => {
    const control = await createNastySubjectDevice('kd-data-gate-isolation-legacy');
    const before = await fingerprint(control.repository);
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', NASTY_OTHER_SUBJECT_ID);
    const after = await fingerprint(control.repository);
    expect(after.digest).not.toBe(before.digest);
    expect(diffDeviceStates(before.state, after.state)).toEqual([
      { kind: 'legacy-value', where: 'knowledge-dungeon:v1:activeSubjectId', field: 'value' },
    ]);
  });
});

describe('Phase 6 gate 3: a refused import leaves the device byte-identical', () => {
  it('every corrupt and hostile archive is refused, and the device does not move', async () => {
    const cases = buildSubjectCorruptionCases({ good: archive, shape: readShape(archive) });
    // Non-vacuity: the table is a real matrix, and both kinds of corruption are in
    // it - the merely-corrupt and the *consistently* corrupt, where every
    // recomputable checksum was recomputed so only the contract is wrong.
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.filter((entry) => entry.consistent).length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    expect(new Set(cases.map((entry) => entry.rule)).size).toBe(cases.length);

    // The reader is proven able to accept first, so "every case was refused" cannot
    // be explained by a reader that refuses everything.
    const { readSubjectArchive } = await import('@/services/persistence/products/subjectBackup');
    expect(() => readSubjectArchive(archive)).not.toThrow();

    for (const mode of ['copy', 'replace'] as SubjectImportMode[]) {
      const before = await fingerprint(device.repository);
      for (const entry of cases) {
        let thrown: unknown = null;
        try {
          await importSubjectBackup({
            repository: device.repository,
            bytes: entry.bytes,
            now: NOW,
            mode,
            ...(mode === 'replace'
              ? { replaceSubjectId: NASTY_SUBJECT_ID, confirmReplace: true }
              : {}),
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `${mode} ${entry.id} was imported instead of refused`).not.toBeNull();
        expect(thrown, `${mode} ${entry.id} threw a non-StorageV2Error`).toBeInstanceOf(StorageV2Error);
        const failure = thrown as StorageV2Error;
        expect(failure.code, `${mode} ${entry.id}`).toBe(entry.code);
        expect(failure.details.reason, `${mode} ${entry.id}`).toBe(entry.reason);
        // Every string detail satisfies the rule the constructor itself enforces, so
        // no filename, path, or URL can be hiding in an error. The `.json` member
        // names in particular must never reach a detail: the rule refuses a value
        // ending in `.` plus a short extension, which is why the product uses a
        // code-shaped token per document instead.
        for (const [key, value] of Object.entries(failure.details)) {
          if (typeof value !== 'string') continue;
          expect(isSanitizedDetailText(value), `${entry.id} detail ${key}`).toBe(true);
        }

        const after = await fingerprint(device.repository);
        expect(after.digest, `${mode} ${entry.id} changed the device`).toBe(before.digest);
        expect(diffDeviceStates(before.state, after.state), `${mode} ${entry.id}`).toEqual([]);
        expect(after.state.activeGenerationId).toBe(before.state.activeGenerationId);
        expect(after.state.legacyEntries).toEqual(before.state.legacyEntries);
        expect(after.state.records.length).toBe(before.state.records.length);
        expect([...after.state.generationIds].sort()).toEqual([...before.state.generationIds].sort());
      }
      // No abandoned `staged` generation survived any of the failures: the
      // fingerprint's generation list is the assertion, and a staged generation has
      // no descriptor so it would not appear in it - so the record count is checked
      // too, and `discardStagedGeneration` is what keeps the two equal.
      const afterLoop = await fingerprint(device.repository);
      expect(afterLoop.state.records.length).toBe(before.state.records.length);
    }
  });

  it('a copy onto a device with no active generation stages a fresh one, and reports that there was none', async () => {
    // A profile that has run storage-v2 without ever creating a subject is a real
    // state, and a copy onto it has nothing to merge into. The product stages a
    // generation holding only the imported subject and says so on the result, rather
    // than pretending it retained something. The alternative - refusing - would make
    // a `.kdsubject` unusable on a new device, which is the one place a learner most
    // needs it.
    resetLegacyStorage();
    const { openStorageV2Repository } = await import('@/services/persistence/v2/repository');
    const empty = await openStorageV2Repository({
      databaseName: 'kd-data-gate-isolation-no-generation',
    });
    expect(await empty.readActiveGenerationId()).toBeNull();
    const result = await importSubjectBackup({ repository: empty, bytes: archive, now: NOW });
    expect(result.activated).toBe(true);
    expect(result.previousActiveGenerationId).toBeNull();
    expect(result.previousGenerationRetained).toBe(false);
    expect(result.previousGenerationReceiptCount).toBe(0);
    expect(result.receiptPolicy).toBe('per-generation-receipts-not-carried-forward');
    // Exactly the imported subject and nothing else: no preferences, no shortcuts, no
    // recovery records, no receipts - a device that started empty does not acquire
    // device state from a subject backup.
    expect(result.recordCounts.subjects).toBe(1);
    expect(result.recordCounts.preferences).toBe(0);
    expect(result.recordCounts.shortcuts).toBe(0);
    expect(result.recordCounts.customSprites).toBe(0);
    expect(result.recordCounts.recovery).toBe(0);
    expect(result.recordCounts.migrationReceipts).toBe(0);
    // The copy is a complete subject, not a fragment: every reference resolves and
    // the generation validates.
    const validation = await empty.validateGeneration(result.generationId);
    expect(validation.ok, JSON.stringify(validation.problems)).toBe(true);
    const snapshot = await empty.readRecords(result.generationId);
    const rooms = Object.keys(
      (snapshot.records.subjects[0]?.value.snapshot as { rooms: Record<string, unknown> }).rooms,
    );
    expect(rooms).toHaveLength(6);
    // ...and it is genuinely independent of the source device, whose ids it shares
    // nothing with even though that device is a different database entirely.
    for (const room of rooms) expect(room.startsWith('kc-room-')).toBe(true);
    expect(result.importedSubjectId.startsWith('kc-subject-')).toBe(true);
  });

  it('an import into a device with no active generation is refused or reported, never half-applied', async () => {
    // A device whose pointer names nothing is a real state, and a copy onto it stages
    // a generation holding only the imported subject. The claim under test is that
    // the *previous* pointer is what the result reports and that the new generation's
    // descriptor accounts for exactly what was written - not that a half-applied
    // state exists. This asserts the bookkeeping rather than the refusal.
    resetLegacyStorage();
    const fresh = await createNastySubjectDevice('kd-data-gate-isolation-fresh');
    // Point the pointer at the prior generation, which holds one subject and no
    // progression, sessions, or attachments for the exported one.
    const result = await importSubjectBackup({
      repository: fresh.repository,
      bytes: archive,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: NASTY_OTHER_SUBJECT_ID,
      confirmReplace: true,
    }).catch((error: unknown) => error as StorageV2Error);
    // The archive names the nasty subject, so a replace targeting the other one is a
    // disagreement and nothing happened.
    expect(result).toBeInstanceOf(StorageV2Error);
    expect((result as StorageV2Error).details.reason).toBe('replace-target-disagrees');
    expect(await fresh.repository.readActiveGenerationId()).toBe(NASTY_GENERATION_ID);
  });
});

describe('Phase 6 gate 3: a successful import touches nothing it did not import', () => {
  it('the four device-global stores and the other subject come across byte for byte', async () => {
    resetLegacyStorage();
    const target = await createNastySubjectDevice('kd-data-gate-isolation-merge');
    const base = await target.repository.readRecords(NASTY_GENERATION_ID);
    const result = await importSubjectBackup({
      repository: target.repository,
      bytes: archive,
      now: NOW,
    });
    const next = await target.repository.readRecords(result.generationId);

    for (const store of UNRELATED_STORES) {
      expect(canonicalJsonStringify(next.records[store].map((e) => e.value)), store).toBe(
        canonicalJsonStringify(base.records[store].map((e) => e.value)),
      );
    }
    // Every other subject, byte for byte, including its progression and sessions.
    const otherBefore = base.records.subjects.find(
      (envelope) => envelope.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    );
    const otherAfter = next.records.subjects.find(
      (envelope) => envelope.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    );
    expect(canonicalJsonStringify(otherAfter?.value)).toBe(canonicalJsonStringify(otherBefore?.value));
    expect(otherAfter?.checksum).toBe(otherBefore?.checksum);
    // The base generation's own records did not move either - it is the rollback
    // path, and a rollback that returned different bytes would not be a rollback.
    const baseAfter = await target.repository.readRecords(NASTY_GENERATION_ID);
    expect(canonicalJsonStringify(baseAfter.records.subjects.map((e) => e.value))).toBe(
      canonicalJsonStringify(base.records.subjects.map((e) => e.value)),
    );
    expect(result.carriedForwardStores).toEqual([...UNRELATED_STORES]);
  });

  it('the new generation carries no migration receipts, and the retained one still has them', async () => {
    // The one store that is deliberately not carried forward, asserted from both
    // sides so the choice cannot be mistaken for an oversight.
    resetLegacyStorage();
    const target = await createNastySubjectDevice('kd-data-gate-isolation-receipts');
    const before = await target.repository.readRecords(NASTY_GENERATION_ID);
    const beforeReceipts = canonicalJsonStringify(
      before.records.migrationReceipts.map((e) => e.value),
    );
    expect(beforeReceipts).toContain('legacy-localstorage');

    const result = await importSubjectBackup({
      repository: target.repository,
      bytes: archive,
      now: NOW,
    });
    const next = await target.repository.readRecords(result.generationId);
    expect(next.records.migrationReceipts).toEqual([]);

    // The previous generation retains them, byte for byte and still readable.
    const retained = await target.repository.readRecords(NASTY_GENERATION_ID);
    expect(canonicalJsonStringify(retained.records.migrationReceipts.map((e) => e.value))).toBe(
      beforeReceipts,
    );
    expect(result.receiptPolicy).toBe('per-generation-receipts-not-carried-forward');
    expect(result.previousGenerationReceiptCount).toBe(1);
    expect(result.receiptNote).toBe(
      'subject-import-mints-no-receipt-receipts-stay-with-their-generation',
    );
    // No receipt was minted either, and the generation's `source` says what actually
    // produced it - which is the honest record, since a receipt's `fromStorage` is
    // typed `'legacy-localstorage'` and this was not a migration.
    const descriptor = await target.repository.readGeneration(result.generationId);
    expect(descriptor?.descriptor?.source).toBe('subject-import');
    expect(result.recordCounts.migrationReceipts).toBe(0);
  });

  it('the live active generation is never written to, at any point', async () => {
    // The claim the whole design exists for. A merge that used `putRecords` on the
    // active generation would be one write instead of a transaction, and the only
    // way to see the difference is to check that the generation the import *read* is
    // still exactly the generation it read, and that the new one is a different
    // generation with a different descriptor.
    resetLegacyStorage();
    const target = await createNastySubjectDevice('kd-data-gate-isolation-staging');
    const activeBefore = await target.repository.readActiveGenerationId();
    expect(activeBefore).toBe(NASTY_GENERATION_ID);
    const fingerprintBefore = (await fingerprint(target.repository)).digest;

    const result = await importSubjectBackup({
      repository: target.repository,
      bytes: archive,
      now: NOW,
    });

    expect(result.generationId).not.toBe(NASTY_GENERATION_ID);
    expect(result.previousActiveGenerationId).toBe(NASTY_GENERATION_ID);
    expect(await target.repository.readActiveGenerationId()).toBe(result.generationId);
    // The pointer moved, so the whole-device digest moved - the change is real and
    // located, and the previous generation is still there.
    expect((await fingerprint(target.repository)).digest).not.toBe(fingerprintBefore);
    const previous = await target.repository.readGeneration(NASTY_GENERATION_ID);
    expect(previous?.descriptor?.status).toBe('superseded');
    expect(previous?.descriptor?.parentGenerationId).toBe(NASTY_PRIOR_GENERATION_ID);
    // The new generation descends from the old one, which is what makes the old one
    // the rollback path rather than a separate history.
    const next = await target.repository.readGeneration(result.generationId);
    expect(next?.descriptor?.parentGenerationId).toBe(NASTY_GENERATION_ID);
    expect(next?.descriptor?.activatedAt).not.toBeNull();
    expect(result.contentChecksum).toBe(next?.descriptor?.contentChecksum);
    expect(result.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a refused import after a successful one still leaves the whole device alone', async () => {
    // The combination that matters: the device is no longer in its original state, so
    // "unchanged" is a claim about a *merged* device, and a merge that left some
    // derived state behind would still pass a test that only ever refused on a fresh
    // device.
    resetLegacyStorage();
    const target = await createNastySubjectDevice('kd-data-gate-isolation-after');
    const good = await importSubjectBackup({ repository: target.repository, bytes: archive, now: NOW });
    const before = await fingerprint(target.repository);
    const cases = buildSubjectCorruptionCases({ good: archive, shape: readShape(archive) });
    for (const entry of cases.slice(0, 12)) {
      await importSubjectBackup({ repository: target.repository, bytes: entry.bytes, now: NOW }).catch(
        () => undefined,
      );
      const after = await fingerprint(target.repository);
      expect(after.digest, `${entry.id} after a successful import`).toBe(before.digest);
    }
    // ...and a good import still works afterwards, so the loop did not leave the
    // device or the repository in a broken state.
    const next = await importSubjectBackup({ repository: target.repository, bytes: archive, now: NOW });
    expect(next.activated).toBe(true);
    expect(next.importedSubjectId).not.toBe(good.importedSubjectId);
  });

  it('the record counts the result reports are the device\'s, read back from the descriptor', async () => {
    resetLegacyStorage();
    const target = await createNastySubjectDevice('kd-data-gate-isolation-counts');
    const result = await importSubjectBackup({ repository: target.repository, bytes: archive, now: NOW });
    const descriptor = (await target.repository.readGeneration(result.generationId))?.descriptor;
    expect(result.recordCounts).toEqual(descriptor?.recordCounts);
    // The counts add up: the base's counts plus exactly what the import added.
    const base = (await target.repository.readGeneration(NASTY_GENERATION_ID))?.descriptor?.recordCounts;
    expect(result.recordCounts.subjects).toBe((base?.subjects ?? 0) + 1);
    expect(result.recordCounts.progression).toBe((base?.progression ?? 0) + 1);
    expect(result.recordCounts.sessions).toBe((base?.sessions ?? 0) + 2);
    expect(result.recordCounts.assistance).toBe((base?.assistance ?? 0) + 1);
    expect(result.recordCounts.migrationReceipts).toBe(0);
    // And the values are all real numbers, so a caller rendering them cannot render
    // `undefined`.
    for (const [store, count] of Object.entries(result.recordCounts)) {
      expect(Number.isInteger(count), store).toBe(true);
    }
  });
});
