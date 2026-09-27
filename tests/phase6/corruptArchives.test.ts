/**
 * Phase 6 verifier gate V7 - corrupt and hostile `.kdsubject` archives.
 *
 * Plan section 12, rule 5: "Every migration must be versioned, idempotent,
 * validated, non-destructive until final cleanup, and fixture-tested." Plan section
 * 7.3 requires the import to report unavailable external-only attachments and not
 * to replace the active generation on failure.
 *
 * Three families, in increasing order of difficulty, because the third is the one
 * a shallow gate cannot reach:
 *
 * 1. **Structurally broken** - a truncated file, a missing fixed member, a
 *    duplicate member, a member the layout does not allow.
 * 2. **Hostile member names** - the same set Phase 5 established for the `.kdbak`
 *    (zip-slip, absolute, backslash, drive letter, a 4096-character name, an emoji
 *    name, an RTL-override name, a leading-space name, and every
 *    `Object.prototype` key), applied to the `.kdsubject` layout.
 * 3. **Consistently corrupt** - an archive in which *every recomputable checksum has
 *    been recomputed*. A member's bytes are edited, the member's `sha256` in the
 *    manifest is recomputed over the edited bytes, `totalBytes` and
 *    `contentChecksum` are recomputed over the new member list, and the ZIP is
 *    rewritten. Nothing about the container is wrong any more. The only thing that
 *    can refuse such a file is a *semantic* rule - a declared count, a declared
 *    version contract, a per-record validator, or the storage-v2 activation check -
 *    so this is the family that decides whether the product's validation is load
 *    bearing or decorative.
 *
 * The writer is the product's own audited codec in every case; this file never
 * hand-rolls ZIP, and it shares no builder with `tests/data/support/hostileZip.ts`.
 *
 * Every refusal case additionally asserts that the device is byte-identical
 * afterwards, because "refused" is only half of what plan section 5.2 requires.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  exportSubjectBackup,
  importSubjectBackup,
  readSubjectArchive,
  readSubjectArchiveContents,
} from '@/services/persistence/products/subjectBackup';
import { fullDeviceManifestContentChecksum } from '@/services/persistence/products/archiveValidation';
import { readArchive, writeArchive, type ArchiveFile } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import {
  ALPHA,
  ATT_ALPHA,
  MARKERS,
  forgeDevice,
  type ForgedDevice,
} from './support/forge';
import { fingerprintDevice } from './support/forge';

const NOW = '2026-05-06T07:08:09.000Z';
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

async function exportAlpha(device: ForgedDevice): Promise<Uint8Array> {
  const result = await exportSubjectBackup({
    repository: device.repository,
    generationId: device.generationId,
    subjectId: ALPHA,
    now: NOW,
    payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
  });
  return result.bytes;
}

/** Rewrite an archive from a member map, repairing every declared checksum. */
function rebuildConsistently(
  original: Uint8Array,
  edit: (members: Map<string, Uint8Array>) => Map<string, Uint8Array>,
): Uint8Array {
  const files = readArchive(original);
  const members = new Map<string, Uint8Array>();
  for (const file of files) members.set(file.path, file.bytes);
  const edited = edit(members);
  const manifest = JSON.parse(new TextDecoder().decode(edited.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
  const declared = (manifest.members as Array<{ path: string; byteLength: number; sha256: string }>).filter(
    (member) => edited.has(member.path) && member.path !== 'manifest.json',
  );
  const rebuilt = declared.map((member) => {
    const content = edited.get(member.path) as Uint8Array;
    return { path: member.path, byteLength: content.byteLength, sha256: sha256Hex(content) };
  });
  const newManifest = {
    ...manifest,
    members: rebuilt,
    memberCount: rebuilt.length,
    totalBytes: rebuilt.reduce((total, member) => total + member.byteLength, 0),
    contentChecksum: fullDeviceManifestContentChecksum(rebuilt),
  };
  const out: ArchiveFile[] = [];
  for (const [path, content] of edited) {
    if (path === 'manifest.json') continue;
    out.push({ path, bytes: content });
  }
  out.push({ path: 'manifest.json', bytes: utf8(canonicalJsonStringify(newManifest)) });
  return writeArchive(out);
}

/** Assert that a byte string is refused, by code, and that the device is untouched. */
async function expectRefusedAndUnchanged(
  device: ForgedDevice,
  bytes: Uint8Array,
  label: string,
): Promise<{ code: string; reason: unknown }> {
  const before = await fingerprintDevice(device.repository, device.databaseName);
  let code = '';
  let reason: unknown;
  try {
    await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    throw new Error(`${label}: the import SUCCEEDED on an archive it should have refused`);
  } catch (error) {
    const typed = error as { code?: string; details?: Record<string, unknown>; message?: string };
    code = typed.code ?? typed.message ?? 'unknown';
    reason = typed.details?.reason;
  }
  const after = await fingerprintDevice(device.repository, device.databaseName);
  expect(after.digest, `${label}: the device changed`).toBe(before.digest);
  return { code, reason };
}

describe('Phase 6 verifier V7: corrupt and hostile archives', () => {
  it('a truncated archive is refused and the device is untouched', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    for (const keep of [0.1, 0.5, 0.9, 0.999]) {
      const truncated = bytes.slice(0, Math.floor(bytes.length * keep));
      await expectRefusedAndUnchanged(device, truncated, `truncated at ${keep}`);
    }
  });

  it('a missing fixed member is refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    for (const missing of ['manifest.json', 'subject.json', 'progression.json', 'sessions.json', 'assistance.json']) {
      const files = readArchive(bytes).filter((file) => file.path !== missing);
      const corrupt = writeArchive(files);
      const result = await expectRefusedAndUnchanged(device, corrupt, `missing ${missing}`);
      expect(['ARCHIVE_MEMBER_MISSING', 'ARCHIVE_MALFORMED']).toContain(result.code);
    }
  });

  it('a member the layout does not allow is refused, and the refusal names a reason not a path', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const files = readArchive(bytes);
    for (const extra of ['extra.json', 'preferences.json', 'custom-sprites/x.svg', 'recovery/x.json', 'attachments/not-a-hash']) {
      const corrupt = writeArchive([...files, { path: extra, bytes: utf8('{}') }]);
      const result = await expectRefusedAndUnchanged(device, corrupt, `extra member ${extra}`);
      expect(typeof result.reason).toBe('string');
      expect(String(result.reason)).toMatch(/^[a-z][a-z0-9-]*$/);
      // The rejection never quotes the member name it rejected.
      expect(JSON.stringify(result)).not.toContain(extra);
    }
  });

  it('a duplicate member cannot be written, and the writer says why', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const files = readArchive(bytes);
    const subject = files.find((file) => file.path === 'subject.json') as ArchiveFile;
    // The audited codec refuses to *emit* a duplicate, so the reachable path is the
    // writer. The reader's own duplicate check is the symmetric half and is
    // exercised by the product's shared `readAndVetArchiveMembers`.
    let code = '';
    try {
      writeArchive([...files, subject]);
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('ARCHIVE_MALFORMED');
    // A well-formed archive is still writable, so the refusal is specific.
    expect(writeArchive(files).length).toBeGreaterThan(0);
  });

  it('the Phase 5 hostile member-name set is refused on the .kdsubject layout', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const hostile = [
      '../escape.json',
      'a/../../escape.json',
      'deeply/nested/../../../escape.json',
      '/etc/passwd',
      '//host/share/file.json',
      'C:/windows/system32/drivers.json',
      'attachments\\000001.png',
      'subject.json\\..\\escape.json',
      'attachments/../escape.json',
      `attachments/${'a'.repeat(4096)}.png`,
      'attachments/\u{1f4e6}\u{1f4e6}.png',
      // A right-to-left override, which renders a name differently from how it
      // compares.
      'attachments/\u202egnp.exe\u202c.png',
      ' leading-space.json',
      'attachments/ leading-space.png',
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'hasOwnProperty',
      'attachments/__proto__',
      'attachments/constructor',
    ];
    for (const name of hostile) {
      // Some names the audited codec refuses to *write*; that refusal is itself the
      // correct outcome, so both paths are accepted and both must leave the device
      // alone.
      let corrupt: Uint8Array;
      try {
        corrupt = writeArchive([...readArchive(bytes), { path: name, bytes: utf8('{"x":1}') }]);
      } catch {
        corrupt = writeArchive([
          { path: 'manifest.json', bytes: utf8('{"product":"kdsubject","formatVersion":1,"storageGenerationFormatVersion":1,"subjectSchemaVersion":"1.1.0","createdAt":"2026-01-01T00:00:00.000Z","memberCount":1,"totalBytes":1,"contentChecksum":"' + '0'.repeat(64) + '","roomCount":0,"recordCounts":{"subjects":0,"progression":0,"sessions":0,"assistance":0,"attachments":0,"attachmentBlobs":0},"attachmentBytes":{"memberCount":0,"byteLength":0},"externalOnlyAttachments":{"count":0,"reasons":{}},"members":[{"path":"' + name + '","byteLength":1,"sha256":"' + '0'.repeat(64) + '"}]}') },
        ]);
      }
      const result = await expectRefusedAndUnchanged(device, corrupt, `hostile name ${JSON.stringify(name).slice(0, 40)}`);
      expect(result.code, `hostile name ${JSON.stringify(name).slice(0, 40)}`).not.toBe('unknown');
      // Nothing from the archive's learner content escaped either.
      for (const marker of Object.values(MARKERS)) {
        expect(JSON.stringify(result)).not.toContain(marker);
      }
    }
  });

  it('CONSISTENTLY CORRUPT: an edited subject record with every checksum recomputed is still refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // Sanity: the untouched archive is accepted, so the refusal below is the
    // corruption's doing and not the fixture's.
    expect(readSubjectArchive(bytes).recordCounts.subjects).toBe(1);

    const corrupt = rebuildConsistently(bytes, (members) => {
      const document = JSON.parse(new TextDecoder().decode(members.get('subject.json') as Uint8Array)) as Record<string, unknown>;
      // Drop the root room id, which makes `rootRoomId` and two edges dangle. The
      // declared `roomCount` is repaired too, so the *count* checks pass and the
      // refusal has to come from the relationship rules - which is the whole point
      // of a consistently corrupt archive.
      const snapshot = document.subject as { snapshot: { rooms: Record<string, unknown>; dungeon: Record<string, unknown> } };
      delete snapshot.snapshot.rooms['rm-alpha-root'];
      members.set('subject.json', utf8(canonicalJsonStringify(document)));
      const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
      manifest.roomCount = Object.keys(snapshot.snapshot.rooms).length;
      members.set('manifest.json', utf8(canonicalJsonStringify(manifest)));
      return members;
    });
    // The container is now internally consistent: this is the point of the case.
    const files = readArchive(corrupt);
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as { contentChecksum: string; members: Array<{ path: string; sha256: string }> };
    for (const member of manifest.members) {
      if (member.path === 'subject.json') {
        expect(member.sha256).toBe(createHash('sha256').update(files.find((f) => f.path === 'subject.json')!.bytes).digest('hex'));
      }
    }
    expect(manifest.contentChecksum).toBe(
      fullDeviceManifestContentChecksum(manifest.members as never),
    );
    // The read still succeeds - the product's own structural findings are
    // disclosures - and the import's activation check is what refuses it.
    const read = readSubjectArchive(corrupt);
    expect(read.disclosedProblems.map((p) => p.code)).toContain('unknown-room-reference');
    const result = await expectRefusedAndUnchanged(device, corrupt, 'dangling root after recomputed checksums');
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('CONSISTENTLY CORRUPT: a wrong declared room count is refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    for (const roomCount of [0, 2, 99]) {
      const corrupt = rebuildConsistently(bytes, (members) => {
        const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
        manifest.roomCount = roomCount;
        members.set('manifest.json', utf8(canonicalJsonStringify(manifest)));
        return members;
      });
      // Repaired again after the edit, so the only inconsistency is semantic.
      const result = await expectRefusedAndUnchanged(device, corrupt, `roomCount ${roomCount}`);
      expect(result.code).toBe('COUNT_MISMATCH');
    }
  });

  it('CONSISTENTLY CORRUPT: a record count that disagrees with the payload is refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    for (const [key, value] of [['sessions', 5], ['progression', 7], ['attachments', 0], ['assistance', 99]] as const) {
      const corrupt = rebuildConsistently(bytes, (members) => {
        const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
        (manifest.recordCounts as Record<string, number>)[key] = value;
        members.set('manifest.json', utf8(canonicalJsonStringify(manifest)));
        return members;
      });
      const result = await expectRefusedAndUnchanged(device, corrupt, `recordCounts.${key}=${value}`);
      expect(result.code).toBe('COUNT_MISMATCH');
    }
  });

  it('CONSISTENTLY CORRUPT: a newer subject schema in every document is refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const corrupt = rebuildConsistently(bytes, (members) => {
      for (const path of ['subject.json', 'progression.json', 'sessions.json', 'assistance.json']) {
        const document = JSON.parse(new TextDecoder().decode(members.get(path) as Uint8Array)) as Record<string, unknown>;
        document.subjectSchemaVersion = '9.9.9';
        members.set(path, utf8(canonicalJsonStringify(document)));
      }
      const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
      manifest.subjectSchemaVersion = '9.9.9';
      members.set('manifest.json', utf8(canonicalJsonStringify(manifest)));
      return members;
    });
    const result = await expectRefusedAndUnchanged(device, corrupt, 'newer subject schema everywhere');
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.reason).toBe('unsupported-subject-schema-version');
  });

  it('CONSISTENTLY CORRUPT: a document that names a different subject is refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const corrupt = rebuildConsistently(bytes, (members) => {
      const document = JSON.parse(new TextDecoder().decode(members.get('sessions.json') as Uint8Array)) as Record<string, unknown>;
      document.subjectId = 'subj-someone-else';
      members.set('sessions.json', utf8(canonicalJsonStringify(document)));
      return members;
    });
    const result = await expectRefusedAndUnchanged(device, corrupt, 'sessions name another subject');
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.reason).toBe('document-subject-disagrees');
  });

  it('CONSISTENTLY CORRUPT: an attachment member whose bytes do not hash to its own name is refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const corrupt = rebuildConsistently(bytes, (members) => {
      for (const path of [...members.keys()]) {
        if (!path.startsWith('attachments/')) continue;
        // Different bytes, and every declared digest and count is recomputed over
        // them - but the member NAME still says `attachments/<the old hash>`, which
        // is the content-addressed rule the product enforces separately and cannot
        // be satisfied by recomputing a checksum.
        members.set(path, utf8('substituted-bytes'));
      }
      const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
      const attachmentBytes = manifest.attachmentBytes as Record<string, number>;
      attachmentBytes.byteLength = [...members.entries()]
        .filter(([path]) => path.startsWith('attachments/'))
        .reduce((total, [, content]) => total + content.byteLength, 0);
      members.set('manifest.json', utf8(canonicalJsonStringify(manifest)));
      return members;
    });
    const result = await expectRefusedAndUnchanged(device, corrupt, 'content-addressed name mismatch');
    expect(result.code).toBe('CHECKSUM_MISMATCH');
  });

  it('CONSISTENTLY CORRUPT: attachment metadata claiming a hash with no member is disclosed, not refused', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // Drop the attachment member and declare its metadata external-only, with every
    // count and checksum recomputed. This is the plan's "report unavailable
    // external-only attachments" path, so the import must SUCCEED and disclose.
    const corrupt = rebuildConsistently(bytes, (members) => {
      const attachmentPaths = [...members.keys()].filter((path) => path.startsWith('attachments/'));
      for (const path of attachmentPaths) members.delete(path);
      const document = JSON.parse(new TextDecoder().decode(members.get('subject.json') as Uint8Array)) as {
        attachmentMetadata: Array<Record<string, unknown>>;
      };
      for (const record of document.attachmentMetadata) {
        record.availability = 'external-only';
        record.contentHash = null;
      }
      members.set('subject.json', utf8(canonicalJsonStringify(document)));
      const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json') as Uint8Array)) as Record<string, unknown>;
      (manifest.recordCounts as Record<string, number>).attachmentBlobs = 0;
      (manifest.attachmentBytes as Record<string, number>).memberCount = 0;
      (manifest.attachmentBytes as Record<string, number>).byteLength = 0;
      (manifest.externalOnlyAttachments as Record<string, unknown>).count = document.attachmentMetadata.length;
      (manifest.externalOnlyAttachments as Record<string, unknown>).reasons = {
        'bytes-not-recoverable': document.attachmentMetadata.filter((r) => r.sourceType === 'local').length,
        'historical-external-url': document.attachmentMetadata.filter((r) => r.sourceType === 'external').length,
      };
      members.set('manifest.json', utf8(canonicalJsonStringify(manifest)));
      return members;
    });
    const read = readSubjectArchive(corrupt);
    expect(read.externalOnlyCount).toBe(2);
    expect(read.attachmentBytes.memberCount).toBe(0);
    const result = await importSubjectBackup({ repository: device.repository, bytes: corrupt, now: NOW });
    expect(result.activated).toBe(true);
    expect(result.externalOnlyAttachments.length).toBe(2);
    for (const disclosure of result.externalOnlyAttachments) {
      expect(disclosure.contentHash).toBeNull();
      expect(disclosure.byteLength).toBeNull();
    }
  });

  it('an archive whose subject.json declares two subjects is refused - the layout is one subject', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    // The reader reads `subject.json`'s `subject` as one record, so "two subjects"
    // is expressed the way a hand-made archive would express it: a `subject` array.
    const corrupt = rebuildConsistently(bytes, (members) => {
      const document = JSON.parse(new TextDecoder().decode(members.get('subject.json') as Uint8Array)) as Record<string, unknown>;
      const one = document.subject as Record<string, unknown>;
      document.subject = [one, { ...one, subjectId: 'subj-second-0002' }];
      members.set('subject.json', utf8(canonicalJsonStringify(document)));
      return members;
    });
    const result = await expectRefusedAndUnchanged(device, corrupt, 'subject.json with two subjects');
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('an unexpected key anywhere in a document is refused, and the key is not echoed', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    for (const path of ['subject.json', 'progression.json', 'sessions.json', 'assistance.json', 'manifest.json']) {
      const corrupt = rebuildConsistently(bytes, (members) => {
        const document = JSON.parse(new TextDecoder().decode(members.get(path) as Uint8Array)) as Record<string, unknown>;
        document[`${MARKERS.tag}-extra-key`] = 'surprise';
        members.set(path, utf8(canonicalJsonStringify(document)));
        return members;
      });
      const result = await expectRefusedAndUnchanged(device, corrupt, `extra key in ${path}`);
      expect(result.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(result)).not.toContain(MARKERS.tag);
    }
  });

  it('a record with a hostile shape is refused as a typed error, never as an untyped throw', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const corrupt = rebuildConsistently(bytes, (members) => {
      const document = JSON.parse(new TextDecoder().decode(members.get('sessions.json') as Uint8Array)) as Record<string, unknown>;
      // The FIRST session is reshaped into something a naive normaliser would
      // recurse into or throw on. The array's length - and therefore the declared
      // count - is untouched, so the refusal has to come from the per-record
      // validator rather than from a count check.
      const sessions = document.sessions as Array<Record<string, unknown>>;
      sessions[0] = { sessionId: {}, subjectId: [], startedAt: null, roomsVisited: 'not-an-array', nested: { deeper: { deeperStill: {} } } };
      members.set('sessions.json', utf8(canonicalJsonStringify(document)));
      return members;
    });
    const result = await expectRefusedAndUnchanged(device, corrupt, 'hostile session shape');
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('the reader is idempotent: reading the same bytes twice gives the same result', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const first = readSubjectArchiveContents(bytes);
    const second = readSubjectArchiveContents(bytes);
    expect(JSON.stringify(second.preview)).toBe(JSON.stringify(first.preview));
  });

  it('an empty byte string and a non-Uint8Array are both refused', async () => {
    const device = await forgeDevice();
    await expectRefusedAndUnchanged(device, new Uint8Array(0), 'empty');
    // A `Buffer` IS a `Uint8Array`, so it is accepted; a plain array is not.
    let threw = false;
    try {
      readSubjectArchive([1, 2, 3] as never);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
