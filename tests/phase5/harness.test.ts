/**
 * Verifier gate V0: the harness itself.
 *
 * A verifier's fixture that cannot be built, or a fingerprint that cannot move,
 * would make every later "nothing changed" assertion decorative. So the harness
 * is proved before it is used: the device validates through the production
 * validator, the comparator reports a real difference when given one, and the
 * fingerprint moves when a real record is edited through the real repository.
 */

import { describe, expect, it } from 'vitest';

import { readArchiveJson, readArchive, writeArchive } from '@/services/persistence/v2/archive';
import type { AttachmentBlobRecordValue, SubjectRecordValue } from '@/services/persistence/v2/schema';
import {
  SUBJECT,
  buildVerifierDevice,
  captureDevice,
  diffValues,
  encodeValue,
  hashOf,
  bytesOf,
  VERIFIER_GENERATION,
} from './support/device';

describe('verifier harness: the device is real and the instruments can fail', () => {
  it('builds a populated device that the production validator accepts', async () => {
    const device = await buildVerifierDevice();
    try {
      const active = await device.repository.readActiveGenerationId();
      expect(active).toBe(VERIFIER_GENERATION);
      const report = await device.repository.validateGeneration(VERIFIER_GENERATION);
      // Disclosure-level warnings are legitimate for a shallow snapshot; a
      // blocking problem is not, and `ok` is exactly the blocking test.
      expect(report.problems.filter((problem) => problem.severity === 'error')).toEqual([]);
      expect(report.ok).toBe(true);
      const snapshot = await device.repository.readRecords(VERIFIER_GENERATION);
      // Every store the plan's section 7.3 names carries something.
      const values = snapshot.records as unknown as Record<string, unknown[]>;
      for (const store of [
        'subjects',
        'progression',
        'sessions',
        'preferences',
        'shortcuts',
        'assistance',
        'attachmentMetadata',
        'attachmentBlobs',
        'customSprites',
        'recovery',
        'migrationReceipts',
      ]) {
        expect(values[store]?.length ?? 0, store).toBeGreaterThan(0);
      }
      // Including the awkward ones: no rooms, one room, an external-only image.
      const subjects = values.subjects as Array<{
        value: { subjectId: string; snapshot: { rooms: Record<string, unknown> } };
      }>;
      const roomsBySubject = new Map(
        subjects.map((entry) => [entry.value.subjectId, Object.keys(entry.value.snapshot.rooms).length]),
      );
      expect(roomsBySubject.get(SUBJECT.empty)).toBe(0);
      expect(roomsBySubject.get(SUBJECT.single)).toBe(1);
    } finally {
      device.close();
    }
  });

  it('the comparator reports exactly the field that differs, and nothing else', () => {
    const left = { a: 1, b: { c: 'x', d: [1, 2, 3] }, gone: true };
    const right = { a: 1, b: { c: 'x', d: [1, 9, 3] } };
    const differences = diffValues(left, right);
    expect(differences).toEqual([
      { path: '$.b.d[1]', left: '2', right: '9' },
      { path: '$.gone', left: 'present', right: 'absent' },
    ]);
    // ...and it can see a single changed byte inside binary.
    const one = new Uint8Array([1, 2, 3, 4]);
    const two = new Uint8Array([1, 2, 3, 5]);
    expect(diffValues(toBuffer(one), toBuffer(two))).toEqual([
      { path: '$', left: `ab:${describeAsHex(one)}`, right: `ab:${describeAsHex(two)}` },
    ]);
    expect(diffValues(one, one)).toEqual([]);
  });

  it('the fingerprint moves when one real record is edited through the real repository', async () => {
    const device = await buildVerifierDevice();
    try {
      const before = await captureDevice(device.repository);
      const snapshot = await device.repository.readRecords(VERIFIER_GENERATION);
      const subject = (snapshot.records.subjects[0] as unknown as { value: Record<string, unknown> }).value;
      await device.repository.putRecords(VERIFIER_GENERATION, {
        subjects: [
          {
            ...subject,
            verifierSubjectField: 'ZZ-verifier-unknown-subject-field-EDITED',
          } as unknown as SubjectRecordValue,
        ],
      });
      const after = await captureDevice(device.repository);
      expect(after.digest).not.toBe(before.digest);
      expect(after.recordCount).toBe(before.recordCount);
      const changed = before.records.filter((entry, index) => entry[3] !== after.records[index]?.[3]);
      expect(changed).toHaveLength(1);
      expect(changed[0]?.[1]).toBe(SUBJECT.empty);
    } finally {
      device.close();
    }
  });

  it('the fingerprint is byte-sensitive for attachment blobs', async () => {
    // The application\'s own canonical serializer serializes an `ArrayBuffer` as
    // `{}`, so a byte change inside an attachment blob is invisible to a
    // checksum built from it. This harness must not inherit that, and this
    // asserts the claim rather than trusting it.
    expect(encodeValue({ bytes: bytesOf('abc').buffer })).toBe('{"bytes":ab:616263}');
    const device = await buildVerifierDevice();
    try {
      const before = await captureDevice(device.repository);
      const snapshot = await device.repository.readRecords(VERIFIER_GENERATION);
      const blob = snapshot.records.attachmentBlobs[0] as { value: { bytes: ArrayBuffer; byteLength: number } };
      const mutated = new Uint8Array(blob.value.bytes.slice(0));
      mutated[0] = (mutated[0] as number) ^ 0xff;
      await device.repository.putRecords(VERIFIER_GENERATION, {
        attachmentBlobs: [
          { ...blob.value, bytes: mutated.buffer, byteLength: mutated.byteLength } as AttachmentBlobRecordValue,
        ],
      });
      const after = await captureDevice(device.repository);
      expect(after.digest, 'a changed attachment byte did not move the fingerprint').not.toBe(
        before.digest,
      );
    } finally {
      device.close();
    }
  });

  it('the audited ZIP codec is a real ZIP writer and reader', () => {
    const bytes = writeArchive([
      { path: 'state.json', bytes: bytesOf('{"a":1}') },
      { path: 'attachments/' + hashOf(bytesOf('x')), bytes: bytesOf('x') },
    ]);
    expect(bytes[0]).toBe(0x50);
    expect(readArchive(bytes).map((member) => member.path)).toEqual([
      'state.json',
      `attachments/${hashOf(bytesOf('x'))}`,
    ]);
    expect(readArchiveJson(bytes, 'state.json')).toEqual({ a: 1 });
  });
});

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function describeAsHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
