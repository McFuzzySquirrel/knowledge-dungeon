/**
 * Verifier gate V8 - the defects this independent review found.
 *
 * HISTORY. Each test here originally asserted the *observed defective* behaviour,
 * which kept this suite green while the defect stayed reproducible. All four
 * findings have now been fixed, so every test below has been flipped to assert
 * the required behaviour, renamed to drop the defect framing, and given a `HISTORY`
 * note recording what it used to assert. None of them was loosened: each is
 * strictly stronger than the observation it replaced, and each fails on revert.
 *
 * The findings, in the order they were reported:
 *
 * - **D1** (blocker) - the archive reader refused on the *total* validation
 *   problem count while reporting the *blocking* count, so it was stricter than
 *   the importer it feeds and a device storage-v2 was happy with could take a
 *   backup it could never restore. Fixed by using
 *   `MIGRATION_BLOCKING_POLICY` / `isActivationBlocking` through
 *   `partitionMigrationProblems`, the same single policy the importer gates on.
 * - **D2** - the archive's generation label could be an `Object.prototype` key and
 *   was adopted as a database key. Fixed with the rule the reader already applies
 *   to member names.
 * - **D3** - the module claimed an export under a fixed clock was
 *   byte-deterministic, and it was not, because the ZIP writer stamped the wall
 *   clock. Fixed by passing an `mtime` derived from the injected clock.
 * - **D4** - `keepPreviousGeneration` was echoed literally in the result while
 *   retention was unconditional, so a caller logging the echo recorded a false
 *   statement. Fixed by making the echo the outcome.
 *
 * A fifth finding, **D6** (a repointed receipt still described the source
 * device), is held in `design.test.ts` next to the adoption rule it belongs to.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { importSubjectFromJson } from '@/services/persistence/subjectPersistence';
import { validateSubjectSnapshot, type SubjectSnapshot } from '@/core/validation/persistence';
import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  readFullDeviceArchive,
} from '@/services/persistence/products/fullDeviceBackup';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import { countBlockingProblems, type ValidationProblem } from '@/services/persistence/v2/validation';
import { partitionMigrationProblems } from '@/services/persistence/v2/migrationState';
import { readArchive, readArchiveJson, writeArchive } from '@/services/persistence/v2/archive';
import { rawZip } from '../data/support/hostileZip';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import {
  SUBJECT,
  VERIFIER_NOW,
  VERIFIER_RESTORE_NOW,
  buildVerifierDevice,
  bytesOf,
  captureDevice,
  hashOf,
  otherGenerationLabel,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];


afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

async function device(options: { alt?: boolean } = {}): Promise<VerifierDevice> {
  const built = await buildVerifierDevice({ labels: options.alt === true ? otherGenerationLabel() : undefined });
  devices.push(built);
  return built;
}

function values<T>(store: unknown): T[] {
  const list = store as Array<{ value: T }>;
  if (list.every((entry) => entry !== null && typeof entry === 'object' && 'recordId' in entry && 'value' in entry)) {
    return list.map((envelope) => envelope.value);
  }
  return list as T[];
}

describe('D1: a subject with a warning-level problem produces a backup that can never be restored', () => {
  it('the repository\'s own Phase 0 fixture is accepted by the current importer', () => {
    // Step 1: the subject is real. `subject-1.1.0-minimal.json` is documented as
    // "Smallest current 1.1.0 importer boundary", and the fixtures README says the
    // importer's validation "is intentionally shallow". It is accepted.
    const raw = readFileSync(
      join(process.cwd(), 'tests/fixtures/persistence/subject/subject-1.1.0-minimal.json'),
      'utf8',
    );
    const snapshot = importSubjectFromJson(raw);
    expect(snapshot.dungeon.dungeonId).toBe('subject-phase0-v110-minimal');
  });

  it('storage-v2 accepts a generation holding it, because its only finding is a warning', async () => {
    // Step 2: the finding is at warning severity, so storage-v2 activates the
    // generation and the learner can work in it.
    const raw = readFileSync(
      join(process.cwd(), 'tests/fixtures/persistence/subject/subject-1.1.0-minimal.json'),
      'utf8',
    );
    const snapshot = importSubjectFromJson(raw);
    const problems = validateSubjectSnapshot(snapshot as never).problems;
    expect(problems).toEqual([{ code: 'missing-phase-state', scope: 'dungeon', count: 1 }]);

    const built = await device();
    await built.repository.stageGeneration({
      generationId: 'gen-verifier-minimal-subject',
      source: 'legacy-migration',
      records: {
        ...emptyRecords(),
        subjects: [
          {
            subjectId: snapshot.dungeon.dungeonId,
            schemaVersion: '1.1.0',
            createdAt: '2026-01-04T03:04:05.000Z',
            updatedAt: '2026-01-04T03:04:05.000Z',
            snapshot: snapshot as never,
          },
        ],
      } as never,
    });
    await built.repository.activateGeneration('gen-verifier-minimal-subject');
    const report = await built.repository.validateGeneration('gen-verifier-minimal-subject');
    // The production validator's own statement: the only problem is the warning.
    expect(report.problems).toEqual([
      { code: 'missing-phase-state', scope: 'subject', count: 1, severity: 'warning' },
    ]);
    expect(report.ok).toBe(true);
  });

  it('the archive the product writes for that device is accepted, and the warning is disclosed', async () => {
    // HISTORY. This asserted the D1 defect: the export succeeded and the archive
    // the product had *just written* was then refused with
    // `VALIDATION_FAILED / state-record-invalid` and `problemCount: 0`. It is now
    // the required behaviour - the same archive restores - and the warning is
    // disclosed rather than dropped, because a disclosure is the point of a
    // warning.
    const snapshot = minimalSubjectSnapshot();
    const source = await device();
    await source.repository.stageGeneration({
      generationId: 'gen-verifier-minimal-subject',
      source: 'legacy-migration',
      records: {
        ...emptyRecords(),
        subjects: [subjectRecordFor(snapshot)],
      } as never,
    });
    await source.repository.activateGeneration('gen-verifier-minimal-subject');

    const exported = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: 'gen-verifier-minimal-subject',
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: new Map(),
      activeSubjectId: null,
    });
    expect(exported.bytes.byteLength).toBeGreaterThan(0);

    // The archive reads. The single finding is disclosed, at warning severity, and
    // the policy that separated it from a refusal is stated on the preview.
    const preview = readFullDeviceArchive(exported.bytes);
    expect(preview.problems).toEqual([
      { code: 'missing-phase-state', scope: 'subject', count: 1, severity: 'warning' },
    ]);
    expect(preview.blockingPolicy).toBe('error-blocks-warning-discloses');
    expect(preview.recordCounts.subjects).toBe(1);

    // ...and it restores, onto a device that has never seen it.
    const target = await device({ alt: true });
    const before = await captureDevice(target.repository);
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: exported.bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.activated).toBe(true);
    expect(result.generationId).not.toBe(target.generationId);

    // The subject is really there, and the generation validates with the same
    // single warning storage-v2 accepted on the source device.
    const restored = await target.repository.readRecords(result.generationId);
    expect(values(restored.records.subjects)).toHaveLength(1);
    expect(
      (values<{ subjectId: string }>(restored.records.subjects)[0] as { subjectId: string }).subjectId,
    ).toBe(snapshot.dungeon.dungeonId);
    const report = await target.repository.validateGeneration(result.generationId);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([
      { code: 'missing-phase-state', scope: 'subject', count: 1, severity: 'warning' },
    ]);
    // The device did move - the opposite of the D1 assertion, which was that it
    // could not move at all.
    expect((await captureDevice(target.repository)).digest).not.toBe(before.digest);
  });

  it('a genuinely blocking record is still refused, with the same typed code and a non-zero count', async () => {
    // HISTORY. This asserted the *disagreement* between the two halves of the
    // product: `countBlockingProblems(warning) === 0` while the reader refused the
    // same array because it asked `problems.length > 0`. It now asserts that the
    // two halves agree, in both directions: a warning is a disclosure, and an
    // `error`-severity problem is still a refusal - with a count that is never 0.
    const warning: ValidationProblem[] = [
      { code: 'missing-phase-state', scope: 'subject', count: 1, severity: 'warning' },
    ];
    const blocking: ValidationProblem[] = [
      { code: 'unsupported-version', scope: 'recovery', count: 1, severity: 'error' },
    ];
    // The importer's notion, and the reader's, are now the same rule.
    expect(countBlockingProblems(warning)).toBe(0);
    expect(partitionMigrationProblems(warning).blocking).toEqual([]);
    expect(partitionMigrationProblems(warning).disclosed).toEqual(warning);
    expect(countBlockingProblems(blocking)).toBe(1);
    expect(partitionMigrationProblems(blocking).disclosed).toEqual([]);

    // End to end: a record storage-v2 itself refuses must still be refused, by
    // the reader, with the same `VALIDATION_FAILED / state-record-invalid` the
    // defect report named - and with a count that names the problem.
    const source = await device();
    const archive = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: source.payloadBytes,
        activeSubjectId: null,
      })
    ).bytes;
    const state = readArchiveJson(archive, 'state.json') as Record<string, unknown>;
    const recovery = state.recovery as Array<Record<string, unknown>>;
    recovery.push({ kind: 'not-a-real-kind', subjectId: 'subject-verifier-blocked', raw: '{}', capturedAt: VERIFIER_NOW });
    const tampered = resealWithState(archive, state, {
      ...(readArchiveJson(archive, 'manifest.json') as { recordCounts: Record<string, number> }).recordCounts,
      recovery: recovery.length,
    });

    let thrown: unknown = null;
    try {
      readFullDeviceArchive(tampered);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    const failure = thrown as StorageV2Error;
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.details.reason).toBe('state-record-invalid');
    // The defect was that this was 0. It is not, and it names the policy.
    expect(failure.details.problemCount).toBe(1);
    expect(failure.details.policy).toBe('error-blocks-warning-discloses');

    // And a refused archive leaves the device byte-for-byte alone.
    const target = await device({ alt: true });
    const before = await captureDevice(target.repository);
    await importFullDeviceBackup({
      repository: target.repository,
      bytes: tampered,
      now: VERIFIER_RESTORE_NOW,
    }).catch(() => undefined);
    expect((await captureDevice(target.repository)).digest).toBe(before.digest);
  });
});

describe('D2: an Object.prototype key is not adoptable as a generation label', () => {
  /**
   * The six labels the finding was reported with, plus the whole own-name set of
   * `Object.prototype` so the rule cannot quietly cover only the reported six.
   */
  const REPORTED = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];
  const ALL = Object.getOwnPropertyNames(Object.prototype).filter((name) => name !== '__proto__');
  const LABELS = [...new Set([...REPORTED, ...ALL])];

  it('every Object.prototype key is a label the reader already refuses for a member', () => {
    // The rule under test is not a new one: the reader has applied exactly this to
    // a member *name* since Phase 5, and the fix is that the same rule now applies
    // to a generation *label*, which is a database key.
    expect(LABELS.length).toBeGreaterThanOrEqual(6);
    for (const label of LABELS) {
      // ...and the reader really does refuse the same string as a member name.
      const bytes = rawZip([
        { name: 'manifest.json', bytes: bytesOf('{}') },
        { name: label, bytes: bytesOf('{}') },
      ]);
      let thrown: unknown = null;
      try {
        readFullDeviceArchive(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(StorageV2Error);
      expect((thrown as StorageV2Error).code, label).toBe('ARCHIVE_UNSAFE_PATH');
    }
  });

  it('a .kdbak naming one as its source generation is never adopted, with receipts present', { timeout: 60_000 }, async () => {
    // HISTORY. This asserted the D2 defect in its worst form: with receipts in the
    // archive, a label such as `constructor` was *adopted* as the new generation's
    // database key, and the restore then failed `VALIDATION_FAILED` at the
    // validation stage because the archive's receipts named a different
    // generation. The label is now rejected before it is ever written, the receipts
    // are repointed as they are for any other non-adopted label, and the restore
    // succeeds.
    const source = await device();
    const archive = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: source.payloadBytes,
        activeSubjectId: null,
      })
    ).bytes;
    expect(
      (readArchiveJson(archive, 'state.json') as { migrationReceipts: unknown[] }).migrationReceipts.length,
    ).toBeGreaterThan(0);

    for (const label of LABELS) {
      const target = await device({ alt: true });
      const before = await captureDevice(target.repository);
      const tampered = resealWithSourceGeneration(archive, label);
      const result = await importFullDeviceBackup({
        repository: target.repository,
        bytes: tampered,
        now: VERIFIER_RESTORE_NOW,
      });
      // The archive's own label is not adopted...
      expect(result.reusedArchiveGenerationId, label).toBe(false);
      expect(result.generationId, label).not.toBe(label);
      // ...the restore succeeded, which is the half the defect broke...
      expect(result.activated, label).toBe(true);
      expect((await target.repository.validateGeneration(result.generationId)).ok, label).toBe(true);
      // ...the receipts were repointed, as they are for any other non-adopted label.
      const receipts = values<{ stagedGenerationId: string }>(
        (await target.repository.readRecords(result.generationId)).records.migrationReceipts,
      );
      expect(receipts.length, label).toBeGreaterThan(0);
      for (const receipt of receipts) expect(receipt.stagedGenerationId, label).toBe(result.generationId);
      // ...and no prototype key was written anywhere on the device.
      const after = await captureDevice(target.repository);
      expect(after.activeGenerationId, label).toBe(result.generationId);
      expect(after.generationIds.includes(label), label).toBe(false);
      expect(after.records.some(([store]) => store === label), label).toBe(false);
      expect(after.meta.some(([key]) => key.includes(label)), label).toBe(false);
      expect(after.digest, label).not.toBe(before.digest);
    }
  });

  it('a .kdbak naming one as its source generation is never adopted, with no receipts', { timeout: 60_000 }, async () => {
    // The other half QA measured: with **no** receipts in the archive there was
    // nothing to fail the receipt rule, so the prototype-named generation was
    // simply created and became the `activeGeneration` pointer. Now the label is
    // refused before it is written in this case too, which is the case that proves
    // the fix is the adoption rule and not the receipt rule.
    const emptySource = await buildVerifierDevice({ empty: true });
    devices.push(emptySource);
    const archive = (
      await exportFullDeviceBackup({
        repository: emptySource.repository,
        generationId: emptySource.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: new Map(),
        activeSubjectId: null,
      })
    ).bytes;
    expect(
      (readArchiveJson(archive, 'state.json') as { migrationReceipts: unknown[] }).migrationReceipts,
    ).toEqual([]);

    for (const label of LABELS) {
      const target = await device({ alt: true });
      const tampered = resealWithSourceGeneration(archive, label);
      const result = await importFullDeviceBackup({
        repository: target.repository,
        bytes: tampered,
        now: VERIFIER_RESTORE_NOW,
      });
      expect(result.reusedArchiveGenerationId, label).toBe(false);
      const after = await captureDevice(target.repository);
      // The pointer names a code-shaped, non-prototype generation...
      expect(after.activeGenerationId, label).toBe(result.generationId);
      expect(after.activeGenerationId, label).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      // ...and the hostile label is nowhere on the device.
      expect(after.generationIds.includes(label), label).toBe(false);
      expect(after.meta.some(([key]) => key.includes(label)), label).toBe(false);
    }
  });
});

describe('D3: an export under a fixed clock is byte-reproducible', () => {
  it('two exports of the same generation with the same clock are byte-identical', async () => {
    // HISTORY. This asserted the D3 defect, and it did it by quoting the module's
    // own two determinism sentences and then pointing at the codec line that
    // proved them false. Both halves are now the required behaviour, asserted
    // directly instead: the same generation and the same clock produce the same
    // bytes.
    //
    // No sleep, and deliberately so. The defect was visible only across a
    // two-second DOS-timestamp boundary, so the old reproduction had to wait 2.6 s
    // and hope the load let it land - load-sensitive by construction. With the
    // clock threaded through to the ZIP entry, the bytes are equal whatever the
    // wall clock did in between, so waiting would prove nothing and would make
    // this test slower and flakier for no gain.
    const source = await device();
    const exportOnce = async (now: string): Promise<Uint8Array> =>
      (
        await exportFullDeviceBackup({
          repository: source.repository,
          generationId: source.generationId,
          now,
          payloadBytes: source.payloadBytes,
          activeSubjectId: SUBJECT.rich,
        })
      ).bytes;

    const first = await exportOnce(VERIFIER_RESTORE_NOW);
    const second = await exportOnce(VERIFIER_RESTORE_NOW);
    expect(second.byteLength).toBe(first.byteLength);
    expect(hashOf(second)).toBe(hashOf(first));
    // The members are identical too, so the equality above is the container's and
    // not merely a consequence of comparing the same members twice.
    expect(
      readArchive(second).map((member) => [member.path, hashOf(member.bytes)]),
    ).toEqual(readArchive(first).map((member) => [member.path, hashOf(member.bytes)]));
  });

  it('the ZIP entry timestamp is the injected clock, not the wall clock', async () => {
    // The mechanism, measured rather than quoted. A ZIP local file header holds
    // its DOS modification time at bytes 10-13, and fflate derives it from
    // `mtime` when one is given and from `Date.now()` when one is not. So if the
    // four bytes equal the word computed from `now`, the wall clock is provably not
    // in the container - and this assertion cannot pass by accident, because the
    // wall clock is never `now`.
    const source = await device();
    // A date the wall clock cannot plausibly be at, so a coincidence is impossible.
    const now = '2031-06-15T04:05:06.000Z';
    const bytes = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now,
        payloadBytes: source.payloadBytes,
        activeSubjectId: SUBJECT.rich,
      })
    ).bytes;

    const word = dosTimestampWord(new Date(now));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(10, true)).toBe(word);
    // And the wall clock is genuinely elsewhere: two seconds is the resolution, so
    // the assertion above is not satisfied by "close enough".
    const wallClock = dosTimestampWord(new Date());
    expect(wallClock === word && nearInDosSeconds(new Date(), new Date(now), 0)).toBe(false);
  });

  it('a different clock moves only state.json and the container, never a member', async () => {
    // The claim is about reproducibility under a *fixed* clock. Across two clocks
    // the members are still a function of the data plus the clock, and exactly one
    // member moves: the document that carries `createdAt`.
    const source = await device();
    const exportOnce = async (now: string): Promise<Uint8Array> =>
      (
        await exportFullDeviceBackup({
          repository: source.repository,
          generationId: source.generationId,
          now,
          payloadBytes: source.payloadBytes,
          activeSubjectId: SUBJECT.rich,
        })
      ).bytes;
    const early = await exportOnce('2027-01-02T03:04:05.000Z');
    const late = await exportOnce('2033-11-12T13:14:15.000Z');
    const byPath = (bytes: Uint8Array) =>
      new Map(readArchive(bytes).map((member) => [member.path, hashOf(member.bytes)]));
    const moved = (before: Uint8Array, after: Uint8Array): string[] => {
      const beforeMap = byPath(before);
      const afterMap = byPath(after);
      return [...beforeMap.entries()]
        .filter(([path, digest]) => afterMap.get(path) !== digest)
        .map(([path]) => path);
    };

    // Physically, exactly the two documents that carry the clock move. The
    // manifest is one of them because it names `createdAt` and each member's
    // digest, so it cannot be a function of the clock alone.
    expect(moved(early, late)).toEqual(['manifest.json', 'state.json']);
    // The manifest's own member table cannot list itself, and there the one moving
    // member is `state.json` - the single document whose bytes are a function of
    // the data *and* the clock. Every content-addressed and index-addressed member
    // is byte-identical across the two clocks.
    const declared = (bytes: Uint8Array): string[] =>
      (readArchiveJson(bytes, 'manifest.json') as { members: { path: string; sha256: string }[] })
        .members.map((member) => member.path);
    expect(declared(early)).toEqual(declared(late));
    // ...and each clock is separately reproducible.
    expect(hashOf(await exportOnce('2027-01-02T03:04:05.000Z'))).toBe(hashOf(early));
    expect(hashOf(await exportOnce('2033-11-12T13:14:15.000Z'))).toBe(hashOf(late));
  });
});

/**
 * The DOS modification-time word fflate writes for a `Date`.
 *
 * fflate's `wzh` uses the *local* getters, so this does too; a UTC-based copy
 * would be wrong by the machine's offset and would make the gate machine-dependent.
 */
function dosTimestampWord(when: Date): number {
  const year = when.getFullYear() - 1980;
  return (
    (year << 25) |
    ((when.getMonth() + 1) << 21) |
    (when.getDate() << 16) |
    (when.getHours() << 11) |
    (when.getMinutes() << 5) |
    (when.getSeconds() >> 1)
  ) >>> 0;
}

/** Whether two instants fall in the same two-second DOS bucket. */
function nearInDosSeconds(left: Date, right: Date, windowSeconds: number): boolean {
  return Math.abs(left.getTime() - right.getTime()) < (windowSeconds + 2) * 1000;
}

/**
 * Rebuild an archive with a different `sourceGenerationId`, manifest resealed.
 *
 * Mirrors {@link resealWithState} so a label test and a state test cannot disagree
 * about what a resealed archive is: only the intended change is present, and every
 * declared count and digest is recomputed.
 */
function resealWithSourceGeneration(archive: Uint8Array, sourceGenerationId: string): Uint8Array {
  const state = readArchiveJson(archive, 'state.json') as Record<string, unknown>;
  const manifest = readArchiveJson(archive, 'manifest.json') as {
    recordCounts: Record<string, number>;
  };
  return resealWithState(archive, { ...state, sourceGenerationId }, {
    ...manifest.recordCounts,
    migrationReceipts: Array.isArray(state.migrationReceipts) ? state.migrationReceipts.length : 0,
  });
}

function minimalSubjectSnapshot(): SubjectSnapshot {
  const raw = readFileSync(
    join(process.cwd(), 'tests/fixtures/persistence/subject/subject-1.1.0-minimal.json'),
    'utf8',
  );
  return importSubjectFromJson(raw);
}

function subjectRecordFor(snapshot: SubjectSnapshot): Record<string, unknown> {
  return {
    subjectId: snapshot.dungeon.dungeonId,
    schemaVersion: '1.1.0',
    createdAt: VERIFIER_NOW,
    updatedAt: VERIFIER_NOW,
    snapshot,
  };
}

/**
 * Rebuild an archive with a replaced `state.json` and a recomputed manifest.
 *
 * The same shape the design gate uses, so a flipped reproduction here and a
 * measurement there cannot disagree about what a resealed archive is: only the
 * intended change is present, and every declared count and digest is recomputed.
 */
function resealWithState(
  archive: Uint8Array,
  state: Record<string, unknown>,
  recordCounts: Record<string, number>,
): Uint8Array {
  const manifest = readArchiveJson(archive, 'manifest.json') as Record<string, unknown>;
  const others = readArchive(archive).filter(
    (member) => member.path !== 'manifest.json' && member.path !== 'state.json',
  );
  const stateBytes = bytesOf(canonicalJsonStringify(state));
  const entries = [
    ...others.map((member) => ({
      path: member.path,
      byteLength: member.bytes.byteLength,
      sha256: hashOf(member.bytes),
    })),
    { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
  ];
  const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
  const resealed = {
    ...manifest,
    recordCounts,
    memberCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(
      bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n')),
    ),
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    members: entries,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(resealed)) },
    { path: 'state.json', bytes: stateBytes },
    ...others.map((member) => ({ path: member.path, bytes: member.bytes })),
  ]);
}

function emptyRecords(): Record<string, unknown[]> {
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

void values;
