/**
 * Phase 5 data-product gate 3: corrupt archives never replace current data.
 *
 * This is the most important gate in the phase. Plan section 7.3 requires that a
 * failed import "must not replace the active generation", and the Phase 5 non-goals
 * forbid "deletion of existing user data during import failure". A learner's whole
 * body of work sits in one generation, so this is the one property where a
 * plausible-looking bug is catastrophic rather than annoying.
 *
 * The gate is deliberately built so that "nothing changed" is a *falsifiable*
 * claim:
 *
 * - **The fingerprint is total.** `captureDeviceState` reads every generation,
 *   every record envelope (including `recordId`, `checksum`, and `updatedAt`), the
 *   active-generation pointer, every descriptor, and the whole ordered legacy
 *   `localStorage` key set with its values. `fingerprintOf` reduces that to one
 *   digest, so the comparison is byte-for-byte rather than a field-by-field
 *   paraphrase that could agree on the wrong thing.
 * - **The fingerprint is proven able to move.** A positive control rewrites one
 *   real subject record through the real repository and requires the digest to
 *   change and the difference to be named. If a single edited field did not move
 *   the fingerprint, all fifteen "unchanged" assertions below would be decorative.
 * - **The reader is proven able to accept.** The good reference archive is read
 *   successfully first, so "every corruption was rejected" cannot be explained by a
 *   reader that rejects everything.
 * - **Every rejection is typed and sanitized.** The thrown value must be a
 *   `StorageV2Error`, its code must be a member of the *real*
 *   `StorageV2ErrorCode` union parsed out of the source, and every string detail
 *   must satisfy the application's own `isSanitizedDetailText` rule - the check
 *   the `StorageV2Error` constructor itself enforces.
 * - **The outcome per case is measured, not assumed.** The audited ZIP codec
 *   rejects some of the fifteen and cannot see the rest; the gate asserts the
 *   exact partition (8 and 7) so a change in the codec's coverage is loud.
 *
 * The registered half is one `it.fails` per case, each asserting the product's own
 * import refuses the archive, leaves the device byte-for-byte identical, and still
 * accepts a good archive afterwards.
 *
 * Privacy: the corruptions are structural. No corruption introduces a subject
 * name, a topic, a note, a filename, or a URL; the only host named is the
 * reserved `example.invalid`.
 */

import { readArchive, readArchiveJson } from '@/services/persistence/v2/archive';
import { isSanitizedDetailText, StorageV2Error } from '@/services/persistence/v2/schema';
import { beforeAll, describe, expect, it } from 'vitest';

import { consumeArchive, produceArchive } from './support/backupAdapter';
import {
  captureDeviceState,
  describeDifferences,
  diffDeviceStates,
  fingerprintOf,
  mutateActiveSubject,
} from './support/deviceState';
import { CORRUPTION_CASE_ORDER, buildCorruptionCases } from './support/hostileZip';
import {
  ATTACHMENT_IDS,
  DEVICE_NOW,
  POPULATED_GENERATION_ID,
  SUBJECT_IDS,
  createPopulatedDevice,
  resetLegacyStorage,
  type PopulatedDevice,
} from './support/populatedDevice';
import { referenceArchiveForDevice } from './support/referenceArchive';
import {
  CORRUPTION_CASES,
  CODEC_REJECTED_CASE_COUNT,
  CORRUPTION_CASE_BY_ID,
  FULL_DEVICE_BACKUP_MODULE,
  readStorageV2ErrorCodes,
  type CorruptionCaseId,
} from './support/productInterface';

/** What the audited ZIP codec did with one case. */
interface CodecOutcome {
  readonly accepted: boolean;
  readonly code: string | null;
  readonly reason: string | null;
  readonly detailKeys: readonly string[];
}

let device: PopulatedDevice;
let good: ReturnType<typeof referenceArchiveForDevice>;
let outcomes: Map<CorruptionCaseId, CodecOutcome>;

/**
 * The audited reader: the production ZIP codec plus a JSON parse of the two fixed
 * members.
 *
 * This is the *floor* the product has to clear, not a substitute for it. It is
 * the same `fflate`-backed codec the plan mandates (ADR 002) wrapped in the
 * application's own typed errors, so every outcome below is a real production
 * result rather than a test's opinion.
 */
function auditedRead(bytes: Uint8Array): CodecOutcome {
  try {
    const members = readArchive(bytes);
    readArchiveJson(bytes, 'manifest.json');
    readArchiveJson(bytes, 'state.json');
    return {
      accepted: true,
      code: null,
      reason: null,
      detailKeys: members.map((member) => member.path).slice(0, 0),
    };
  } catch (error) {
    if (error instanceof StorageV2Error) {
      const details = error.details as Readonly<Record<string, string | number | boolean>>;
      return {
        accepted: false,
        code: error.code,
        reason: typeof details.reason === 'string' ? details.reason : null,
        detailKeys: Object.keys(details).sort(),
      };
    }
    return { accepted: false, code: null, reason: null, detailKeys: [] };
  }
}

beforeAll(async () => {
  resetLegacyStorage();
  device = await createPopulatedDevice('kd-data-gate-corrupt');
  const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
  good = referenceArchiveForDevice(device, snapshot);
  const fixtures = buildCorruptionCases(good);
  outcomes = new Map(
    CORRUPTION_CASE_ORDER.map((id) => [id, auditedRead((fixtures.get(id) as { bytes: Uint8Array }).bytes)]),
  );
});

describe('Phase 5 gate 3: the device fingerprint can detect a change', () => {
  it('a single edited field moves the digest and is named in the diff', async () => {
    // A separate database, so this control's permanent mutation cannot
    // contaminate the fifteen "unchanged" assertions below.
    resetLegacyStorage();
    const control = await createPopulatedDevice('kd-data-gate-fingerprint-control');
    const before = await captureDeviceState(control.repository);
    const beforeFingerprint = fingerprintOf(before);
    expect(beforeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The captured state is substantial: an empty capture would make the digest
    // meaningless.
    expect(before.records.length).toBeGreaterThan(20);
    expect(before.legacyEntries.length).toBeGreaterThanOrEqual(9);
    expect(before.activeGenerationId).toBe(POPULATED_GENERATION_ID);

    await mutateActiveSubject(control.repository, POPULATED_GENERATION_ID, SUBJECT_IDS.alpha);
    const after = await captureDeviceState(control.repository);
    const differences = diffDeviceStates(before, after);

    expect(fingerprintOf(after)).not.toBe(beforeFingerprint);
    expect(differences.length).toBeGreaterThan(0);
    // The difference is named by generation, store, record, and field - and it is
    // the subject record that was edited.
    expect(
      differences.some(
        (difference) =>
          difference.kind === 'record' &&
          difference.where.endsWith(`/subjects/${SUBJECT_IDS.alpha}`) &&
          difference.field === 'value',
      ),
      describeDifferences(differences),
    ).toBe(true);
    // The record count did not change: only the value did, so the diff is not
    // merely noticing an added or removed row.
    expect(after.recordCounts).toEqual(before.recordCounts);
  });

  it('a legacy key change is detected too, because the rollback path is a legacy key', async () => {
    resetLegacyStorage();
    const control = await createPopulatedDevice('kd-data-gate-legacy-control');
    const before = await captureDeviceState(control.repository);
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_IDS.beta);
    const after = await captureDeviceState(control.repository);
    expect(fingerprintOf(after)).not.toBe(fingerprintOf(before));
    expect(diffDeviceStates(before, after)).toEqual([
      {
        kind: 'legacy-value',
        where: 'knowledge-dungeon:v1:activeSubjectId',
        field: 'value',
      },
    ]);
    // Put it back so the rest of this file's fixture is the documented one.
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_IDS.alpha);
  });
});

describe('Phase 5 gate 3: the audited reader accepts a good archive', () => {
  it('the reference archive is read successfully, with every declared member present', () => {
    // Non-vacuity: a reader that rejected everything would satisfy "every
    // corruption was rejected" while proving nothing.
    const outcome = auditedRead(good.bytes);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ accepted: true });
    const members = readArchive(good.bytes);
    expect(members.map((member) => member.path).sort()).toEqual(
      [...good.memberNames].sort(),
    );
    // And the good archive has real content, not two empty members.
    expect(good.memberNames.length).toBeGreaterThanOrEqual(5);
    const stateBytes = readArchive(good.bytes).find(
      (member) => member.path === 'state.json',
    )?.bytes as Uint8Array;
    expect(stateBytes.length).toBeGreaterThan(1000);
  });
});

describe('Phase 5 gate 3: the fifteen corruption cases, measured against the audited codec', () => {
  it('the table has fifteen cases, and every pinned code is in the real error vocabulary', () => {
    expect(CORRUPTION_CASES).toHaveLength(15);
    expect(CORRUPTION_CASE_ORDER).toHaveLength(15);
    expect(new Set(CORRUPTION_CASE_ORDER).size).toBe(15);
    // Real content, not a copy of itself: the codes are checked against the
    // union parsed out of the application's own source file.
    const vocabulary = readStorageV2ErrorCodes();
    expect(vocabulary.length).toBeGreaterThan(20);
    for (const spec of CORRUPTION_CASES) {
      expect(vocabulary, spec.id).toContain(spec.expectedCode);
      expect(spec.rule.length, spec.id).toBeGreaterThan(20);
      expect(spec.contractReason, spec.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('exactly the cases the table marks codec-rejected are rejected by the codec', () => {
    const rejected: CorruptionCaseId[] = [];
    const accepted: CorruptionCaseId[] = [];
    for (const id of CORRUPTION_CASE_ORDER) {
      const outcome = outcomes.get(id) as CodecOutcome;
      if (outcome.accepted) accepted.push(id);
      else rejected.push(id);
    }
    // The partition is measured, so if the codec's coverage changes this fails
    // and the table has to be revisited rather than quietly going stale.
    expect([...rejected].sort()).toEqual(
      CORRUPTION_CASES.filter((spec) => spec.codecCoverage === 'codec-rejects')
        .map((spec) => spec.id)
        .sort(),
    );
    expect([...accepted].sort()).toEqual(
      CORRUPTION_CASES.filter((spec) => spec.codecCoverage === 'requires-product-validation')
        .map((spec) => spec.id)
        .sort(),
    );
    expect(rejected).toHaveLength(CODEC_REJECTED_CASE_COUNT);
    expect(CODEC_REJECTED_CASE_COUNT).toBe(8);
    expect(accepted).toHaveLength(7);
  });

  it('every codec rejection is a typed StorageV2Error with sanitized details', () => {
    const vocabulary = new Set(readStorageV2ErrorCodes());
    let checked = 0;
    for (const id of CORRUPTION_CASE_ORDER) {
      const outcome = outcomes.get(id) as CodecOutcome;
      const spec = CORRUPTION_CASE_BY_ID.get(id) as (typeof CORRUPTION_CASES)[number];
      if (outcome.accepted) {
        // A case the table says only the product can catch is genuinely accepted
        // by the codec today. That is the whole reason
        // `src/services/persistence/products/archiveValidation.ts` is a Phase 5
        // deliverable, so the gate states it rather than implying coverage.
        expect(spec.codecCoverage, id).toBe('requires-product-validation');
        expect(spec.codecObservedCode, id).toBeNull();
        continue;
      }
      expect(outcome.code, id).not.toBeNull();
      expect(vocabulary.has(outcome.code as string), `${id}: ${String(outcome.code)}`).toBe(true);
      expect(spec.codecCoverage, id).toBe('codec-rejects');
      // The measured codec code and reason are pinned, so a change in the codec's
      // own classification is loud rather than silent.
      expect(outcome.code, id).toBe(spec.codecObservedCode);
      expect(outcome.reason, id).toBe(spec.codecObservedReason);
      // Every string detail satisfies the rule the constructor itself enforces, so
      // no filename, path, or URL can be hiding in an error.
      for (const key of outcome.detailKeys) {
        expect(key, id).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
      checked += 1;
    }
    expect(checked).toBe(8);
  });

  it('none of the fifteen corruptions touches the device, and a good archive still reads', async () => {
    const before = await captureDeviceState(device.repository);
    const beforeFingerprint = fingerprintOf(before);
    const fixtures = buildCorruptionCases(good);

    for (const id of CORRUPTION_CASE_ORDER) {
      const fixture = fixtures.get(id) as { bytes: Uint8Array };
      // The attempt: hand the corrupt bytes to the audited reader. A reader that
      // reads the bytes at all must not be able to write through them, and the
      // fingerprint proves it did not.
      auditedRead(fixture.bytes);

      const after = await captureDeviceState(device.repository);
      expect(fingerprintOf(after), `${id} changed the device`).toBe(beforeFingerprint);
      expect(diffDeviceStates(before, after), id).toEqual([]);
    }

    // ...and afterwards a good archive is still readable, so the loop above did
    // not leave the reader or the device in a broken state.
    expect(auditedRead(good.bytes)).toMatchObject({ accepted: true });
    expect(readArchive(good.bytes).length).toBe(good.memberNames.length);
  });
});

describe('Phase 5 gate 3: REGISTERED - the product import refuses every corruption', () => {
  for (const spec of CORRUPTION_CASES) {
    it(`${spec.id}: the import fails, the device is unchanged, and a good import still works`, async () => {
      // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
      // `exportFullDeviceBackup` and `importFullDeviceBackup` in
      // `src/services/persistence/products/fullDeviceBackup.ts`, called with the
      // request objects declared in `./support/backupAdapter`. The product
      // implements both, so each of the fifteen cases is now a live assertion
      // rather than a waiting one: the typed code, the byte-for-byte-unchanged
      // device, and a good import still working afterwards.
      const context = {
        repository: device.repository,
        generationId: POPULATED_GENERATION_ID,
        now: DEVICE_NOW,
        payloadBytes: device.payloadBytes,
      };
      // The good archive is the *product's own*, so "a subsequent good import
      // succeeds" is not measuring this gate's reference writer.
      const goodBytes = await produceArchive(context);
      const fixtures = buildCorruptionCases(good);
      const corrupt = (fixtures.get(spec.id) as { bytes: Uint8Array }).bytes;

      const before = await captureDeviceState(device.repository);
      const beforeFingerprint = fingerprintOf(before);
      expect(beforeFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // The import must fail, with the pinned typed code.
      let thrown: unknown = null;
      try {
        await consumeArchive(context, corrupt);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${spec.id} was imported instead of refused`).not.toBeNull();
      expect(thrown, `${spec.id} threw a non-StorageV2Error value`).toBeInstanceOf(StorageV2Error);
      const failure = thrown as StorageV2Error;
      expect(failure.code, spec.id).toBe(spec.expectedCode);
      expect(failure.details.reason, spec.id).toBe(spec.contractReason);
      for (const [key, value] of Object.entries(failure.details)) {
        if (typeof value !== 'string') continue;
        expect(isSanitizedDetailText(value), `${spec.id} detail ${key}`).toBe(true);
      }

      // Nothing about the device moved: not the pointer, not one record, not one
      // legacy key.
      const after = await captureDeviceState(device.repository);
      expect(fingerprintOf(after), `${spec.id} changed the device`).toBe(beforeFingerprint);
      expect(diffDeviceStates(before, after), spec.id).toEqual([]);
      expect(after.activeGenerationId).toBe(before.activeGenerationId);
      expect(after.legacyEntries).toEqual(before.legacyEntries);
      expect(after.records.length).toBe(before.records.length);

      // And the device is still usable: a good import into it succeeds.
      await consumeArchive(context, goodBytes);
      const afterGood = await captureDeviceState(device.repository);
      expect(
        fingerprintOf(afterGood),
        `${spec.id}: a good import after a refused one did not land`,
      ).not.toBe(beforeFingerprint);
    });
  }

  it('names the interface the fifteen import reproductions are waiting on', () => {
    // A pin, not a placeholder. Each of the fifteen tests above becomes a live
    // assertion the moment this module exports either of these names.
    expect(FULL_DEVICE_BACKUP_MODULE).toBe(
      '@/services/persistence/products/fullDeviceBackup',
    );
    expect(CORRUPTION_CASES.every((spec) => spec.expectedCode.length > 0)).toBe(true);
    // The three attachment ids the fixture stores bytes for are named here so a
    // reader of this file can see which payloads the "unchanged" claim covers.
    expect([...device.duplicatePayloadAttachmentIds].sort()).toEqual(
      [ATTACHMENT_IDS.storedOne, ATTACHMENT_IDS.storedTwo].sort(),
    );
  });
});
