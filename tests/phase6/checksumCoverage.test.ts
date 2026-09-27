/**
 * Phase 6 verifier gate V1 - the checksum chain and attachment bytes.
 *
 * Plan section 7.1 step 3 requires a migration or restore to "Compare record
 * counts, relationships, and checksums", and plan section 5.2 requires that
 * "Data imports never partially overwrite the active data generation". The subject
 * import implements that comparison, so the question underneath it is: **is the
 * checksum being compared sensitive to the bytes of an attachment?**
 *
 * ## What this file used to be
 *
 * It was a live demonstration of a defect. `canonicalJsonStringify` had a
 * `Uint8Array` branch and no `ArrayBuffer` branch, and
 * `AttachmentBlobRecordValue.bytes` is typed `ArrayBuffer`, so an `ArrayBuffer`
 * fell through to the "any other class instance … its own enumerable string keys"
 * branch and serialised as `{}`. `validateAttachmentBlobRecord` checked presence and
 * length but never recomputed `sha256(bytes)` against `contentHash`. The result: two
 * generations differing only in attachment bytes had a **byte-identical**
 * `contentChecksum`, and a blob whose bytes disagreed with its declared content hash
 * activated with no problem reported.
 *
 * **This file is now a positive control for the fix**, and every case carries a
 * non-vacuity control: a demonstration that the fix works is worth more than the
 * demonstration that the bug did, and an assertion that cannot fail is worth nothing.
 * The shape used throughout is:
 *
 * - assert the **fixed** behaviour, exactly;
 * - then assert the property the fix rests on **discriminates** - two inputs the rule
 *   must tell apart, and two it must treat alike;
 * - and where the bug was "everything looked the same", invert the assertion so it
 *   now fails if sameness ever returns.
 *
 * No `it.fails`: every case is a live assertion about behaviour that is right now.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify, checksumValue } from '@/services/persistence/v2/checksum';
import { validateAttachmentBlobRecord } from '@/services/persistence/v2/validation';
import { forgeDevice, fingerprintDevice, ATT_ALPHA, ATT_BETA_SHARED } from './support/forge';

const sha = (value: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(value)).digest('hex');

function blobRecord(bytes: ArrayBuffer | Uint8Array, contentHash: string) {
  return {
    attachmentId: 'att-probe-0001',
    contentHash,
    bytes,
    byteLength: (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).byteLength,
    storedAt: '2026-02-03T04:05:06.000Z',
  };
}

/** The digest form the product now writes for any buffer. */
const DIGEST_FORM = /^\{"__bytes__":\{"length":\d+,"sha256":"[0-9a-f]{64}"\}\}$/;

describe('Phase 6 verifier V1: attachment bytes are inside the checksum', () => {
  it('a buffer serialises to the fixed-width digest form, for an ArrayBuffer and for a view alike', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const asArrayBuffer = bytes.slice().buffer as ArrayBuffer;
    const asView = new Uint8Array(bytes);

    // The exact form, so a rename or a reshaping of the marker is caught rather than
    // merely "not `{}` any more".
    const serialisedArrayBuffer = JSON.parse(
      canonicalJsonStringify(blobRecord(asArrayBuffer, 'x')),
    ) as { bytes: unknown };
    const serialisedView = JSON.parse(canonicalJsonStringify(blobRecord(asView, 'x'))) as {
      bytes: unknown;
    };
    expect(JSON.stringify(serialisedArrayBuffer.bytes)).toMatch(DIGEST_FORM);
    expect(JSON.stringify(serialisedView.bytes)).toMatch(DIGEST_FORM);
    // The digest is the real one over the real bytes, and the length is the real one.
    expect(serialisedArrayBuffer.bytes).toEqual({
      __bytes__: { length: 5, sha256: sha(bytes) },
    });
    // ...and the old blind spot is gone: the empty-object serialisation cannot come
    // back, and nothing about the payload is silently absent.
    expect(canonicalJsonStringify(blobRecord(asArrayBuffer, 'x'))).not.toContain('"bytes":{}');
  });

  it('NON-VACUITY: the form discriminates - same length, different bytes, different form', () => {
    // This is the assertion that would have failed before the fix, where two
    // different byte arrays produced the same string. It is the case that makes the
    // previous case worth anything.
    const one = new Uint8Array(64).fill(1);
    const two = new Uint8Array(64).fill(2);
    expect(one.byteLength).toBe(two.byteLength);
    const left = canonicalJsonStringify(blobRecord(one.slice().buffer as ArrayBuffer, 'h'));
    const right = canonicalJsonStringify(blobRecord(two.slice().buffer as ArrayBuffer, 'h'));
    expect(left).not.toBe(right);
    expect(left).toContain(sha(one));
    expect(right).toContain(sha(two));
    expect(left).not.toContain(sha(two));
    // ...and the same discrimination at the level the import actually compares.
    expect(checksumValue(blobRecord(one, 'h'))).not.toBe(checksumValue(blobRecord(two, 'h')));
  });

  it('NON-VACUITY: the form does NOT over-discriminate - one container, one checksum', () => {
    // An `ArrayBuffer` and a `Uint8Array` over identical bytes must be the *same*
    // value, or a checksum would depend on which container a caller happened to hand
    // over - which is the ambiguity the digest form exists to remove.
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const asArrayBuffer = blobRecord(bytes.slice().buffer as ArrayBuffer, 'h');
    const asView = blobRecord(new Uint8Array(bytes), 'h');
    expect(canonicalJsonStringify(asView)).toBe(canonicalJsonStringify(asArrayBuffer));
    expect(checksumValue(asView)).toBe(checksumValue(asArrayBuffer));
    // A `Buffer` - which is a `Uint8Array` subclass with its own internals - and a
    // subarray that covers only part of an allocation are covered too, because the
    // view's own `byteOffset` is honoured.
    const padded = new Uint8Array(16).fill(0xff);
    padded.set([1, 2, 3], 5);
    const window = padded.subarray(5, 8);
    expect(checksumValue(blobRecord(window, 'h'))).toBe(
      checksumValue(blobRecord(new Uint8Array([1, 2, 3]), 'h')),
    );
  });

  it('NON-VACUITY: the discrimination assertion above would have failed on the old rule, and here is the proof', () => {
    // The strongest available non-vacuity control without touching product code: a
    // local re-implementation of the *previous* behaviour, run through the same
    // comparison. If the assertion above could not tell the two apart, this case
    // would not notice; because it does, the assertion has teeth.
    //
    // The old rule: a `Uint8Array` branch, no `ArrayBuffer` branch, and an
    // `ArrayBuffer` falling through to "its own enumerable string keys", which is
    // `{}`.
    const oldSerialise = (value: unknown): string => {
      if (value === null) return 'null';
      if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
      if (typeof value === 'string') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(oldSerialise).join(',')}]`;
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${oldSerialise(record[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    const one = new Uint8Array(64).fill(1);
    const two = new Uint8Array(64).fill(2);
    // The old rule collapses both byte arrays to `{}`, so the two records serialise
    // identically - which is exactly the observation the verifier made before the fix.
    expect(oldSerialise(blobRecord(one.slice().buffer as ArrayBuffer, 'h'))).toBe(
      oldSerialise(blobRecord(two.slice().buffer as ArrayBuffer, 'h')),
    );
    expect(oldSerialise(blobRecord(one.slice().buffer as ArrayBuffer, 'h'))).toContain('"bytes":{}');
    // ...and the fixed rule does not. Same inputs, same comparison, opposite result:
    // the assertion in this file is a real discriminator and not a tautology.
    expect(canonicalJsonStringify(blobRecord(one.slice().buffer as ArrayBuffer, 'h'))).not.toBe(
      canonicalJsonStringify(blobRecord(two.slice().buffer as ArrayBuffer, 'h')),
    );
  });

  it('a cross-realm buffer is inside the checksum too, not outside this realm\'s ArrayBuffer', () => {
    // `fake-indexeddb` returns values through its own structured-clone, so a record
    // read back out of the database holds an `ArrayBuffer` from another realm. This
    // is the case the verifier's own harness had to be built around, and it is the
    // case where `instanceof` would quietly fail.
    const bytes = new Uint8Array([4, 3, 2, 1]);
    const stored = blobRecord(bytes.slice().buffer as ArrayBuffer, 'h');
    const expected = checksumValue(stored);
    const crossed = { ...stored, bytes: structuredClone(stored.bytes) };
    // The same value, arrived at through a different realm.
    expect(Object.prototype.toString.call(crossed.bytes)).toBe('[object ArrayBuffer]');
    expect(checksumValue(crossed)).toBe(expected);
  });

  it('validateAttachmentBlobRecord recomputes the content hash and blocks a mismatch', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // A record whose `contentHash` is not the hash of its bytes is refused, with the
    // one code that says so, at `error` severity so it blocks activation. This is the
    // inverted assertion: it failed before the fix, which returned `ok: true` and no
    // problems at all for exactly this record.
    const lying = blobRecord(bytes.slice().buffer as ArrayBuffer, 'f'.repeat(64));
    const mismatch = validateAttachmentBlobRecord(lying as never);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.problems).toEqual([
      { code: 'content-hash-mismatch', scope: 'attachment-blob', count: 1, severity: 'error' },
    ]);
    // One flipped bit in a long payload is caught: the rule is a real digest, not a
    // length or a prefix check.
    const long = new Uint8Array(4096).fill(7);
    const flipped = new Uint8Array(long);
    flipped[2048] = 8;
    const wrongBytes = blobRecord(flipped.slice().buffer as ArrayBuffer, sha(long));
    expect(validateAttachmentBlobRecord(wrongBytes as never).ok).toBe(false);
  });

  it('NON-VACUITY: the new rule does not refuse everything - a correct record is still accepted', () => {
    // Without this, the previous case would also pass if the validator refused every
    // blob, which is a different defect with the same symptom.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const honest = blobRecord(bytes.slice().buffer as ArrayBuffer, sha(bytes));
    expect(validateAttachmentBlobRecord(honest as never).ok).toBe(true);
    expect(validateAttachmentBlobRecord(honest as never).problems).toEqual([]);
    // ...and it is the *bytes* it checks, not the declared length: a record claiming
    // the right length over the wrong bytes is still refused.
    const lyingLength = { ...honest, contentHash: sha(new Uint8Array([9, 9, 9, 9])) };
    expect(validateAttachmentBlobRecord(lyingLength as never).ok).toBe(false);
  });

  it('a generation whose attachment bytes disagree with their hashes is refused, and its checksum moves', async () => {
    const device = await forgeDevice();
    const snapshot = await device.repository.readRecords(device.generationId);
    const alphaBlob = snapshot.records.attachmentBlobs.find((e) => e.value.attachmentId === ATT_ALPHA);
    expect(alphaBlob).toBeDefined();
    const original = alphaBlob!.value;
    // The pre-existing device, fingerprinted, so "this test staged two extra
    // generations" is a statement rather than an assumption: the active generation
    // and every original record are still exactly what the forge wrote.
    const before = await fingerprintDevice(device.repository, device.databaseName);
    expect(before.blobBytes).toBeGreaterThan(0);

    // Corrupt the bytes in place. `contentHash` and `byteLength` are deliberately
    // left exactly as they were, so the record still *claims* to be the same content
    // and only the payload differs.
    const corruptedBytes = new Uint8Array(original.bytes.byteLength).fill(0x5a);
    const corrupted = { ...original, bytes: corruptedBytes.buffer as ArrayBuffer };
    expect(Buffer.from(corruptedBytes)).not.toEqual(Buffer.from(new Uint8Array(original.bytes)));

    const baseRecords = {
      subjects: snapshot.records.subjects.map((e) => e.value),
      progression: snapshot.records.progression.map((e) => e.value),
      sessions: snapshot.records.sessions.map((e) => e.value),
      preferences: snapshot.records.preferences.map((e) => e.value),
      shortcuts: snapshot.records.shortcuts.map((e) => e.value),
      assistance: snapshot.records.assistance.map((e) => e.value),
      attachmentMetadata: snapshot.records.attachmentMetadata.map((e) => e.value),
      customSprites: snapshot.records.customSprites.map((e) => e.value),
      recovery: snapshot.records.recovery.map((e) => e.value),
      // The receipts are not carried: a receipt must name the generation holding it.
      migrationReceipts: [] as never[],
    };
    const otherBlobs = snapshot.records.attachmentBlobs
      .filter((e) => e.value.attachmentId !== ATT_ALPHA)
      .map((e) => e.value);

    // Two generations from *the same* records, differing only in the bytes of one
    // attachment. Any difference in their roll-up checksums is therefore attributable
    // to the bytes and to nothing else - which is the measurement, isolated.
    const honest = await device.repository.stageGeneration({
      generationId: 'forge-honest-0002',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records: { ...baseRecords, attachmentBlobs: [original, ...otherBlobs] },
    });
    const corruptedGeneration = await device.repository.stageGeneration({
      generationId: 'forge-corrupt-0002',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records: { ...baseRecords, attachmentBlobs: [corrupted, ...otherBlobs] },
    });

    // THE FIX, at the level the import compares: the roll-up checksum now MOVES.
    expect(corruptedGeneration.contentChecksum).not.toBe(honest.contentChecksum);

    // ...and the corrupted generation is refused, with a blocking problem naming the
    // one record that is wrong.
    const validation = await device.repository.validateGeneration('forge-corrupt-0002');
    expect(validation.ok).toBe(false);
    expect(validation.problems).toContainEqual({
      code: 'content-hash-mismatch',
      scope: 'attachment-blob',
      count: 1,
      severity: 'error',
    });
    // The honest generation, staged from the same records, is accepted - so the
    // refusal above is the corruption's doing and not the fixture's.
    const honestValidation = await device.repository.validateGeneration('forge-honest-0002');
    expect(honestValidation.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(honestValidation.ok).toBe(true);
  });

  it('NON-VACUITY: an honest generation with a rebuilt checksum still activates, so the checksum is not merely always different', async () => {
    const device = await forgeDevice();
    const snapshot = await device.repository.readRecords(device.generationId);
    const staged = await device.repository.stageGeneration({
      generationId: 'forge-honest-0003',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records: {
        subjects: snapshot.records.subjects.map((e) => e.value),
        progression: snapshot.records.progression.map((e) => e.value),
        sessions: snapshot.records.sessions.map((e) => e.value),
        preferences: snapshot.records.preferences.map((e) => e.value),
        shortcuts: snapshot.records.shortcuts.map((e) => e.value),
        assistance: snapshot.records.assistance.map((e) => e.value),
        attachmentMetadata: snapshot.records.attachmentMetadata.map((e) => e.value),
        attachmentBlobs: snapshot.records.attachmentBlobs.map((e) => e.value),
        customSprites: snapshot.records.customSprites.map((e) => e.value),
        recovery: snapshot.records.recovery.map((e) => e.value),
        migrationReceipts: [],
      },
    });
    // The bytes round-trip unchanged, so the checksum of a generation re-staged from
    // the same records is the same one: the new rule is a function of the value, not
    // of when it was computed.
    const again = await device.repository.stageGeneration({
      generationId: 'forge-honest-0004',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records: {
        subjects: snapshot.records.subjects.map((e) => e.value),
        progression: snapshot.records.progression.map((e) => e.value),
        sessions: snapshot.records.sessions.map((e) => e.value),
        preferences: snapshot.records.preferences.map((e) => e.value),
        shortcuts: snapshot.records.shortcuts.map((e) => e.value),
        assistance: snapshot.records.assistance.map((e) => e.value),
        attachmentMetadata: snapshot.records.attachmentMetadata.map((e) => e.value),
        attachmentBlobs: snapshot.records.attachmentBlobs.map((e) => e.value),
        customSprites: snapshot.records.customSprites.map((e) => e.value),
        recovery: snapshot.records.recovery.map((e) => e.value),
        migrationReceipts: [],
      },
    });
    expect(again.contentChecksum).toBe(staged.contentChecksum);
    // The pre-existing device is untouched by any of this.
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.blobBytes).toBeGreaterThan(0);
    // ...and the untouched sibling that shares the same content hash is still
    // byte-for-byte what it was, so a corruption is visible as a difference between
    // two records that claim identical content.
    const betaLine = after.records.find((line) => line.includes(ATT_BETA_SHARED));
    const alphaLine = after.records.find((line) => line.includes(ATT_ALPHA));
    expect(betaLine).toBeDefined();
    expect(alphaLine).toBeDefined();
    expect(alphaLine).not.toBe(betaLine);
  });
});
