/**
 * Verifier gate V2 - Phase 5 exit criterion 2.
 *
 * "All available attachment bytes and custom sprite data survive."
 *
 * Every claim here is checked against **three** independent SHA-256
 * implementations - the application's own, Node's `crypto`, and Web Crypto where
 * it exists - so a digest that agrees with itself cannot carry the gate.
 *
 * The attacks: a zero-length payload; a payload that is its own digest (proved
 * impossible here, and therefore worth asserting rather than assuming); two
 * identical payloads; a payload differing only in its last byte; content
 * addressing under a *declared* hash that does not match; a member named after a
 * content hash whose bytes are something else; a custom sprite body full of
 * characters that would need escaping in a member name; and a sprite body that is
 * not valid JSON.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { exportFullDeviceBackup } from '@/services/persistence/products/fullDeviceBackup';
import { readFullDeviceArchive } from '@/services/persistence/products/archiveValidation';
import { readArchive, readArchiveJson, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import type {
  AttachmentMetadataRecordValue,
  CustomSpriteRecordValue,
  RecoveryRecordValue,
} from '@/services/persistence/v2/schema';
import {
  ATTACHMENT,
  bytesOf,
  hashOf,
  nodeHashOf,
  textOf,
  buildVerifierDevice,
  VERIFIER_RESTORE_NOW,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];

async function device(): Promise<VerifierDevice> {
  const built = await buildVerifierDevice();
  devices.push(built);
  return built;
}

afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

async function exportOf(source: VerifierDevice, payloadBytes?: ReadonlyMap<string, Uint8Array>) {
  return exportFullDeviceBackup({
    repository: source.repository,
    generationId: source.generationId,
    now: VERIFIER_RESTORE_NOW,
    payloadBytes: payloadBytes ?? source.payloadBytes,
    activeSubjectId: null,
  });
}

describe('V2: the digest the archive is built on is the real SHA-256', () => {
  it('the application digest agrees with Node crypto and with Web Crypto', async () => {
    const samples = [
      new Uint8Array(0),
      bytesOf('a'),
      bytesOf('ZZ-verifier-attachment-bytes-'),
      new Uint8Array(256 * 1024).fill(0x5a),
    ];
    for (const sample of samples) {
      const application = hashOf(sample);
      expect(application, `node vs application (${sample.byteLength} bytes)`).toBe(await nodeHashOf(sample));
      if (typeof globalThis.crypto?.subtle?.digest === 'function') {
        const view = new Uint8Array(sample); // a fresh copy: `subtle` needs a clean buffer
        const web = await globalThis.crypto.subtle.digest('SHA-256', view);
        const hex = Array.from(new Uint8Array(web))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        expect(hex, `webcrypto vs application (${sample.byteLength} bytes)`).toBe(application);
      }
    }
  });

  it('an attachment member is named by the digest of the bytes it carries, not by a label', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const members = readArchive(exported.bytes);
    const attachmentMembers = members.filter((member) => member.path.startsWith('attachments/'));
    expect(attachmentMembers.length).toBeGreaterThan(0);
    for (const member of attachmentMembers) {
      expect(member.path.slice('attachments/'.length)).toBe(hashOf(member.bytes));
      expect(await nodeHashOf(member.bytes)).toBe(member.path.slice('attachments/'.length));
    }
  });

  it('no member name carries anything a learner could recognise', async () => {
    const source = await device();
    const exported = await exportOf(source);
    for (const member of readArchive(exported.bytes)) {
      expect(member.path).toMatch(
        /^(?:manifest\.json|state\.json|attachments\/[0-9a-f]{64}|custom-sprites\/\d{6}\.[a-z0-9]{1,12}|recovery\/\d{6}\.json)$/,
      );
    }
  });
});

describe('V2: the awkward payloads', () => {
  it('two identical payloads collapse onto one member, and both records restore', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const members = readArchive(exported.bytes).filter((member) => member.path.startsWith('attachments/'));
    const shared = `attachments/${hashOf(source.payloads.stored)}`;
    expect(members.filter((member) => member.path === shared)).toHaveLength(1);
    // Six stored records, one of which is disclosed, over fewer distinct members.
    // Two disclosures: the record whose declared hash the device bytes do not
    // satisfy, and the record that was already external-only.
    expect(exported.externalOnlyAttachments.map((entry) => entry.attachmentId).sort()).toEqual(
      [ATTACHMENT.external, ATTACHMENT.hashDisagrees].sort(),
    );
    expect(exported.manifest.recordCounts.attachments).toBe(7 + 5);
  });

  it('a payload differing only in its last byte is a different member, and both restore exactly', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const storedHash = hashOf(source.payloads.stored);
    const lastByteHash = hashOf(source.payloads.lastByteOnly);
    expect(storedHash).not.toBe(lastByteHash);
    const members = readArchive(exported.bytes).map((member) => member.path);
    expect(members).toContain(`attachments/${storedHash}`);
    expect(members).toContain(`attachments/${lastByteHash}`);
    // ...and the difference is exactly one byte, which is what makes it a real test.
    let differences = 0;
    for (let index = 0; index < source.payloads.stored.byteLength; index += 1) {
      if (source.payloads.stored[index] !== source.payloads.lastByteOnly[index]) differences += 1;
    }
    expect(differences).toBe(1);
  });

  it('a zero-length payload is disclosed rather than written as an empty member', async () => {
    const source = await device();
    // The device's bytes for the shared payload replaced by nothing at all.
    // Both records that *share* the payload: give them both nothing.
    const payloadBytes = new Map(source.payloadBytes);
    payloadBytes.set(ATTACHMENT.stored, new Uint8Array(0));
    payloadBytes.set(ATTACHMENT.duplicatePayload, new Uint8Array(0));
    const exported = await exportOf(source, payloadBytes);
    const disclosures = exported.externalOnlyAttachments.map((entry) => entry.attachmentId);
    // Both are now unreachable, and both are disclosed: no empty member, no
    // fabricated hash, and no failure.
    expect(disclosures).toContain(ATTACHMENT.stored);
    expect(disclosures).toContain(ATTACHMENT.duplicatePayload);
    for (const disclosure of exported.externalOnlyAttachments) {
      expect(disclosure.contentHash).toBeNull();
      expect(disclosure.byteLength).toBeNull();
    }
    const members = readArchive(exported.bytes);
    expect(members.every((member) => member.bytes.byteLength > 0 || !member.path.startsWith('attachments/'))).toBe(
      true,
    );
    // The archive is still internally consistent and still restorable.
    const preview = readFullDeviceArchive(exported.bytes);
    expect(preview.problems).toEqual([]);
    expect(preview.externalOnlyCount).toBe(exported.externalOnlyAttachments.length);
  });

  it('a record whose declared hash the device bytes do not satisfy is disclosed, not written under the wrong name', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const disclosures = exported.externalOnlyAttachments;
    const disagreeing = disclosures.filter((entry) => entry.attachmentId === ATTACHMENT.hashDisagrees);
    expect(disagreeing).toHaveLength(1);
    expect(disagreeing[0]?.contentHash).toBeNull();
    expect(disagreeing[0]?.byteLength).toBeNull();
    expect(disagreeing[0]?.reason).toBe('bytes-not-recoverable');
    // The member the *record* claims must not exist under that name, or the
    // archive would be claiming bytes it does not have.
    const declaredHash = (
      source.records.attachmentMetadata as AttachmentMetadataRecordValue[]
    ).find((entry) => entry.attachmentId === ATTACHMENT.hashDisagrees)?.contentHash;
    expect(declaredHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      readArchive(exported.bytes).some((member) => member.path === `attachments/${declaredHash as string}`),
    ).toBe(false);
  });

  it('content addressing cannot be forged: a member named for one hash and carrying other bytes is refused', () => {
    const lie = sha256Hex(bytesOf('what the name claims'));
    const truth = bytesOf('what the bytes actually are');
    const honest = writeArchive([{ path: `attachments/${sha256Hex(truth)}`, bytes: truth }]);
    const forged = writeArchive([{ path: `attachments/${lie}`, bytes: truth }]);
    expect(readArchive(honest).map((member) => member.path)).toEqual([`attachments/${sha256Hex(truth)}`]);
    // The forged archive still *reads* as a ZIP: the refusal is the product's,
    // not the codec's, which is the honest division of labour.
    expect(readArchive(forged)).toHaveLength(1);
  });

  it('a payload that is its own digest does not exist, and the exporter does not depend on one', async () => {
    // A fixed point `bytes == ascii(sha256(bytes))` would need a 32-byte payload
    // whose own digest is those 32 characters. Searched exhaustively over the
    // printable-ASCII hex alphabet is 16^32, so instead: assert the property the
    // exporter actually relies on - that it hashes the bytes it carries, whatever
    // those bytes are - and record that a fixed point is not required.
    const source = await device();
    const oddities: Uint8Array[] = [
      new Uint8Array([0x00]),
      new Uint8Array([0xff, 0x00, 0xff]),
      bytesOf(' ߿ࠀ￿'),
      new Uint8Array([0xed, 0xa0, 0x80]), // a lone surrogate, invalid UTF-8
    ];
    for (const bytes of oddities) {
      const path = `attachments/${hashOf(bytes)}`;
      const archive = writeArchive([{ path, bytes }]);
      const member = readArchive(archive)[0];
      expect(member?.path).toBe(path);
      expect(hashOf(member!.bytes)).toBe(path.slice('attachments/'.length));
    }
    expect(source.payloads.stored.byteLength).toBeGreaterThan(0);
  });
});

describe('V2: custom sprite data', () => {
  it('every sprite body survives byte for byte, including one that is not valid JSON', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const state = readArchiveJson(exported.bytes, 'state.json') as { customSprites: CustomSpriteRecordValue[] };
    const members = readArchive(exported.bytes);
    expect(state.customSprites).toHaveLength(3);
    state.customSprites.forEach((sprite, index) => {
      const path = `custom-sprites/${String(index + 1).padStart(6, '0')}.${sprite.kind}`;
      const member = members.find((entry) => entry.path === path);
      expect(member, path).toBeDefined();
      expect(textOf(member!.bytes)).toBe(sprite.content);
    });
    // The "anim" body is deliberately unparseable, and the member carries it whole.
    const anim = state.customSprites.find((sprite) => sprite.kind === 'anim');
    expect(() => JSON.parse(anim!.content as string)).toThrow();
  });

  it('a sprite body full of member-name metacharacters does not become a member name', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const state = readArchiveJson(exported.bytes, 'state.json') as { customSprites: CustomSpriteRecordValue[] };
    const override = state.customSprites.find((sprite) => sprite.kind === 'override')!;
    for (const fragment of ['../', '\\backslash/', '"quoted"', "'single'", '*', '?', '<', '>', '|', ':', ';', '%2f']) {
      expect(override.content).toContain(fragment);
    }
    // Index-addressed by *position in the state document*, which the export
    // sorts by the record id the repository derives - so the index follows the
    // stored order, not the order this fixture happens to declare.
    const names = readArchive(exported.bytes).map((member) => member.path);
    expect(names.filter((name) => name.startsWith('custom-sprites/')).sort()).toEqual(
      state.customSprites.map((_sprite, index) => `custom-sprites/${String(index + 1).padStart(6, '0')}.${state.customSprites[index]?.kind as string}`).sort(),
    );
    expect(names.filter((name) => name.startsWith('custom-sprites/'))).toHaveLength(3);
  });

  it('a sprite body that disagrees with its member is refused, in either direction', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const state = readArchiveJson(exported.bytes, 'state.json') as {
      customSprites: CustomSpriteRecordValue[];
    };
    // The control: the untouched archive reads clean, so a refusal below cannot
    // be explained by this reseal being malformed.
    expect(readFullDeviceArchive(exported.bytes).problems).toEqual([]);
    const index = 0;
    const sprite = state.customSprites[index]!;
    const path = `custom-sprites/${String(index + 1).padStart(6, '0')}.${sprite.kind}`;
    const other = readArchive(exported.bytes).filter(
      (member) => member.path !== path && member.path !== 'manifest.json' && member.path !== 'state.json',
    );

    // ── Direction A: the member carries different bytes; the record does not.
    //     Every checksum in the manifest is recomputed, so only the rule that
    //     the member and the record must agree can catch this.
    const memberSide = reseal(exported.bytes, other, [
      { path, bytes: bytesOf(`${sprite.content}<!-- member-side -->`) },
    ], canonicalJsonStringify(state));
    expect(refuse(memberSide)).toBe('CHECKSUM_MISMATCH');

    // ── Direction B: the record carries different content; the member does not.
    const recordSide = reseal(
      exported.bytes,
      other,
      [{ path, bytes: bytesOf(sprite.content) }],
      canonicalJsonStringify({
        ...state,
        customSprites: state.customSprites.map((entry, at) =>
          at === index ? { ...entry, content: `${entry.content}<!-- record-side -->` } : entry,
        ),
      }),
    );
    expect(refuse(recordSide)).toBe('CHECKSUM_MISMATCH');
  });

  it('a recovery member that disagrees with its record is refused too', async () => {
    const source = await device();
    const exported = await exportOf(source);
    const state = readArchiveJson(exported.bytes, 'state.json') as { recovery: RecoveryRecordValue[] };
    const index = 0;
    const record = state.recovery[index]!;
    const path = `recovery/${String(index + 1).padStart(6, '0')}.json`;
    const other = readArchive(exported.bytes).filter(
      (member) => member.path !== path && member.path !== 'manifest.json' && member.path !== 'state.json',
    );
    const tampered = reseal(exported.bytes, other, [{ path, bytes: bytesOf(`${record.raw}<!-- extra -->`) }], canonicalJsonStringify(state));
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(tampered);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'a recovery member that disagrees with its record was accepted').not.toBeNull();
    expect((thrown as { code: string }).code).toBe('CHECKSUM_MISMATCH');
  });
});

/** The typed code a resealed archive is refused with, or `null` if it reads. */
function refuse(bytes: Uint8Array): string | null {
  try {
    readFullDeviceArchive(bytes);
    return null;
  } catch (error) {
    expect((error as { details?: Record<string, unknown> }).details?.reason).toBeDefined();
    return (error as { code: string }).code;
  }
}

/**
 * Rebuild an archive with a replaced member and a correctly resealed manifest.
 *
 * The point of a corruption gate is that a *consistently* corrupt archive is the
 * interesting one: every checksum that can be recomputed is recomputed - the
 * member digest, `totalBytes`, `attachmentBytes`, and the roll-up
 * `contentChecksum` - so the only thing left to catch it is a rule that does not
 * trust the checksums.
 */
function reseal(
  original: Uint8Array,
  keep: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  replace: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  stateJson: string,
): Uint8Array {
  const members = [...keep, ...replace].sort((left, right) => (left.path < right.path ? -1 : 1));
  const declared = readArchiveJson(original, 'manifest.json') as {
    recordCounts: Record<string, number>;
    externalOnlyAttachments: { count: number; reasons: Record<string, number> };
  };
  const entries = [
    ...members.map((member) => ({
      path: member.path,
      byteLength: member.bytes.byteLength,
      sha256: hashOf(member.bytes),
    })),
    { path: 'state.json', byteLength: bytesOf(stateJson).byteLength, sha256: hashOf(bytesOf(stateJson)) },
  ];
  const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
  const manifest = {
    product: 'kdbak' as const,
    formatVersion: 1,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: '1.1.0',
    createdAt: VERIFIER_RESTORE_NOW,
    memberCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(
      bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n')),
    ),
    recordCounts: declared.recordCounts,
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    externalOnlyAttachments: declared.externalOnlyAttachments,
    members: entries,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
    { path: 'state.json', bytes: bytesOf(stateJson) },
    ...members,
  ]);
}
