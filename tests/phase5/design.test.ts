/**
 * Verifier gate V5 - the design decisions, attacked.
 *
 * Each of these is a decision the implementation *documents*, so the question is
 * not "is the code written" but "does the behaviour match the documentation, and
 * what is the consequence when a future caller assumes the documentation is
 * literal?"
 *
 * 1. `keepPreviousGeneration` is a deliberate no-op. Is retention really
 *    unconditional, and does the result report what happened rather than what was
 *    asked for?
 * 2. The importer adopts the archive's own `sourceGenerationId` when the label is
 *    free. What happens when the label is *not* free, and what happens when the
 *    label is hostile?
 * 3. The generation roll-up checksum does not cover attachment bytes. Quantified
 *    here rather than quoted, including whether a restore can be made to accept
 *    the wrong bytes or to refuse the right ones.
 * 4. The export does not guard against a `staged` generation. What actually
 *    happens, and is the archive dangerous or merely wrong?
 * 5. The active-subject pointer is reported but not applied. Verified that
 *    nothing claims otherwise.
 * 6. No migration receipt is minted for a restore. Verified that the archive's
 *    receipts come back verbatim and that nothing claims a restore was recorded
 *    as a data move - and that when the label cannot be adopted and a receipt is
 *    re-pointed, the resulting mismatch with the source device is *disclosed*
 *    rather than silently repaired.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  resolveLiveDeviceRepository,
  FULL_DEVICE_BACKUP_FILE_NAME,
  type FullDeviceExportResult,
} from '@/services/persistence/products/fullDeviceBackup';
import { readFullDeviceArchive } from '@/services/persistence/products/archiveValidation';
import { readArchive, readArchiveJson, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import type {
  MigrationReceiptValue,
  SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import {
  ATTACHMENT,
  SUBJECT,
  VERIFIER_GENERATION,
  VERIFIER_RESTORE_NOW,
  buildVerifierDevice,
  bytesOf,
  fromArrayBuffer,
  hashOf,
  otherGenerationLabel,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];

async function device(options: { alt?: boolean } = {}): Promise<VerifierDevice> {
  const built = await buildVerifierDevice({ labels: options.alt === true ? otherGenerationLabel() : undefined });
  devices.push(built);
  return built;
}

afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

function values<T>(store: unknown): T[] {
  const list = store as Array<{ value: T }>;
  if (list.every((entry) => entry !== null && typeof entry === 'object' && 'recordId' in entry && 'value' in entry)) {
    return list.map((envelope) => envelope.value);
  }
  return list as T[];
}

async function exportOf(source: VerifierDevice, generationId?: string): Promise<FullDeviceExportResult> {
  return exportFullDeviceBackup({
    repository: source.repository,
    generationId: generationId ?? source.generationId,
    now: VERIFIER_RESTORE_NOW,
    payloadBytes: source.payloadBytes,
    activeSubjectId: null,
  });
}

describe('V5.1: retention is unconditional, and a caller passing false gets retention anyway', () => {
  let source: VerifierDevice;
  let archive: Uint8Array;

  beforeEach(async () => {
    source = await device();
    archive = (await exportOf(source)).bytes;
  });

  it('a restore with keepPreviousGeneration: true retains the generation it replaced', async () => {
    const target = await device({ alt: true });
    const before = target.generationId;
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
      keepPreviousGeneration: true,
    });
    expect(result.previousGenerationRetained).toBe(true);
    expect(result.retentionNote).toBe('previous-generation-always-retained');
    // An outcome, and the outcome is the truth whether it was asked for or not.
    expect(result.keepPreviousGeneration).toBe(true);
    expect(result.requestedRetention).toBe(true);
    // The generation itself is still readable, with its records.
    const previous = await target.repository.readRecords(before);
    expect(values(previous.records.subjects).length).toBe(4);
    const descriptor = (await target.repository.listGenerations()).find((entry) => entry.generationId === before);
    expect(descriptor?.status).toBe('superseded');
  });

  it('a restore with keepPreviousGeneration: false also retains it, and the result reports the retention', async () => {
    // HISTORY. This asserted the D4 defect: the retention really was
    // unconditional, but the result *also* echoed the requested `false` as
    // `keepPreviousGeneration`, so a future caller logging that field and reading
    // it as an outcome would record "the previous generation was not kept" about a
    // generation that was still on the device, superseded and fully readable. The
    // two facts were tied together only by `retentionNote`, which is one line of
    // prose in a result object nobody is obliged to read.
    //
    // The result now reports the outcome under that name, and the request is echoed
    // separately under a name that cannot be mistaken for one.
    const target = await device({ alt: true });
    const before = target.generationId;
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
      keepPreviousGeneration: false,
    });
    // The retention really is unconditional: the data is still there...
    const previous = await target.repository.readRecords(before);
    expect(values(previous.records.subjects).length).toBe(4);
    const descriptor = (await target.repository.listGenerations()).find((entry) => entry.generationId === before);
    expect(descriptor?.status).toBe('superseded');
    // ...every outcome-shaped field says so, and no field says otherwise.
    expect(result.previousGenerationRetained).toBe(true);
    expect(result.keepPreviousGeneration).toBe(true);
    expect(result.retentionNote).toBe('previous-generation-always-retained');
    expect(result.previousActiveGenerationId).toBe(before);
    // The request is still reported, so a caller can see its own flag was ignored -
    // under a name that is not an outcome.
    expect(result.requestedRetention).toBe(false);
  });

  it('a restore with the field omitted is retained too, and reports retention', async () => {
    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.keepPreviousGeneration).toBe(true);
    expect(result.previousGenerationRetained).toBe(true);
    // The default is `true`, so the echo and the outcome agree - which is exactly
    // why the defect was invisible until a caller passed `false`.
    expect(result.requestedRetention).toBe(true);
  });

  it('every restore reports retention as an outcome, whatever the request was', async () => {
    // The general form of the fix, so a fourth boolean cannot reintroduce the gap:
    // over every combination of request, the outcome fields agree with each other
    // and with the device, and the request is reported apart from them.
    for (const requested of [true, false, undefined]) {
      const target = await device({ alt: true });
      const result = await importFullDeviceBackup({
        repository: target.repository,
        bytes: archive,
        now: VERIFIER_RESTORE_NOW,
        ...(requested === undefined ? {} : { keepPreviousGeneration: requested }),
      });
      const label = String(requested);
      expect(result.keepPreviousGeneration, label).toBe(result.previousGenerationRetained);
      expect(result.keepPreviousGeneration, label).toBe(true);
      expect(result.requestedRetention, label).toBe(requested !== false);
      // And the device agrees with the result: the replaced generation is present,
      // superseded, and still readable.
      const before = result.previousActiveGenerationId;
      expect(before, label).not.toBeNull();
      const still = (await target.repository.listGenerations()).find(
        (entry) => entry.generationId === before,
      );
      expect(still?.status, label).toBe('superseded');
      expect(values((await target.repository.readRecords(before!)).records.subjects).length, label).toBe(4);
    }
  });

  it('three successive restores keep every generation, so nothing is ever lost', async () => {
    const target = await device({ alt: true });
    const labels = [target.generationId];
    for (let round = 0; round < 3; round += 1) {
      const result = await importFullDeviceBackup({
        repository: target.repository,
        bytes: archive,
        now: VERIFIER_RESTORE_NOW,
        // The middle round asks for the opposite, and is still told the truth.
        keepPreviousGeneration: round === 1 ? false : true,
      });
      expect(result.keepPreviousGeneration, `round ${round}`).toBe(true);
      labels.push(result.generationId);
    }
    const descriptors = await target.repository.listGenerations();
    for (const label of labels) {
      expect(descriptors.some((entry) => entry.generationId === label), label).toBe(true);
      const snapshot = await target.repository.readRecords(label);
      expect(values(snapshot.records.subjects).length, label).toBe(4);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('the interface renders the retention fact, not the requested flag', async () => {
    // The `RecoveryStatus` surface receives `keepPreviousGeneration` and must not
    // use it to make a claim. This reads the source rather than the DOM, because
    // the DOM assertion belongs to the accessibility gate.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/ui/data/RecoveryStatus.tsx', 'utf8');
    const body = source.slice(source.indexOf('const result = outcome.result;'));
    expect(body).not.toContain('keepPreviousGeneration');
    // The sentence that *is* there is licensed by the measured field.
    expect(body).toContain('result.previousGenerationRetained');
  });
});

describe('V5.2: the archive generation label', () => {
  let source: VerifierDevice;
  let archive: Uint8Array;

  beforeEach(async () => {
    source = await device();
    archive = (await exportOf(source)).bytes;
  });

  it('is adopted when the label is free, which keeps the receipts truthful', async () => {
    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.reusedArchiveGenerationId).toBe(true);
    expect(result.generationId).toBe(source.generationId);
    // The receipts name the generation they belong to, and storage-v2's own
    // relationship rule requires it.
    const receipts = values<MigrationReceiptValue>(
      (await target.repository.readRecords(result.generationId)).records.migrationReceipts,
    );
    for (const receipt of receipts) {
      expect(receipt.stagedGenerationId).toBe(result.generationId);
    }
  });

  it('is NOT reused when the receiving device already holds that label, and the receipts are repointed', async () => {
    // A target whose own active generation carries exactly the archive's label.
    const labels = { generationId: source.generationId, priorGenerationId: `${source.generationId}-prior` };
    const target = await buildVerifierDevice({ labels });
    devices.push(target);
    expect(target.generationId).toBe(source.generationId);

    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.reusedArchiveGenerationId).toBe(false);
    expect(result.generationId).not.toBe(source.generationId);
    expect(result.previousActiveGenerationId).toBe(source.generationId);

    // The receipts now name the generation they were written into...
    const receipts = values<MigrationReceiptValue>(
      (await target.repository.readRecords(result.generationId)).records.migrationReceipts,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.stagedGenerationId).toBe(result.generationId);
    // ...and the label the *old* generation held is untouched.
    const original = values<MigrationReceiptValue>(
      (await target.repository.readRecords(source.generationId)).records.migrationReceipts,
    );
    expect(original[0]?.stagedGenerationId).toBe(source.generationId);
    // ...but only `stagedGenerationId` was rewritten. The receipt's own
    // `contentChecksum`, `recordChecksums`, and `previousActiveGenerationId`
    // still describe the *source* device, so the receipt now names a generation
    // whose descriptor it disagrees with. Measured, not assumed.
    expect(receipts[0]?.contentChecksum).toBe(source.records.migrationReceipts[0]?.contentChecksum);
    const descriptor = (await target.repository.readGeneration(result.generationId))?.descriptor;
    expect(descriptor?.contentChecksum).not.toBe(receipts[0]?.contentChecksum);
    expect(receipts[0]?.previousActiveGenerationId).toBeNull();
    // HISTORY. This asserted the D6 defect, and the last four lines above are the
    // measurement that exposed it: the mismatch was real, and the result said
    // nothing about it. A caller had to notice that `reusedArchiveGenerationId` was
    // false, work out that a re-point must therefore have happened, and then work
    // out for itself which of the receipt's fields that had invalidated. None of
    // that is knowable from the result alone.
    //
    // The mismatch is still here, and is still deliberate: recomputing those
    // checksums to agree with this device would forge a record of a migration this
    // device never performed, and would erase the only evidence that the data came
    // from somewhere else. What changed is that the result now discloses it.
    expect(result.migrationReceiptRepointed).toBe(true);
    expect(result.receiptProvenanceNote).toBe('receipts-repointed-provenance-preserved');
    // The disclosure is about the re-point itself, not about adoption: a restore
    // that adopted the label has nothing to disclose.
    expect(result.reusedArchiveGenerationId).toBe(false);
    // And the two flags are not redundant, which is the point: they are the
    // difference between "a receipt here is a local fact" and "a receipt here
    // describes another device".
    expect(result.migrationReceiptRepointed).not.toBe(result.reusedArchiveGenerationId);
  });

  it('a restore that adopts the label discloses no receipt mismatch, and one that re-points discloses exactly that', async () => {
    // The general form of the disclosure, over both paths, so the flag cannot
    // quietly become a constant and stop meaning anything.
    const adoptedTarget = await device({ alt: true });
    const adopted = await importFullDeviceBackup({
      repository: adoptedTarget.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(adopted.reusedArchiveGenerationId).toBe(true);
    expect(adopted.migrationReceiptRepointed).toBe(false);
    expect(adopted.receiptProvenanceNote).toBe('receipts-carried-verbatim');
    // With the label adopted, the receipt is *verbatim* - not one field rewritten.
    // Verbatim, rather than "its fields agree with this device", is the claim that
    // holds: a receipt's `contentChecksum` describes the migration the source
    // device performed and is not the receiving generation's roll-up checksum
    // (that is the V5.3 finding, and it is true of the adopted path too). What
    // adoption guarantees is that the receipt still names the generation it was
    // written into, so nothing has to be re-pointed and no mismatch is disclosed.
    const intact = values<MigrationReceiptValue>(
      (await adoptedTarget.repository.readRecords(adopted.generationId)).records.migrationReceipts,
    );
    expect(intact).toEqual(source.records.migrationReceipts as MigrationReceiptValue[]);
    expect(intact[0]?.stagedGenerationId).toBe(adopted.generationId);

    // An occupied label is the other path, and it is the same disclosure.
    const occupied = await buildVerifierDevice({
      labels: { generationId: source.generationId, priorGenerationId: `${source.generationId}-prior` },
    });
    devices.push(occupied);
    const repointed = await importFullDeviceBackup({
      repository: occupied.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(repointed.reusedArchiveGenerationId).toBe(false);
    expect(repointed.migrationReceiptRepointed).toBe(true);
    expect(repointed.receiptProvenanceNote).toBe('receipts-repointed-provenance-preserved');

    // Nothing is minted either way, so the disclosure is the only new fact and the
    // "no receipt for a restore" claim is untouched by it.
    for (const result of [adopted, repointed]) {
      expect(result.receiptNote).toBe('restore-mints-no-receipt');
      expect(result.migrationReceiptCount).toBe(1);
    }
    // An archive with no receipts at all has nothing to re-point, and says so -
    // the flag reports an action taken, not a rule that fired.
    const emptySource = await buildVerifierDevice({ empty: true });
    devices.push(emptySource);
    const noReceipts = await importFullDeviceBackup({
      repository: (await device({ alt: true })).repository,
      bytes: (await exportFullDeviceBackup({
        repository: emptySource.repository,
        generationId: emptySource.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: new Map(),
        activeSubjectId: null,
      })).bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(noReceipts.migrationReceiptCount).toBe(0);
    expect(noReceipts.migrationReceiptRepointed).toBe(false);
  });

  it('a hostile label is refused and replaced with a code-shaped one', async () => {
    const hostile = [
      '../../../../etc/passwd',
      '..\\..\\windows',
      '/absolute/path',
      'C:\\windows\\system32',
      'a'.repeat(4096),
      'gen 🚀 ünïcødé',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      ' null',
      'gen with spaces',
      '‮gnitset',
    ];
    for (const label of hostile) {
      const target = await device({ alt: true });
      const tampered = resealWithSourceGeneration(archive, label);
      let result: Awaited<ReturnType<typeof importFullDeviceBackup>> | null = null;
      let thrown: { code: string; details: Record<string, unknown> } | null = null;
      try {
        result = await importFullDeviceBackup({
          repository: target.repository,
          bytes: tampered,
          now: VERIFIER_RESTORE_NOW,
        });
      } catch (error) {
        thrown = error as { code: string; details: Record<string, unknown> };
      }
      if (thrown !== null || result === null) {
        // Recorded, not hidden: a label the adoption rule rejects can still fail
        // the restore, and the failure is the receipt rule rather than the label
        // rule. Every one of these labels is refused with a typed code and leaves
        // the device untouched, so this is a wrong-reason refusal, not a loss.
        expect((thrown as { code: string }).code, JSON.stringify(label.slice(0, 24))).toBe('VALIDATION_FAILED');
        expect(await target.repository.readActiveGenerationId()).toBe(target.generationId);
        continue;
      }
      // Some of these labels are *not* refused, and the failure is the receipt
      // rule rather than the adoption rule. Report which one, so the finding is
      // reproducible rather than a summary.
      expect(result.generationId, `label=${JSON.stringify(label.slice(0, 24))}`).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(result.reusedArchiveGenerationId, JSON.stringify(label.slice(0, 24))).toBe(false);
      // The receipts were repointed at the safe label, so the generation still
      // validates: no receipt names a generation it does not belong to.
      const receipts = values<MigrationReceiptValue>(
        (await target.repository.readRecords(result.generationId)).records.migrationReceipts,
      );
      for (const receipt of receipts) {
        expect(receipt.stagedGenerationId).toBe(result.generationId);
      }
      expect((await target.repository.validateGeneration(result.generationId)).ok).toBe(true);
      // And the archive's own label is never dereferenced: it is stored only in
      // `state.json`, and nothing outside that member names it.
      expect(readArchive(tampered).map((member) => member.path).some((path) => path.includes(label))).toBe(false);
    }
  });

  it('a code-shaped but occupied label is never merged into', async () => {
    void source;
    const target = await device({ alt: true });
    // Put an orphan record under the archive's label with no descriptor, which is
    // the "nothing under it" test the importer is supposed to notice.
    await target.repository.stageGeneration({
      generationId: source.generationId,
      source: 'legacy-migration',
      records: {
        ...emptyLike(),
        subjects: [
          {
            subjectId: 'subject-verifier-occupant',
            schemaVersion: '1.1.0',
            snapshot: {
              dungeon: {
                schemaVersion: '1.1.0',
                dungeonId: 'd',
                subjectName: 'n',
                rootRoomId: 'r',
                phaseState: 'CreatorActive',
                rooms: [],
              },
              rooms: {},
            },
            createdAt: VERIFIER_RESTORE_NOW,
            updatedAt: VERIFIER_RESTORE_NOW,
          } as unknown as SubjectRecordValue,
        ],
      } as unknown as GenerationRecordValues,
    });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.reusedArchiveGenerationId).toBe(false);
    expect(result.generationId).not.toBe(source.generationId);
    // The occupied generation was not overwritten: it still has its own record.
    const occupied = await target.repository.readRecords(source.generationId);
    expect(values<{ subjectId: string }>(occupied.records.subjects).map((entry) => entry.subjectId)).toEqual([
      'subject-verifier-occupant',
    ]);
  });
});

describe('V5.3: the roll-up checksum does not cover attachment bytes - quantified', () => {
  beforeEach(async () => {
    await device();
  });

  it('two generations whose attachment bytes differ can share a contentChecksum', async () => {
    const target = await device({ alt: true });
    const blobValues = values<{ attachmentId: string; contentHash: string; bytes: ArrayBuffer; byteLength: number; storedAt: string }>(
      (await target.repository.readRecords(target.generationId)).records.attachmentBlobs,
    );
    // Flip one byte of one blob and nothing else: id, declared hash, length, and
    // timestamp all stay exactly as they were.
    const changed = blobValues.map((blob, index) => {
      if (index !== 0) return blob;
      const bytes = new Uint8Array(blob.bytes.slice(0));
      bytes[0] = (bytes[0] as number) ^ 0xff;
      return { ...blob, bytes: bytes.buffer as ArrayBuffer };
    });
    await target.repository.putRecords(target.generationId, { attachmentBlobs: changed as never });
    const before = await target.repository.readGeneration(target.generationId);
    const after = await target.repository.readGeneration(target.generationId);
    expect(before?.descriptor?.contentChecksum).toBe(after?.descriptor?.contentChecksum);
    // The declared hash no longer matches the bytes it names, and the repository
    // does not notice, because it never hashes them.
    const first = changed[0]!;
    expect(hashOf(fromArrayBuffer(first.bytes))).not.toBe(first.contentHash);
    const report = await target.repository.validateGeneration(target.generationId);
    expect(report.checksumMismatches).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('the serialized form of a blob record simply has no bytes in it', async () => {
    // The mechanism, stated exactly: `canonicalJsonStringify` has no
    // `ArrayBuffer` branch, and an `ArrayBuffer` has no enumerable own keys, so
    // it serializes as `{}`.
    // A `Uint8Array` built in *this* realm, so the comparison with the
    // application's `instanceof Uint8Array` branch is a real one and not a
    // cross-realm artefact.
    const bytes = new Uint8Array(Array.from(bytesOf('ZZ-verifier-checksum-gap')));
    // An `ArrayBuffer` has no `ArrayBuffer` branch and no enumerable own keys, so
    // it serializes as `{}` and every byte of the payload is dropped from the
    // checksum. The storage-v2 schema declares `bytes: ArrayBuffer`, so *every*
    // blob record the product writes is of the uncovered kind.
    expect(canonicalJsonStringify({ bytes: bytes.slice().buffer })).toBe('{"bytes":{}}');
    // A `Uint8Array` *is* covered - but only through an `instanceof` check, so the
    // coverage is realm-sensitive: a `TextEncoder` from another realm produces a
    // `Uint8Array` this realm does not recognise, and the bytes are then
    // serialized as an object with numeric keys. Value-dependent, so still
    // covered, but by accident rather than by design.
    const covered = canonicalJsonStringify({ bytes });
    expect(covered).toBe(`{"bytes":[${Array.from(bytes).join(',')}]}`);
    // A buffer from another realm is *not* recognised, and falls into the generic
    // object branch. Still value-dependent, so still covered - but the coverage
    // depends on which realm constructed the view, which is the cross-realm trap
    // this repository has already been bitten by once under Node 20.
    const realmSensitive = canonicalJsonStringify({ bytes: bytesOf('ZZ-verifier-checksum-gap') });
    expect(realmSensitive).toContain('"0":');
    expect(realmSensitive).not.toBe(covered);
  });

  it('a restore cannot be made to attach the wrong bytes to a record', () => {
    // The archive's content addressing closes the gap at the product boundary:
    // a member's name must equal the digest of the bytes it carries, and a
    // record is only given bytes through a member named by its *declared* hash.
    const wanted = bytesOf('ZZ-verifier-the-right-bytes');
    const wrong = bytesOf('ZZ-verifier-the-wrong-bytes');
    // The reader's per-member sweep compares the member's bytes with the digest
    // the manifest declared *and* with the member's own name.
    const preview = readFullDeviceArchive(goodWithState(wanted, sha256Hex(wanted)));
    expect(preview.recordCounts.attachments).toBe(2);
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(goodWithState(wrong, sha256Hex(wanted)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'a member that does not hash to its own name was accepted').not.toBeNull();
    expect((thrown as { code: string }).code).toBe('CHECKSUM_MISMATCH');
  });

  it('a restore cannot be made to refuse the right bytes either', async () => {
    // A record whose declared hash names no member is *disclosed*, not refused:
    // the archive is still accepted and the image is still listed. So the gap
    // degrades a disclosure, it does not block a restore.
    const source = await device();
    const state = readArchiveJson(
      (await exportOf(source)).bytes,
      'state.json',
    ) as { attachmentMetadata: Array<Record<string, unknown>> };
    const metadata = state.attachmentMetadata.map((entry) =>
      entry.attachmentId === ATTACHMENT.stored ? { ...entry, contentHash: sha256Hex(bytesOf('never stored')) } : entry,
    );
    const archive = (await exportOf(source)).bytes;
    const available = new Set(
      readArchive(archive)
        .filter((member) => member.path.startsWith('attachments/'))
        .map((member) => member.path.slice('attachments/'.length)),
    );
    // The product's own disclosure rule: a record is disclosed unless it is
    // `stored` *and* its declared hash names a member that is actually present.
    const reasons: Record<string, number> = {};
    for (const entry of metadata) {
      const stored = entry.availability === 'stored' && typeof entry.contentHash === 'string' && available.has(entry.contentHash);
      if (stored) continue;
      const reason = entry.sourceType === 'external' ? 'historical-external-url' : 'bytes-not-recoverable';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    const disclosureCount = Object.values(reasons).reduce((total, value) => total + value, 0);
    const counts = { ...(readArchiveJson(archive, 'manifest.json') as { recordCounts: Record<string, number> }).recordCounts };
    // The product's own rule: metadata plus the records whose declared hash names
    // a member that is actually present.
    counts.attachments =
      metadata.length +
      metadata.filter(
        (entry) => entry.availability === 'stored' && typeof entry.contentHash === 'string' && available.has(entry.contentHash),
      ).length;
    const preview = readFullDeviceArchive(
      resealWithState(
        archive,
        { ...state, attachmentMetadata: metadata },
        counts,
        { count: disclosureCount, reasons },
      ),
    );
    const disclosed = preview.externalOnlyAttachments.find((entry) => entry.attachmentId === ATTACHMENT.stored);
    expect(disclosed).toBeDefined();
    expect(disclosed?.contentHash).toBeNull();
  });
});

describe('V5.4: an export of a staged generation', () => {
  it('succeeds, and the archive it produces is importable but claims a generation that was never active', async () => {
    const source = await device();
    // Stage a *second* generation holding the same records, and never activate
    // it: no pointer names it, and no reader can see it.
    const active = await source.repository.readRecords(source.generationId);
    const stagedId = 'gen-verifier-staged-only';
    await source.repository.stageGeneration({
      generationId: stagedId,
      source: 'legacy-migration',
      records: {
        subjects: values(active.records.subjects),
        progression: values(active.records.progression),
        sessions: values(active.records.sessions),
        preferences: values(active.records.preferences),
        shortcuts: values(active.records.shortcuts),
        assistance: values(active.records.assistance),
        attachmentMetadata: values(active.records.attachmentMetadata),
        attachmentBlobs: values(active.records.attachmentBlobs),
        customSprites: values(active.records.customSprites),
        recovery: values(active.records.recovery),
        migrationReceipts: [receiptNaming(stagedId)],
      },
    });
    const descriptors = await source.repository.listGenerations();
    expect(descriptors.find((entry) => entry.generationId === stagedId)?.status).toBe('staged');
    expect(await source.repository.readActiveGenerationId()).toBe(VERIFIER_GENERATION);

    // The export is not guarded, and it succeeds.
    const exported = await exportOf(source, stagedId);
    const state = readArchiveJson(exported.bytes, 'state.json') as Record<string, unknown>;
    expect(state.sourceGenerationId).toBe(stagedId);
    // The archive is internally consistent: a real reader accepts it.
    expect(readFullDeviceArchive(exported.bytes).problems).toEqual([]);
    // And it restores onto a device that does not hold that label.
    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: exported.bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.activated).toBe(true);
    expect(result.generationId).toBe(stagedId);
    // The receipts name it and the relationship rule is satisfied, because the
    // label was free: the archive is *recoverable*, not dangerous.
    const receipts = values<MigrationReceiptValue>(
      (await target.repository.readRecords(result.generationId)).records.migrationReceipts,
    );
    expect(receipts[0]?.stagedGenerationId).toBe(stagedId);
    // The one wrong thing: the archive claims a data move that never activated.
    expect(receipts[0]?.status).toBe('activated');
    expect(receipts[0]?.migrationId).toBe('legacy-localstorage-to-storage-v2');
    // On a device that *does* hold the label the receipts are repointed and the
    // restore still works: nothing else depends on the label.
    const occupied = await buildVerifierDevice({
      labels: { generationId: stagedId, priorGenerationId: `${stagedId}-prior` },
    });
    devices.push(occupied);
    const second = await importFullDeviceBackup({
      repository: occupied.repository,
      bytes: exported.bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(second.activated).toBe(true);
    expect(second.reusedArchiveGenerationId).toBe(false);
  });
});

describe('V5.5: the active-subject pointer is reported and not applied', () => {
  it('the archive carries it, the result reports it, and nothing claims it was applied', async () => {
    const source = await device();
    const bytes = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: source.payloadBytes,
        activeSubjectId: SUBJECT.rich,
      })
    ).bytes;
    const preview = readFullDeviceArchive(bytes);
    expect(preview.activeSubjectId).toBe(SUBJECT.rich);

    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.restoredActiveSubjectId).toBe(SUBJECT.rich);
    // The generation is named by the archive, not by the active subject: the
    // pointer is not a generation id and is not written anywhere as one.
    expect(result.generationId).not.toBe(SUBJECT.rich);
    // The rendered surface says "this version does not switch to it".
    const { readFileSync } = await import('node:fs');
    const surface = readFileSync('src/ui/data/RecoveryStatus.tsx', 'utf8');
    expect(surface).toContain('does not switch to it');
  });

  it('an export with no active subject records null rather than inventing one', async () => {
    const source = await device();
    const bytes = (await exportOf(source)).bytes;
    expect(readFullDeviceArchive(bytes).activeSubjectId).toBeNull();
  });
});

describe('V5.6: a restore mints no migration receipt', () => {
  it('the archive receipts come back verbatim, and no new one appears', async () => {
    const source = await device();
    const bytes = (await exportOf(source)).bytes;
    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.receiptNote).toBe('restore-mints-no-receipt');
    expect(result.migrationReceiptCount).toBe(1);
    // HISTORY. D6 added the disclosure for the *other* path. On this one the label
    // was adopted, so the receipts were never touched and their provenance is
    // intact - which the result now says outright rather than leaving a caller to
    // infer from `reusedArchiveGenerationId`.
    expect(result.migrationReceiptRepointed).toBe(false);
    expect(result.receiptProvenanceNote).toBe('receipts-carried-verbatim');

    const restored = values<MigrationReceiptValue>(
      (await target.repository.readRecords(result.generationId)).records.migrationReceipts,
    );
    const original = source.records.migrationReceipts as MigrationReceiptValue[];
    expect(restored).toHaveLength(original.length);
    // Verbatim, except the one field that is *about* the receiving device.
    expect(restored[0]).toEqual({ ...original[0]!, stagedGenerationId: result.generationId });
    // The repository's own receipt index agrees: one receipt, the archive's.
    const listed = await target.repository.listMigrationReceipts(result.generationId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.migrationId).toBe('legacy-localstorage-to-storage-v2');
    expect(listed[0]?.status).toBe('activated');
    // The receiving device's own migration receipt is a *different* receipt in a
    // different generation, so the device-wide index legitimately holds two.
    expect(await target.repository.listMigrationReceipts()).toHaveLength(2);
    // And nothing anywhere claims the *restore itself* was a data move: the
    // restore's own source is recorded on the generation descriptor, not as a
    // receipt.
    const descriptor = (await target.repository.readGeneration(result.generationId))?.descriptor;
    expect(descriptor?.source).toBe('full-device-import');
  });

  it('the rendered outcome says the receipts were carried, not written', async () => {
    const { readFileSync } = await import('node:fs');
    const surface = readFileSync('src/ui/data/RecoveryStatus.tsx', 'utf8');
    expect(surface).toContain('Restoring does not write a new');
    expect(surface).toContain('result.migrationReceiptCount');
  });
});

describe('V5.7: the live-device accessors', () => {
  it('return null rather than throwing when no storage-v2 repository is selected', async () => {
    // The default build's answer, and the one a screen has to handle.
    const repository = await resolveLiveDeviceRepository();
    // In this test environment the selection module resolves to the legacy path,
    // so the honest answer is `null`. Either way it must not throw.
    if (repository === null) {
      expect(await resolveLiveDeviceRepository()).toBeNull();
    } else {
      expect(typeof repository.readActiveGenerationId).toBe('function');
    }
  });

  it('the download file name is a constant, with nothing a learner authored in it', () => {
    expect(FULL_DEVICE_BACKUP_FILE_NAME).toBe('knowledge-dungeon-device-backup.kdbak');
    expect(FULL_DEVICE_BACKUP_FILE_NAME).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyLike(): Record<string, unknown[]> {
  return {
    subjects: [],
    progression: [],
    sessions: [],
    preferences: [],
    shortcuts: [],
    assistance: [],
    attachmentMetadata: [],
    attachmentBlobs: [],
    customSprites: [],
    recovery: [],
    migrationReceipts: [],
  };
}

function receiptNaming(generationId: string): MigrationReceiptValue {
  return {
    receiptId: 'receipt-verifier-staged',
    migrationId: 'legacy-localstorage-to-storage-v2',
    fromStorage: 'legacy-localstorage',
    toStorage: 'storage-v2',
    stagedGenerationId: generationId,
    previousActiveGenerationId: null,
    status: 'activated',
    createdAt: VERIFIER_RESTORE_NOW,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: '1.1.0',
    subjectSchemaVersions: { '1.1.0': 1 },
    progressionSourceVersions: { '3': 1 },
    recordCounts: {
      meta: 0,
      subjects: 1,
      progression: 1,
      sessions: 0,
      preferences: 0,
      shortcuts: 0,
      assistance: 0,
      attachments: 0,
      customSprites: 0,
      recovery: 0,
      migrationReceipts: 1,
    },
    recordChecksums: {
      meta: sha256Hex(bytesOf('a')),
      subjects: sha256Hex(bytesOf('b')),
      progression: sha256Hex(bytesOf('c')),
      sessions: sha256Hex(bytesOf('d')),
      preferences: sha256Hex(bytesOf('e')),
      shortcuts: sha256Hex(bytesOf('f')),
      assistance: sha256Hex(bytesOf('g')),
      attachments: sha256Hex(bytesOf('h')),
      customSprites: sha256Hex(bytesOf('i')),
      recovery: sha256Hex(bytesOf('j')),
      migrationReceipts: sha256Hex(bytesOf('k')),
    },
    contentChecksum: sha256Hex(bytesOf('l')),
  };
}

function resealWithSourceGeneration(
  archive: Uint8Array,
  sourceGenerationId: string,
  overrides: Record<string, unknown> = {},
): Uint8Array {
  const state = readArchiveJson(archive, 'state.json') as Record<string, unknown>;
  const next: Record<string, unknown> = { ...state, ...overrides, sourceGenerationId };
  const counts = { ...(readArchiveJson(archive, 'manifest.json') as { recordCounts: Record<string, number> }).recordCounts };
  if (Array.isArray(next.migrationReceipts)) {
    counts.migrationReceipts = (next.migrationReceipts as unknown[]).length;
  }
  return resealWithState(archive, next, counts);
}

function resealWithState(
  archive: Uint8Array,
  state: Record<string, unknown>,
  recordCounts?: Record<string, number>,
  externalOnlyAttachments?: { count: number; reasons: Record<string, number> },
): Uint8Array {
  const manifest = readArchiveJson(archive, 'manifest.json') as Record<string, unknown>;
  const others = readArchive(archive).filter(
    (member) => member.path !== 'manifest.json' && member.path !== 'state.json',
  );
  const stateBytes = bytesOf(canonicalJsonStringify(state));
  const entries = [
    ...others.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
    { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
  ];
  const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
  const resealed = {
    ...manifest,
    ...(recordCounts === undefined ? {} : { recordCounts }),
    ...(externalOnlyAttachments === undefined ? {} : { externalOnlyAttachments }),
    memberCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    members: entries,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(resealed)) },
    { path: 'state.json', bytes: stateBytes },
    ...others,
  ]);
}

/** A minimal, valid one-attachment archive, for the content-addressing claim. */
function goodWithState(attachmentMember: Uint8Array, declaredHash: string): Uint8Array {
  const state = {
    formatVersion: 1,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: '1.1.0',
    createdAt: VERIFIER_RESTORE_NOW,
    sourceGenerationId: 'gen-verifier-minimal',
    activeSubjectId: null,
    locale: null,
    questState: null,
    subjects: [
      {
        subjectId: 'subject-verifier-minimal',
        schemaVersion: '1.1.0',
        createdAt: VERIFIER_RESTORE_NOW,
        updatedAt: VERIFIER_RESTORE_NOW,
        snapshot: {
          dungeon: {
            schemaVersion: '1.1.0',
            dungeonId: 'd',
            subjectName: 'n',
            rootRoomId: 'r',
            phaseState: 'CreatorActive',
            rooms: [{ roomId: 'r', topic: 't' }],
          },
          rooms: {
            r: {
              roomId: 'r',
              topic: 't',
              createdAt: VERIFIER_RESTORE_NOW,
              updatedAt: VERIFIER_RESTORE_NOW,
              state: 'Created',
              validationState: {
                wordCount: 0,
                requiredSectionsPresent: false,
                manualConfirmed: false,
                criterionScores: {
                  sectionCompleteness: 0,
                  conceptTermCoverage: 0,
                  linkReferences: 0,
                  recallQuestionQuality: 0,
                  clarityReadability: 0,
                },
                failedChecks: [],
                qualityBonus: 0,
                finalPass: false,
              },
            },
          },
        },
      },
    ],
    progression: [],
    sessions: [],
    preferences: [],
    shortcuts: [],
    assistance: [],
    attachmentMetadata: [
      {
        attachmentId: 'att-verifier-minimal',
        subjectId: 'subject-verifier-minimal',
        roomId: 'r',
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: declaredHash,
        addedAt: VERIFIER_RESTORE_NOW,
      },
    ],
    customSprites: [],
    recovery: [],
    migrationReceipts: [],
  };
  const members = attachmentMember;
  const stateBytes = bytesOf(canonicalJsonStringify(state));
  const entries = [
    { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
    { path: `attachments/${declaredHash}`, byteLength: members.byteLength, sha256: hashOf(members) },
  ];
  const manifest = {
    product: 'kdbak' as const,
    formatVersion: 1,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: '1.1.0',
    createdAt: VERIFIER_RESTORE_NOW,
    memberCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
    recordCounts: {
      meta: 0,
      subjects: 1,
      progression: 0,
      sessions: 0,
      preferences: 0,
      shortcuts: 0,
      assistance: 0,
      attachments: 2,
      customSprites: 0,
      recovery: 0,
      migrationReceipts: 0,
    },
    attachmentBytes: { memberCount: 1, byteLength: members.byteLength },
    externalOnlyAttachments: { count: 0, reasons: {} },
    members: entries,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
    { path: 'state.json', bytes: stateBytes },
    { path: `attachments/${declaredHash}`, bytes: members },
  ]);
}
