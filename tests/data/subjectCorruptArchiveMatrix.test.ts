/**
 * Phase 6 data-product gate 14: the corrupt- and hostile-archive matrix is real.
 *
 * Gate 12 (`subjectImportIsolation.test.ts`) proves the *consequence*: a refused
 * import leaves the whole device byte-identical. This gate proves the *inputs* - that
 * the matrix really is a matrix of distinct corruptions, that each corruption is the
 * one its case is named for, and that the codes pinned for them are codes the
 * application can actually throw. A matrix built from thirty-four copies of one
 * corruption would pass gate 12 perfectly while proving nothing about the rules.
 *
 * Five properties, each falsifiable on its own:
 *
 * 1. **The table is a matrix.** Distinct ids, distinct rules, and every case declared
 *    with the typed code and the sanitized reason the product must produce.
 * 2. **Every pinned code is real.** Read out of the application's own
 *    `StorageV2ErrorCode` union, parsed from the source file, so a pinned code that
 *    stopped being part of the vocabulary fails here by name rather than as a
 *    compile error someone could mistake for a typo.
 * 3. **The reader can accept.** The good archive is read successfully first, so
 *    "every corruption was refused" cannot be explained by a reader that refuses
 *    everything - and the good archive is a *substantial* one, so it is not two empty
 *    members.
 * 4. **The *consistently* corrupt cases are genuinely consistent.** "Consistent" means
 *    exactly what it says and no more: **every recomputable checksum was recomputed and
 *    is correct.** So a consistent case has a manifest whose roll-up digest recomputes
 *    from its own declared digests, every member whose declared digest matches the
 *    bytes actually present, and an `attachments/<sha256>` member that still hashes to
 *    its own declared digests - while the thing that is actually wrong is something the
 *    manifest's digests cannot express: a count, a declared length, a member name, or
 *    a version. That is the part a checksum-only implementation fails, and it is checked
 *    here by re-reading each such archive's own bytes. A case that is consistent where
 *    it claims not to be, or the reverse, fails this test, so the flag cannot quietly
 *    stop meaning anything.
 * 5. **Every required corruption class is present**, from a closed list: not-a-ZIP,
 *    truncation, a missing index, non-JSON members, a wrong document shape, a lying
 *    count, a broken content address, a missing member, an extra member, an unknown
 *    prefix, a descriptive member name, path traversal, an absolute path, a drive
 *    letter, an oversized name, a prototype key, a dropped member, a directory entry, a
 *    symlink, and a forged version of each of the three contracts.
 *
 * Privacy: the corruptions are structural. No corruption introduces a subject name, a
 * topic, a note, a filename, or a URL; the only host named is the reserved
 * `example.invalid`, and it comes from the good archive rather than from a corruption.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readArchive } from '@/services/persistence/v2/archive';
import { sha256Hex } from '@/services/persistence/v2/checksum';
import { inspectSubjectArchive, readSubjectArchive } from '@/services/persistence/products/subjectBackup';
import { decodeArchiveJsonMember } from '@/services/persistence/v2/archive';
import { membersOf, readShape, reseal, buildSubjectCorruptionCases } from './support/subjectArchive';
import { exportSubjectBackup } from '@/services/persistence/products/subjectBackup';
import { readStorageV2ErrorCodes } from './support/productInterface';
import {
  NASTY_DEVICE_NOW,
  NASTY_GENERATION_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  type NastyDevice,
} from './support/nastySubject';

let device: NastyDevice;
let good: Uint8Array;
let cases: ReturnType<typeof buildSubjectCorruptionCases>;

/**
 * The corruption classes the plan and the Phase 5 precedent require, as a closed
 * list keyed by the case ids this suite uses.
 *
 * A closed list, so a class cannot quietly stop being covered: a rename would fail
 * here by name, which is the point.
 */
const REQUIRED_CLASSES: Readonly<Record<string, string>> = {
  'not-a-zip': 'random-bytes',
  truncation: 'truncated-archive',
  'missing-index': 'missing-central-directory',
  'empty-archive': 'empty-archive',
  'non-json-manifest': 'manifest-not-json',
  'non-json-subject': 'subject-not-json',
  'wrong-document-shape': 'subject-wrong-shape',
  'non-string-subject-id': 'subject-id-not-a-string',
  'lying-record-count': 'manifest-counts-disagree',
  'lying-room-count': 'manifest-room-count-disagrees',
  'lying-member-length': 'manifest-member-length-disagrees',
  'broken-content-address': 'attachment-not-content-addressed',
  'missing-declared-member': 'missing-declared-member',
  'missing-fixed-member': 'missing-assistance-member',
  'extra-member': 'unexpected-extra-member',
  'unknown-prefix': 'unknown-prefix-member',
  'descriptive-member-name': 'descriptive-attachment-member',
  'path-traversal': 'zip-slip-member-name',
  'absolute-path': 'absolute-path-member',
  'drive-letter': 'drive-letter-member',
  'oversized-name': 'oversized-member-name',
  'prototype-key-root': 'prototype-member-name',
  'prototype-key-nested': 'declared-prototype-member-name',
  'prototype-key-segment': 'nested-prototype-segment-member',
  'dropped-member': 'unrepresentable-member-name',
  'directory-entry': 'directory-entry-member',
  'symlink': 'symlink-style-member',
  'forged-product-version': 'forged-format-version',
  'forged-storage-version': 'forged-storage-generation-version',
  'forged-subject-schema': 'forged-subject-schema-version',
  'relabelled-product': 'full-device-members-relabelled',
  'mixed-subjects': 'documents-name-different-subjects',
  'closed-key-set': 'manifest-unexpected-field',
  'missing-manifest-field': 'manifest-missing-field',
  'lying-disclosure-histogram': 'external-only-histogram-disagrees',
};

beforeAll(async () => {
  device = await createNastySubjectDevice('kd-data-gate-corrupt-matrix');
  good = (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: NASTY_GENERATION_ID,
      subjectId: NASTY_SUBJECT_ID,
      now: NASTY_DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
  cases = buildSubjectCorruptionCases({ good, shape: readShape(good) });
});

describe('Phase 6 gate 14: the matrix is a matrix', () => {
  it('every case has a distinct id, a distinct rule, a real code, and a code-shaped reason', () => {
    const vocabulary = new Set(readStorageV2ErrorCodes());
    expect(vocabulary.size).toBeGreaterThan(20);
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    expect(new Set(cases.map((entry) => entry.rule)).size).toBe(cases.length);
    for (const entry of cases) {
      expect(vocabulary, `${entry.id}: ${entry.code}`).toContain(entry.code);
      expect(entry.reason, entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(entry.rule.length, entry.id).toBeGreaterThan(20);
      expect(entry.bytes.byteLength, entry.id).toBeGreaterThan(0);
    }
  });

  it('every required corruption class is present, and the class list is closed', () => {
    const ids = new Set(cases.map((entry) => entry.id));
    for (const [className, id] of Object.entries(REQUIRED_CLASSES)) {
      expect(ids, `corruption class ${className}`).toContain(id);
    }
    expect(Object.keys(REQUIRED_CLASSES).length).toBeGreaterThanOrEqual(30);
    // Every case in the matrix belongs to a declared class, so the table cannot grow
    // a case that is not part of the reviewed contract.
    expect([...ids].sort()).toEqual(Object.values(REQUIRED_CLASSES).sort());
  });

  it('the reader is proven able to accept the good archive first', () => {
    const preview = readSubjectArchive(good);
    expect(preview.product).toBe('kdsubject');
    expect(preview.memberCount).toBeGreaterThanOrEqual(5);
    expect(preview.totalMemberCount).toBe(preview.memberCount + 1);
    expect(preview.roomCount).toBeGreaterThan(0);
    expect(preview.recordCounts.subjects).toBe(1);
    const members = readArchive(good);
    expect(members.length).toBe(preview.totalMemberCount);
    // Real content, not two empty members.
    const subjectBytes = members.find((file) => file.path === 'subject.json')?.bytes as Uint8Array;
    expect(subjectBytes.byteLength).toBeGreaterThan(1000);
  });

  it('every case is refused with its pinned code and reason, and the shared pairs are pinned', () => {
    const seen = new Map<string, string[]>();
    for (const entry of cases) {
      const inspection = inspectSubjectArchive(entry.bytes);
      expect(inspection.ok, `${entry.id} was accepted`).toBe(false);
      if (inspection.ok) continue;
      expect(inspection.error.code, entry.id).toBe(entry.code);
      expect(inspection.error.details.reason, entry.id).toBe(entry.reason);
      const key = `${inspection.error.code}/${String(inspection.error.details.reason)}`;
      seen.set(key, [...(seen.get(key) ?? []), entry.id]);
    }

    // The pairs that share a code and a reason are **pinned**, not tolerated by a
    // floor. Each one is the same rule catching two genuinely different corruptions -
    // a member name that is not in the closed layout whether it is a wrong prefix, a
    // filename, or a prototype key; "that member is not JSON" whether the member is
    // the manifest or the subject - and a gate that let a *new* pair appear would be a
    // gate that had stopped noticing. So the exact shared set is asserted, and a
    // tenth case joining one of these rows fails here.
    const shared: Readonly<Record<string, readonly string[]>> = {
      'ARCHIVE_MALFORMED/member-name-not-in-layout': [
        'unknown-prefix-member',
        'descriptive-attachment-member',
        'declared-prototype-member-name',
      ],
      'ARCHIVE_MALFORMED/member-not-json': ['manifest-not-json', 'subject-not-json'],
      'ARCHIVE_MALFORMED/unexpected-member': [
        'unexpected-extra-member',
        'nested-prototype-segment-member',
      ],
      'ARCHIVE_MEMBER_MISSING/missing-fixed-member': [
        'missing-assistance-member',
        'full-device-members-relabelled',
      ],
      'ARCHIVE_UNSAFE_PATH/prototype-member-name': [
        'prototype-member-name',
        'unrepresentable-member-name',
      ],
      'CHECKSUM_MISMATCH/member-checksum-mismatch': [
        'attachment-not-content-addressed',
        'manifest-member-length-disagrees',
      ],
      'COUNT_MISMATCH/manifest-counts-disagree': [
        'manifest-counts-disagree',
        'manifest-room-count-disagrees',
        'external-only-histogram-disagrees',
      ],
      'VALIDATION_FAILED/document-wrong-shape': [
        'subject-wrong-shape',
        'subject-id-not-a-string',
      ],
    };
    const actualShared: Record<string, string[]> = {};
    for (const [key, ids] of [...seen.entries()].sort()) {
      if (ids.length > 1) actualShared[key] = ids;
    }
    expect(actualShared).toEqual(shared);
    // Seventeen cases stand alone, and one code/reason pair covers exactly the eight
    // shared groups plus those seventeen.
    expect(seen.size).toBe(Object.keys(shared).length + 17);
    expect(cases.length).toBe(35);
  });
});

describe('Phase 6 gate 14: the consistently corrupt cases really are consistent', () => {
  it('each claims consistency only when its own manifest agrees with itself', () => {
    let consistent = 0;
    let inconsistent = 0;
    for (const entry of cases) {
      const inspectable = inspectSubjectArchive(entry.bytes);
      // A case that is *not* consistent is refused early, before its manifest is
      // reached, so the check only runs for the cases that got far enough to have one.
      if (inspectable.ok) continue;
      const isReadFailure =
        inspectable.error.code !== 'VALIDATION_FAILED' &&
        inspectable.error.code !== 'COUNT_MISMATCH' &&
        inspectable.error.code !== 'CHECKSUM_MISMATCH';
      if (isReadFailure) continue;

      let members: Map<string, Uint8Array>;
      let manifest: Record<string, unknown>;
      try {
        members = membersOf(entry.bytes);
        manifest = decodeArchiveJsonMember(
          readArchive(entry.bytes),
          'manifest.json',
        ) as Record<string, unknown>;
      } catch {
        // The case never produced a readable manifest, so it cannot be a *consistent*
        // one, and asserting otherwise would make this gate decorative.
        inconsistent += 1;
        continue;
      }
      const declared = (manifest.members ?? []) as Array<{ path: string; sha256: string; byteLength: number }>;
      const rollUp = sha256Hex(
        new TextEncoder().encode(declared.map((member) => `${member.sha256} ${member.path}`).join('\n')),
      );
      // Deliberately **not** checked: `memberCount`, `totalBytes`, `recordCounts`, and
      // each member's declared `byteLength`. Those are *claims*, and a consistent case
      // lies about one of them on purpose - that is what makes it a case about
      // semantics rather than about arithmetic. What is checked is every digest.
      const selfConsistent =
        typeof manifest.contentChecksum === 'string' &&
        rollUp === manifest.contentChecksum &&
        declared.every((member) => {
          const bytes = members.get(member.path);
          return bytes !== undefined && sha256Hex(bytes) === member.sha256;
        });
      // Deliberately **not** checked: the `attachments/<sha256>` content-address rule.
      // It is a rule about the member *name*, not a checksum the manifest carries, and
      // `attachment-not-content-addressed` is precisely the case built to defeat an
      // implementation that only compares the manifest's digests. Whether the product
      // enforces that rule is asserted in
      // `subjectImportIsolation.test.ts` against the pinned code, not here.
      if (selfConsistent) {
        consistent += 1;
        expect(entry.consistent, `${entry.id} is self-consistent but claims not to be`).toBe(true);
      } else {
        inconsistent += 1;
        expect(entry.consistent, `${entry.id} is inconsistent but claims to be consistent`).toBe(false);
      }
    }
    // The point of the whole idea: a substantial set of these cases defeats a
    // checksum-only implementation, and a substantial set does not - the latter matters
    // because a suite where every case is consistent would be measuring one rule.
    // Pinned exactly, because this is a closed matrix: ten cases defeat a
    // checksum-only implementation and three do not. Only thirteen of the thirty-five
    // reach a manifest comparison at all - the rest are refused earlier, by the codec's
    // structural rules or by the member-name safety sweep - which is why this total is
    // below the case count and why it is pinned rather than derived.
    expect(consistent).toBe(10);
    expect(inconsistent).toBe(3);
    expect(consistent + inconsistent).toBe(13);
  });

  it('a manifest that lies only about a semantic count is otherwise perfect', async () => {
    // The single most important case, built and checked by hand: the manifest's
    // roll-up recomputes, every member's digest matches, the attachment member still
    // hashes to its own name, and the only thing wrong is one declared count. An
    // implementation that validated by digest alone would import this archive.
    const lying = cases.find((entry) => entry.id === 'manifest-counts-disagree');
    expect(lying).toBeDefined();
    const members = membersOf(lying?.bytes as Uint8Array);
    const manifest = decodeArchiveJsonMember(
      readArchive(lying?.bytes as Uint8Array),
      'manifest.json',
    ) as Record<string, unknown>;
    const declared = manifest.members as Array<{ path: string; sha256: string }>;
    expect(
      sha256Hex(
        new TextEncoder().encode(declared.map((member) => `${member.sha256} ${member.path}`).join('\n')),
      ),
    ).toBe(manifest.contentChecksum);
    for (const member of declared) {
      const bytes = members.get(member.path) as Uint8Array;
      expect(sha256Hex(bytes), member.path).toBe(member.sha256);
    }
    for (const path of members.keys()) {
      if (path.startsWith('attachments/')) expect(sha256Hex(members.get(path) as Uint8Array)).toBe(path.slice('attachments/'.length));
    }
    // ...and the declared record count is the only thing that differs from the truth.
    const resealed = reseal(manifest, members);
    expect((resealed.recordCounts as Record<string, number>).sessions).toBe(
      (manifest.recordCounts as Record<string, number>).sessions,
    );
    expect((manifest.recordCounts as Record<string, number>).sessions).toBe(99);
  });
});
