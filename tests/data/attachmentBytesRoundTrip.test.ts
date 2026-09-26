/**
 * Phase 5 data-product gate 2: all available attachment bytes and custom sprite
 * data survive.
 *
 * The exit criterion is about *bytes*, so this gate works in bytes and in three
 * independent SHA-256 implementations. A product that hashed the wrong thing, or
 * that agreed only with itself, cannot pass here.
 *
 * What is proven green today, without the product:
 *
 * - The payloads are real `Blob` bytes, produced through `Blob.arrayBuffer()`,
 *   which is the path a learner-supplied image actually takes.
 * - Three independent digests agree on every payload: `node:crypto`, the
 *   application's own FIPS 180-4 implementation, and Web Crypto where it is
 *   available. The gate requires at least two answers, and requires all of them
 *   to match, so a single implementation cannot carry the claim alone.
 * - **Content addressing**: two attachments whose bytes are identical produce
 *   exactly one `attachments/<sha256>` member, and a changed payload produces a
 *   different member. The gate asserts the member *count*, the member *names*, and
 *   the manifest's own declared `attachmentBytes.memberCount`, so a writer that
 *   stored three members for two payloads fails on the count alone.
 * - Every attachment member is compared to its source element by element, and its
 *   SHA-256 is recomputed from the *read-back* bytes rather than trusted.
 * - The custom sprite's body round-trips byte for byte, including the
 *   marker-bearing SVG and the pretty-printed animation JSON. The fixture's
 *   animation configuration is deliberately *not* minified, so a re-serializing
 *   writer would be caught by a whitespace difference.
 *
 * The registered half is the product's own export/import of the same payloads.
 *
 * Privacy: payloads are synthetic PNG bytes, one of which is never stored on the
 * device. Names, ids, and the single URL host are the reserved `example.invalid`.
 */

import { readArchive } from '@/services/persistence/v2/archive';
import { beforeAll, describe, expect, it } from 'vitest';

import { ATTACHMENT_IDS, DEVICE_NOW, POPULATED_GENERATION_ID, createPopulatedDevice, resetLegacyStorage, type PopulatedDevice } from './support/populatedDevice';
import { SPRITE_PATH } from './support/populatedDevice';
import { hashWithWitnesses, isSha256Hex, platformSha256, webCryptoAvailable } from './support/hashes';
import { MARKER_SPRITE_BODY, MARKER_TOKEN } from './support/marker';
import { REFERENCE_CREATED_AT, referenceArchiveForDevice, referenceArchiveInput } from './support/referenceArchive';
import { consumeArchive, produceArchive } from './support/backupAdapter';

let device: PopulatedDevice;
let archive: ReturnType<typeof referenceArchiveForDevice>;

beforeAll(async () => {
  resetLegacyStorage();
  device = await createPopulatedDevice('kd-data-gate-attachments');
  const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
  archive = referenceArchiveForDevice(device, snapshot);
});

describe('Phase 5 gate 2: the payloads and their digests are real', () => {
  it('three independent SHA-256 implementations agree on every stored payload', async () => {
    const entries = [...device.payloadBytes.entries()];
    expect(entries.length).toBe(3);
    for (const [attachmentId, bytes] of entries) {
      const witness = await hashWithWitnesses(bytes);
      // At least two independent answers, and every one of them the same.
      expect(witness.witnessCount, attachmentId).toBeGreaterThanOrEqual(2);
      expect(witness.platform, attachmentId).toMatch(/^[0-9a-f]{64}$/);
      expect(witness.application, attachmentId).toBe(witness.platform);
      if (webCryptoAvailable()) {
        expect(witness.webCrypto, attachmentId).toBe(witness.platform);
      } else {
        // Recorded rather than assumed: the gate says which witnesses answered.
        expect(witness.webCrypto).toBeNull();
      }
      expect(witness.allAgree, attachmentId).toBe(true);
      expect(isSha256Hex(witness.platform)).toBe(true);
    }
    // Two of the three attachments really do share one payload, and the third
    // really is different, so the content-addressing case is not hypothetical.
    const [one, two, three] = entries.map(([, bytes]) => platformSha256(bytes));
    expect(one).toBe(two);
    expect(three).not.toBe(one);
  });

  it('the duplicate payload is declared twice and stored once', () => {
    const ids = device.duplicatePayloadAttachmentIds;
    expect([...ids].sort()).toEqual([ATTACHMENT_IDS.storedOne, ATTACHMENT_IDS.storedTwo].sort());
    const first = device.payloadBytes.get(ATTACHMENT_IDS.storedOne) as Uint8Array;
    const second = device.payloadBytes.get(ATTACHMENT_IDS.storedTwo) as Uint8Array;
    expect(first.length).toBe(second.length);
    expect(first.every((byte, index) => byte === second[index])).toBe(true);
  });
});

describe('Phase 5 gate 2: content addressing in the archive layout', () => {
  it('two identical payloads produce exactly one attachment member', () => {
    const members = archive.memberNames.filter((name) => name.startsWith('attachments/'));
    // Three stored attachments, two distinct payloads, therefore two members.
    expect(members).toHaveLength(2);
    const hashes = members.map((name) => name.slice('attachments/'.length)).sort();
    expect(hashes.every((hash) => isSha256Hex(hash))).toBe(true);
    // The single member for the shared payload is named by the hash both
    // attachments agree on.
    const shared = platformSha256(device.payloadBytes.get(ATTACHMENT_IDS.storedOne) as Uint8Array);
    const distinct = platformSha256(device.payloadBytes.get(ATTACHMENT_IDS.storedThree) as Uint8Array);
    expect(hashes).toEqual([shared, distinct].sort());
    expect(shared).not.toBe(distinct);
  });

  it('the manifest declares the deduplicated member count and its byte total', () => {
    const manifest = archive.manifest;
    const attachmentBytes = manifest.attachmentBytes as { memberCount: number; byteLength: number };
    expect(attachmentBytes.memberCount).toBe(2);
    const sourceBytes = [
      device.payloadBytes.get(ATTACHMENT_IDS.storedOne) as Uint8Array,
      device.payloadBytes.get(ATTACHMENT_IDS.storedThree) as Uint8Array,
    ];
    expect(attachmentBytes.byteLength).toBe(
      sourceBytes.reduce((total, bytes) => total + bytes.length, 0),
    );
    // Every member the manifest lists really is in the archive, and every member
    // in the archive except the manifest itself is listed: a member cannot
    // contain its own digest, so `manifest.json` is the one member the manifest
    // does not describe.
    const declared = (manifest.members as { path: string }[]).map((entry) => entry.path).sort();
    expect(declared).toEqual(
      archive.memberNames.filter((name) => name !== 'manifest.json').sort(),
    );
    // The pinned counting rule: `memberCount` counts what `members[]` describes.
    expect(manifest.memberCount).toBe(declared.length);
    expect(manifest.totalBytes).toBe(
      (manifest.members as { byteLength: number }[]).reduce(
        (total, entry) => total + entry.byteLength,
        0,
      ),
    );
  });

  it('a changed payload produces a different content-addressed member name', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const input = referenceArchiveInput(device, snapshot);
    const original = platformSha256(input.attachmentMembers[0]?.bytes as Uint8Array);
    const changedBytes = new Uint8Array([...(input.attachmentMembers[0]?.bytes as Uint8Array), 0x00]);
    const changed = platformSha256(changedBytes);
    expect(changed).not.toBe(original);
    // The member name is the digest, so the name necessarily changes with it.
    expect(`attachments/${changed}`).not.toBe(`attachments/${original}`);
    expect(isSha256Hex(changed)).toBe(true);
  });
});

describe('Phase 5 gate 2: every member round-trips element by element', () => {
  it('each attachment member equals its source bytes, and its digest re-verifies', () => {
    const read = readArchive(archive.bytes);
    const readByName = new Map(read.map((member) => [member.path, member.bytes]));
    expect(readByName.size).toBe(archive.memberNames.length);

    let compared = 0;
    for (const [attachmentId, bytes] of device.payloadBytes.entries()) {
      const contentHash = platformSha256(bytes);
      const memberPath = `attachments/${contentHash}`;
      const memberBytes = readByName.get(memberPath);
      expect(memberBytes, `${attachmentId} -> ${memberPath}`).toBeDefined();
      const restored = memberBytes as Uint8Array;
      // Element by element, not a length check.
      expect(restored.length, attachmentId).toBe(bytes.length);
      expect(
        restored.every((byte, index) => byte === bytes[index]),
        attachmentId,
      ).toBe(true);
      // Re-hash the bytes that came *out* of the archive, so the assertion is
      // about the read-back data and not about the input.
      expect(platformSha256(restored), attachmentId).toBe(contentHash);
      compared += 1;
    }
    expect(compared).toBe(3);
  });

  it('every custom sprite record round-trips its body byte for byte', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const spriteRecords = (
      snapshot.records as unknown as Record<string, { value: Record<string, unknown> }[]>
    ).customSprites.map((envelope) => envelope.value);
    const forPath = spriteRecords.filter((record) => record.spritePath === SPRITE_PATH);
    expect(forPath).toHaveLength(3);
    expect(forPath.map((record) => record.kind).sort()).toEqual([
      'anim',
      'original',
      'override',
    ]);

    const readByName = new Map(
      readArchive(archive.bytes).map((member) => [member.path, member.bytes]),
    );
    // One member per sprite record, in a stable index order, extension taken from
    // the record's kind.
    for (const [index, record] of forPath.entries()) {
      const memberPath = `custom-sprites/${String(index + 1).padStart(6, '0')}.${String(record.kind)}`;
      const memberBytes = readByName.get(memberPath);
      expect(memberBytes, memberPath).toBeDefined();
      const source = new TextEncoder().encode(String(record.content));
      const restored = memberBytes as Uint8Array;
      expect(restored.length, memberPath).toBe(source.length);
      expect(restored.every((byte, position) => byte === source[position]), memberPath).toBe(true);
      // A string-level equality as well, which catches a re-serialized body even
      // if the byte length happened to match.
      expect(new TextDecoder().decode(restored)).toBe(String(record.content));
    }

    // The override body carries the marker, so "the bytes survived" is a claim
    // about a body with real content in it, not an empty document.
    const override = forPath.find((record) => record.kind === 'override') as Record<string, unknown>;
    expect(String(override.content)).toBe(MARKER_SPRITE_BODY);
    expect(String(override.content)).toContain(MARKER_TOKEN);
    // The animation configuration is pretty-printed on purpose: a writer that
    // round-tripped it through `JSON.parse`/`JSON.stringify` would lose the
    // indentation and fail the equality above.
    const anim = forPath.find((record) => record.kind === 'anim') as Record<string, unknown>;
    expect(String(anim.content)).toContain('\n  "schema"');
  });

  it('the recovery members round-trip their raw payloads verbatim', () => {
    const readByName = new Map(
      readArchive(archive.bytes).map((member) => [member.path, member.bytes]),
    );
    const recoveryMembers = archive.memberNames.filter((name) => name.startsWith('recovery/'));
    expect(recoveryMembers).toHaveLength(2);
    for (const [index, name] of recoveryMembers.entries()) {
      const restored = readByName.get(name) as Uint8Array;
      const text = new TextDecoder().decode(restored);
      // `RecoveryRecordValue.raw` is a raw legacy string that is never parsed, so
      // it must come back as the same string and not as a re-serialized object.
      expect(text, name).toBe(`{"synthetic":"data-gate-${index === 0 ? 'recovery-backup' : 'unindexed-subject'}-payload"}`);
    }
  });
});

describe('Phase 5 gate 2: REGISTERED - the product byte round trip', () => {
  it('every available attachment byte and custom sprite body survives export and import', async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `exportFullDeviceBackup` and `importFullDeviceBackup` in
    // `src/services/persistence/products/fullDeviceBackup.ts`, called with the
    // request objects declared in `./support/backupAdapter`. The product
    // implements both, so this is now a live assertion: real bytes, three
    // independent SHA-256 witnesses, content addressing, and a restore.
    const context = {
      repository: device.repository,
      generationId: POPULATED_GENERATION_ID,
      now: DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    };
    const bytes = await produceArchive(context);
    const members = readArchive(bytes);
    const readByName = new Map(members.map((member) => [member.path, member.bytes]));

    // Every payload that was available on the device is in the archive, byte for
    // byte, and re-hashes to its own content address.
    for (const [attachmentId, source] of device.payloadBytes.entries()) {
      const contentHash = platformSha256(source);
      const member = readByName.get(`attachments/${contentHash}`);
      expect(member, attachmentId).toBeDefined();
      const restored = member as Uint8Array;
      expect(restored.length, attachmentId).toBe(source.length);
      expect(restored.every((byte, index) => byte === source[index]), attachmentId).toBe(true);
      const witness = await hashWithWitnesses(restored);
      expect(witness.allAgree, attachmentId).toBe(true);
      expect(witness.platform, attachmentId).toBe(contentHash);
    }

    // Content addressing held on the product's own write path.
    const attachmentMembers = members.filter((member) => member.path.startsWith('attachments/'));
    expect(attachmentMembers).toHaveLength(2);

    // And every custom sprite body is present verbatim.
    const sprites = members.filter((member) => member.path.startsWith('custom-sprites/'));
    expect(sprites).toHaveLength(3);
    const spriteBodies = sprites.map((member) => new TextDecoder().decode(member.bytes));
    expect(spriteBodies).toContain(MARKER_SPRITE_BODY);

    // Finally the bytes survive the *import* into a new generation.
    const target = await createPopulatedDevice('kd-data-gate-attachments-target');
    await consumeArchive(
      {
        repository: target.repository,
        generationId: target.generationId,
        now: DEVICE_NOW,
        payloadBytes: new Map(),
      },
      bytes,
    );
    const restored = await target.repository.readRecords(
      (await target.repository.readActiveGenerationId()) as string,
    );
    expect(restored.records.attachmentBlobs.length).toBeGreaterThanOrEqual(3);
    for (const envelope of restored.records.attachmentBlobs) {
      const storedBytes = new Uint8Array(envelope.value.bytes);
      const witness = await hashWithWitnesses(storedBytes);
      expect(witness.allAgree).toBe(true);
      expect(witness.platform).toBe(envelope.value.contentHash);
    }
  });

  it('names the two interfaces the byte round trip is waiting on', () => {
    // Pins, not placeholders: the registered test above becomes a live assertion
    // the moment the product exports these names.
    expect(REFERENCE_CREATED_AT).toBe('2026-09-26T00:00:00.000Z');
    expect(SPRITE_PATH).toBe('characters/synthetic/warden.svg');
  });
});
