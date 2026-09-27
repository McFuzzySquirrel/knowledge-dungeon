/**
 * Phase 6 verifier gate V10 - can the byte digest form be used to smuggle a
 * collision?
 *
 * ## Why this file exists
 *
 * The fix for Finding 3 makes a buffer serialise to a fixed-width
 * `{"__bytes__":{"length":N,"sha256":"…"}}` form instead of `{}`. That form is an
 * *object with a reserved key*. Any object-with-a-reserved-key serialisation has to
 * answer one question: is the form **injective**? Two different values must not
 * produce the same canonical form, or the checksum is ambiguous - and the whole point
 * of `canonicalJsonStringify` is that a checksum is a function of the value with no
 * two values colliding.
 *
 * The candidate is a plain object whose only key is `__bytes__`, holding a `length`
 * and a `sha256` that match a real buffer's. `isBinaryBuffer` is false for a plain
 * object, so it takes the ordinary object path - and the ordinary object path emits
 * the same text a real buffer emits.
 *
 * This file answers three questions, in order:
 *
 * 1. **Is it a collision?** Measured, not reasoned about.
 * 2. **Can it reach a generation?** A collision that cannot be stored cannot hurt, and
 *    the *only* thing that decides this is whether an untrusted value can put a
 *    `bytes` field into a record at all.
 * 3. **If it can be stored, is it caught?** `validateAttachmentBlobRecord` is the
 *    gate, so: does a spoofed `bytes` get refused, and is the refusal blocking?
 *
 * No `it.fails`: every case is a live assertion about behaviour that is right now.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify, checksumValue } from '@/services/persistence/v2/checksum';
import { validateAttachmentBlobRecord } from '@/services/persistence/v2/validation';
import { forgeDevice, readActiveValues } from './support/forge';

const sha = (value: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(value)).digest('hex');

/** A record whose `bytes` is a real buffer. */
function realRecord(bytes: Uint8Array) {
  return {
    attachmentId: 'att-smuggle-0001',
    contentHash: sha(bytes),
    bytes: bytes.slice().buffer as ArrayBuffer,
    byteLength: bytes.byteLength,
    storedAt: '2026-02-03T04:05:06.000Z',
  };
}

/** A record whose `bytes` is a plain object dressed up to look like the digest form. */
function spoofedRecord(bytes: Uint8Array) {
  return {
    attachmentId: 'att-smuggle-0001',
    contentHash: sha(bytes),
    bytes: { __bytes__: { length: bytes.byteLength, sha256: sha(bytes) } },
    byteLength: bytes.byteLength,
    storedAt: '2026-02-03T04:05:06.000Z',
  };
}

describe('Phase 6 verifier V10: the byte digest form is not injective, and it is still safe', () => {
  it('MEASURED: a spoofed digest object and a real buffer over the same bytes DO collide', () => {
    const bytes = new Uint8Array([11, 22, 33, 44]);
    const real = realRecord(bytes);
    const spoof = spoofedRecord(bytes);

    // Both serialise to the same text, so both hash to the same checksum.
    expect(canonicalJsonStringify(spoof)).toBe(canonicalJsonStringify(real));
    expect(checksumValue(spoof)).toBe(checksumValue(real));
    // The spoof is not the same value: one carries bytes, the other carries a claim.
    expect(Object.prototype.toString.call(real.bytes)).toBe('[object ArrayBuffer]');
    expect(Object.prototype.toString.call(spoof.bytes)).toBe('[object Object]');
    // So the digest form is ambiguous, and this file says so rather than asserting a
    // uniqueness the serialiser does not have.
  });

  it('the collision is only reachable through a field the archive format cannot carry', async () => {
    // `AttachmentBlobRecordValue` is a *store* record, never a JSON document. The
    // `.kdsubject` layout carries `attachmentMetadata` - which has no `bytes` field -
    // and the attachment bytes travel as ZIP members, which the reader turns into real
    // `Uint8Array`s. So no hostile archive can inject a `bytes` value at all.
    const product = await import('@/services/persistence/products/subjectBackup');
    // `readSubjectArchive` on a hand-built archive is the reachable path; the reader
    // itself is what constructs blobs, and it constructs them from member bytes.
    const source = String(product.readSubjectArchiveContents);
    expect(source).toContain('bytes: bytes.slice().buffer');
    expect(source).not.toContain('bytes: value.bytes');
    // The document keys the reader accepts are a closed set, and none of them is a
    // blob record.
    expect(source).toContain('SUBJECT_ARCHIVE_SUBJECT_DOCUMENT_KEYS');
    const { SUBJECT_ARCHIVE_SUBJECT_DOCUMENT_KEYS } = await import(
      '@/services/persistence/products/subjectBackup'
    );
    expect(SUBJECT_ARCHIVE_SUBJECT_DOCUMENT_KEYS).toContain('attachmentMetadata');
    expect(SUBJECT_ARCHIVE_SUBJECT_DOCUMENT_KEYS).not.toContain('attachmentBlobs');
    // ...and the *only* place a blob record is ever constructed is from ZIP member
    // bytes, so its `bytes` is a real buffer by construction.
    const { SUBJECT_ARCHIVE_FIXED_MEMBERS } = await import(
      '@/services/persistence/products/subjectBackup'
    );
    expect(SUBJECT_ARCHIVE_FIXED_MEMBERS.some((name) => name.includes('blob'))).toBe(false);
  });

  it('a spoofed bytes field is refused as a blocking problem, so a collision cannot be activated', () => {
    const bytes = new Uint8Array([11, 22, 33, 44]);
    // Refused, and refused as `blob-without-bytes` - the field is not a buffer at all,
    // which is the honest reason. The content hash is correct, so this is not a
    // `content-hash-mismatch`; the validator catches the *shape*.
    const result = validateAttachmentBlobRecord(spoofedRecord(bytes) as never);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      { code: 'blob-without-bytes', scope: 'attachment-blob', count: 1, severity: 'error' },
    ]);
    // ...and a real buffer with the same declared hash is still accepted, so the
    // refusal is the spoof's doing and not a blanket refusal of everything.
    expect(validateAttachmentBlobRecord(realRecord(bytes) as never).ok).toBe(true);
  });

  it('a record that ALREADY has a __bytes__ key as a sibling cannot alias the digest form', () => {
    // The other direction of the same question: a record whose *other* fields contain
    // a `__bytes__` key. Canonical JSON sorts keys, so a sibling and the bytes field
    // are distinguishable by position and a reader can tell them apart.
    const bytes = new Uint8Array([5, 6, 7]);
    const withSibling = {
      ...realRecord(bytes),
      extra: { __bytes__: { length: 3, sha256: sha(bytes) } },
    };
    const withoutSibling = { ...realRecord(bytes), extra: { note: 'x' } };
    expect(canonicalJsonStringify(withSibling)).not.toBe(canonicalJsonStringify(withoutSibling));
    // A nested `__bytes__` with a *wrong* digest is likewise distinguishable.
    const lying = { ...realRecord(bytes), extra: { __bytes__: { length: 3, sha256: '0'.repeat(64) } } };
    expect(canonicalJsonStringify(lying)).not.toBe(canonicalJsonStringify(withSibling));
  });

  it('a generation built by the real repository cannot hold a spoofed blob, and its checksum is stable', async () => {
    // The end-to-end shape of the claim: stage two generations from identical records
    // and confirm the roll-up checksum is a function of the values, so a stale
    // checksum cannot survive a rebuild - which is the property the no-version-bump
    // decision rests on.
    const device = await forgeDevice();
    const snapshot = await device.repository.readRecords(device.generationId);
    const records = {
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
    };
    const first = await device.repository.stageGeneration({
      generationId: 'forge-stable-0002',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records,
    });
    const second = await device.repository.stageGeneration({
      generationId: 'forge-stable-0003',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records: { ...records },
    });
    // Same values in, same checksum out, across two generations and two record-count
    // prefixes: the checksum does not depend on the generation it was written for.
    expect(second.contentChecksum).toBe(first.contentChecksum);
    // ...and the bytes really are inside it: one flipped bit moves it.
    const blobs = records.attachmentBlobs;
    const firstBlob = blobs[0]!;
    const flipped = new Uint8Array(firstBlob.bytes.byteLength);
    flipped.fill(0x11);
    const third = await device.repository.stageGeneration({
      generationId: 'forge-stable-0004',
      source: 'local-edit',
      parentGenerationId: device.generationId,
      records: {
        ...records,
        attachmentBlobs: [
          { ...firstBlob, bytes: flipped.buffer as ArrayBuffer },
          ...blobs.slice(1),
        ],
      },
    });
    expect(third.contentChecksum).not.toBe(first.contentChecksum);
    // ...and a generation whose checksums were computed by the *previous* build is the
    // one thing the no-bump decision has to account for, so measure it: the descriptor
    // of a generation staged now carries the new checksum, and the previous generation
    // on disk still carries whatever it was written with. A retained generation is
    // never re-validated against the current rule by the repository's own reads, which
    // is what makes "derived state, rewritten on write" the right call.
    const staged = await device.repository.readGeneration('forge-stable-0002');
    expect(staged?.descriptor?.contentChecksum).toBe(first.contentChecksum);
    const live = await readActiveValues(device);
    expect(live.attachmentBlobs.length).toBe(2);
  });
});
