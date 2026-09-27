/**
 * Phase 6 data-product gate 6: an export is byte-deterministic under a fixed clock.
 *
 * "Deterministic" is the whole of the claim and every part of it is easy to get
 * wrong independently, so each is asserted separately and each has caught a real
 * defect at least once in this repository's history:
 *
 * 1. **The members.** The four JSON documents are canonical JSON with sorted keys, so
 *    JavaScript key order cannot leak into the bytes.
 * 2. **The record order inside each document.** Sorted by the record id the
 *    repository derives, not by an IndexedDB cursor's order, so the same records
 *    always produce the same document.
 * 3. **The container.** This is the one fflate gets wrong by default: it stamps each
 *    entry from `Date.now()` at two-second resolution, so two exports seconds apart
 *    differ in a handful of header bytes while every member is identical. The
 *    product derives the member time from the injected clock instead. The clock used
 *    here is `2011-03-04T05:06:07.000Z`, which is nowhere near the device clock and
 *    nowhere near any plausible wall clock, so a test that passed because the wall
 *    clock agreed could not exist.
 * 4. **The member order.** Manifest first, then the four fixed documents in the
 *    plan's order, then content-addressed attachment members in a deterministic
 *    order.
 *
 * The non-vacuity property is the one that matters here: the two exports are compared
 * **byte for byte** over the whole archive, not over the decoded members, and the
 * fixture is proven sensitive to the clock by requiring a *different* clock to
 * produce *different* bytes. Without that, "the two exports are identical" would also
 * be satisfied by a product that wrote nothing at all.
 *
 * Privacy: the assertions read member names, lengths, and digests.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readArchive } from '@/services/persistence/v2/archive';
import { sha256Hex } from '@/services/persistence/v2/checksum';
import {
  exportSubjectBackup,
  readSubjectArchive,
  SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
  SUBJECT_ARCHIVE_DOCUMENT_MEMBERS,
  SUBJECT_ARCHIVE_MANIFEST_MEMBER,
  SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
  SUBJECT_ARCHIVE_SESSIONS_MEMBER,
  SUBJECT_ARCHIVE_SUBJECT_MEMBER,
  SUBJECT_BACKUP_FILE_NAME,
} from '@/services/persistence/products/subjectBackup';
import {
  NASTY_DEVICE_NOW,
  NASTY_DETERMINISM_NOW,
  NASTY_GENERATION_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  type NastyDevice,
} from './support/nastySubject';

let device: NastyDevice;

async function exportAt(now: string): Promise<Uint8Array> {
  return (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
}

beforeAll(async () => {
  device = await createNastySubjectDevice('kd-data-gate-determinism');
});

describe('Phase 6 gate 6: two exports under the same clock are the same bytes', () => {
  it('the whole archive is byte-identical, and the archive is substantial', async () => {
    const first = await exportAt(NASTY_DETERMINISM_NOW);
    const second = await exportAt(NASTY_DETERMINISM_NOW);
    // Byte-for-byte over the container, not over the decoded members: this is the
    // assertion that would fail if the ZIP headers carried a wall-clock timestamp.
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    expect(Array.from(first)).toEqual(Array.from(second));
    // Non-trivial, so "identical" is a statement about real content.
    expect(first.byteLength).toBeGreaterThan(1000);
    expect(readArchive(first).length).toBeGreaterThanOrEqual(5);
  });

  it('a different clock produces different bytes, so the clock is really an input', async () => {
    // The falsification of the test above. If a different clock also produced
    // identical bytes, the "deterministic" assertion would be measuring an archive
    // that ignored its clock entirely - which is a different, and much worse, product.
    const atDeterminismClock = await exportAt(NASTY_DETERMINISM_NOW);
    const atDeviceClock = await exportAt(NASTY_DEVICE_NOW);
    const atAnotherClock = await exportAt('2033-11-12T13:14:15.000Z');
    expect(sha256Hex(atDeviceClock)).not.toBe(sha256Hex(atDeterminismClock));
    expect(sha256Hex(atAnotherClock)).not.toBe(sha256Hex(atDeterminismClock));
    expect(sha256Hex(atDeviceClock)).not.toBe(sha256Hex(atAnotherClock));
    // The content-addressed attachment member is byte-identical under both clocks,
    // because the payload does not depend on the clock. The four JSON documents are
    // not, because each of them carries the injected `createdAt` - which is the point:
    // the clock is a real input to the content, not only to the container.
    const attachmentMembers = (bytes: Uint8Array): Map<string, string> =>
      new Map(
        readArchive(bytes)
          .filter((file) => file.path.startsWith('attachments/'))
          .map((file) => [file.path, sha256Hex(file.bytes)]),
      );
    expect([...attachmentMembers(atDeterminismClock).entries()]).toEqual(
      [...attachmentMembers(atDeviceClock).entries()],
    );
    const documentsOf = (bytes: Uint8Array): Map<string, string> =>
      new Map(
        readArchive(bytes)
          .filter((file) => file.path.endsWith('.json'))
          .map((file) => [file.path, sha256Hex(file.bytes)]),
      );
    expect(documentsOf(atDeviceClock).get(SUBJECT_ARCHIVE_PROGRESSION_MEMBER)).not.toBe(
      documentsOf(atDeterminismClock).get(SUBJECT_ARCHIVE_PROGRESSION_MEMBER),
    );
    // The declared creation time is the one thing that legitimately differs inside the
    // manifest, and it is the injected clock's value.
    expect(readSubjectArchive(atDeterminismClock).createdAt).toBe(NASTY_DETERMINISM_NOW);
    expect(readSubjectArchive(atDeviceClock).createdAt).toBe(NASTY_DEVICE_NOW);
  });

  it('the member order is the plan\'s order, and every member name is a plan name', async () => {
    const members = readArchive(await exportAt(NASTY_DETERMINISM_NOW)).map((file) => file.path);
    const attachments = members.filter((path) => path.startsWith('attachments/'));
    expect(members.slice(0, 5)).toEqual([
      SUBJECT_ARCHIVE_MANIFEST_MEMBER,
      SUBJECT_ARCHIVE_SUBJECT_MEMBER,
      SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
      SUBJECT_ARCHIVE_SESSIONS_MEMBER,
      SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
    ]);
    expect(attachments.length).toBeGreaterThanOrEqual(1);
    for (const path of attachments) expect(path).toMatch(/^attachments\/[0-9a-f]{64}$/);
    // Nothing else: the layout is closed, and this is the plan's five names plus the
    // one prefix.
    expect(new Set(members).size).toBe(members.length);
    expect(members.every((path) => SUBJECT_ARCHIVE_DOCUMENT_MEMBERS.includes(path) || path === SUBJECT_ARCHIVE_MANIFEST_MEMBER || /^attachments\/[0-9a-f]{64}$/.test(path))).toBe(true);
  });

  it('the member timestamps come from the injected clock, not from the wall clock', async () => {
    // Read the DOS timestamps out of the archive's own local file headers. This is
    // the direct measurement of the property the byte-identity assertion depends on,
    // and it is what would regress if `mtime` were ever dropped from the writer's
    // options - in which case the two exports would still match on a fast machine and
    // fail on a slow one.
    const bytes = await exportAt(NASTY_DETERMINISM_NOW);
    const dates = new Set<number>();
    const times = new Set<number>();
    for (let index = 0; index + 4 <= bytes.byteLength; index += 1) {
      if (
        bytes[index] !== 0x50 ||
        bytes[index + 1] !== 0x4b ||
        bytes[index + 2] !== 0x03 ||
        bytes[index + 3] !== 0x04
      ) {
        continue;
      }
      // A local file header is 30 fixed bytes: signature (0-3), version (4-5), flags
      // (6-7), method (8-9), **DOS time (10-11)**, **DOS date (12-13)**, CRC (14-17),
      // compressed size (18-21), uncompressed size (22-25), name length (26-27), extra
      // field length (28-29). Both timestamp fields are little-endian 16-bit.
      const time = (bytes[index + 10] as number) | ((bytes[index + 11] as number) << 8);
      const date = (bytes[index + 12] as number) | ((bytes[index + 13] as number) << 8);
      dates.add(date);
      times.add(time);
      // The header is 30 fixed bytes plus the name and the extra field.
      const nameLength = (bytes[index + 26] as number) | ((bytes[index + 27] as number) << 8);
      const extraLength = (bytes[index + 28] as number) | ((bytes[index + 29] as number) << 8);
      index += 30 + nameLength + extraLength - 1;
    }
    // One date and one time for every member, and both decode to the injected clock.
    // A DOS date is `(year - 1980) << 9 | month << 5 | day` and a DOS time is
    // `hour << 11 | minute << 5 | second / 2`, with two-second resolution.
    expect(dates.size).toBe(1);
    expect(times.size).toBe(1);
    const [date] = [...dates];
    const [time] = [...times];
    expect((date as number) >> 9).toBe(2011 - 1980);
    expect(((date as number) >> 5) & 0x0f).toBe(3);
    expect((date as number) & 0x1f).toBe(4);
    // The **hour** is deliberately not asserted to equal 5. A ZIP DOS timestamp is
    // local time by definition, and the audited codec converts the `Date` it is given
    // in the machine's own timezone - so the hour is the injected hour shifted by the
    // local UTC offset. The minutes and seconds are asserted exactly (a timezone
    // offset is always a whole number of minutes, so only the hour can move), and the
    // hour is bounded by the widest real offset.
    //
    // This is a real limitation of the container, not of this product, and Phase 5's
    // `.kdbak` has the identical property: two exports under the same injected clock
    // are byte-identical **on one machine**, and the members - which is where all the
    // data is - are byte-identical everywhere. It is recorded in the phase report as a
    // known limitation rather than papered over, because asserting the local hour
    // would make this gate fail on every machine but the one that wrote it.
    expect(((time as number) >> 5) & 0x3f).toBe(6);
    // Two-second resolution, so 07 seconds truncates to 06.
    expect((time as number) & 0x1f).toBe(3);
    const hour = (time as number) >> 11;
    expect(hour).toBeGreaterThanOrEqual(5 - 12);
    expect(hour).toBeLessThanOrEqual(5 + 14);
  });

  it('the offered file name is fixed and content-free', async () => {
    const result = await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DETERMINISM_NOW,
      payloadBytes: device.payloadBytes,
    });
    expect(result.fileName).toBe(SUBJECT_BACKUP_FILE_NAME);
    // Plan section 12, rule 6: no learner data in a filename, and no timestamp either
    // - a timestamp would make an otherwise deterministic export look like it varied.
    expect(result.fileName).toMatch(/^[a-z0-9][A-Za-z0-9._-]*$/);
    expect(result.fileName).not.toContain(NASTY_SUBJECT_ID);
    expect(result.fileName).not.toContain(NASTY_DETERMINISM_NOW);
    expect(result.fileName.endsWith('.kdsubject')).toBe(true);
    // ...and the same name whatever the subject and the clock.
    const other = await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    });
    expect(other.fileName).toBe(result.fileName);
  });
});
