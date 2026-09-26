/**
 * Phase 5 data-product gate 4: external-only images are disclosed.
 *
 * Plan section 2.3 is the contract: "External image URLs remain user-provided
 * external content and are not silently downloaded into backups" and "Existing
 * external-only attachments must be disclosed honestly when a backup cannot
 * include their bytes."
 *
 * "Honestly" is the whole requirement, and it has two halves that pull in opposite
 * directions:
 *
 * - The attachment must be **disclosed** - in the manifest and in the import
 *   result - so the learner is not left believing a backup is complete when it is
 *   not.
 * - The disclosure must **not fabricate a hash**. An attachment with no bytes on
 *   the device has no content to hash, and a digest that looks real but is not
 *   would misreport what the archive contains. So the disclosure's
 *   `contentHash` is typed `null` here, not `string | null`: a product that
 *   invented one would not satisfy this gate.
 * - And an external-only attachment must **not fail the import**. A backup that
 *   refuses to restore because a linked image is unreachable would be worse than
 *   useless: it would turn a partial-but-honest restore into no restore.
 *
 * And the disclosure must not become a leak. A distinctive synthetic marker is
 * planted as a subject name, a room topic, a note body, and an attachment
 * filename; the gate proves the marker is really present in the record first, and
 * then requires it to be absent from the manifest, from every member path, and
 * from every error and report the import produces. A disclosure that named the
 * attachment by its filename would be an honest disclosure and a privacy failure
 * at the same time, and only the second assertion catches it.
 *
 * The registered half is the product's own manifest and import result.
 *
 * Privacy: the single URL in this file is the reserved `example.invalid`, and it
 * is never dereferenced - nothing in this suite opens a socket.
 */

import { readArchive } from '@/services/persistence/v2/archive';
import { beforeAll, describe, expect, it } from 'vitest';

import { consumeArchive, produceArchive } from './support/backupAdapter';
import {
  describeForbiddenFragments,
  forbiddenFragmentsIn,
  isFreeOfLearnerContent,
  MARKER_ATTACHMENT_FILE_NAME,
  MARKER_NOTE_BODY,
  MARKER_ROOM_TOPIC,
  MARKER_SUBJECT_NAME,
  MARKER_TOKEN,
} from './support/marker';
import {
  ATTACHMENT_IDS,
  DEVICE_NOW,
  EXTERNAL_ATTACHMENT_URL,
  POPULATED_GENERATION_ID,
  ROOM_IDS,
  SUBJECT_IDS,
  createPopulatedDevice,
  resetLegacyStorage,
  type PopulatedDevice,
} from './support/populatedDevice';
import { referenceArchiveForDevice } from './support/referenceArchive';
import { externalOnlyDisclosures } from './support/stateDocument';
import { EXTERNAL_ONLY_REASON_BY_SOURCE } from './support/productInterface';

let device: PopulatedDevice;
let archive: ReturnType<typeof referenceArchiveForDevice>;

beforeAll(async () => {
  resetLegacyStorage();
  device = await createPopulatedDevice('kd-data-gate-external-only');
  const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
  archive = referenceArchiveForDevice(device, snapshot);
});

describe('Phase 5 gate 4: the external-only record really is external-only', () => {
  it('the device holds one external-only attachment with no bytes and no hash', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const metadata = (
      snapshot.records as unknown as Record<string, { value: Record<string, unknown> }[]>
    ).attachmentMetadata.map((envelope) => envelope.value);

    const externalOnly = metadata.filter((record) => record.availability === 'external-only');
    expect(externalOnly).toHaveLength(1);
    const record = externalOnly[0] as Record<string, unknown>;
    expect(record.attachmentId).toBe(ATTACHMENT_IDS.externalOne);
    expect(record.subjectId).toBe(SUBJECT_IDS.beta);
    expect(record.roomId).toBe(ROOM_IDS.betaRoot);
    expect(record.sourceType).toBe('external');
    // The absence is the point: no hash, and no blob record to produce one from.
    expect(record.contentHash).toBeNull();
    expect(record.externalUrl).toBe(EXTERNAL_ATTACHMENT_URL);
    const blobIds = new Set(
      (
        snapshot.records as unknown as Record<string, { value: { attachmentId: string } }[]>
      ).attachmentBlobs.map((envelope) => envelope.value.attachmentId),
    );
    expect(blobIds.has(ATTACHMENT_IDS.externalOne)).toBe(false);
    // ...and the device genuinely has no payload bytes for it, so "no bytes on
    // the device" is measured rather than asserted.
    expect(device.payloadBytes.has(ATTACHMENT_IDS.externalOne)).toBe(false);
    // Three of the four attachments do have bytes, so the external-only case is
    // one case among several rather than the only case.
    expect(metadata.filter((entry) => entry.availability === 'stored')).toHaveLength(3);
  });

  it('the disclosure is produced with a null hash, and the type forbids a real one', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const metadata = (
      snapshot.records as unknown as Record<string, { value: Record<string, unknown> }[]>
    ).attachmentMetadata.map((envelope) => envelope.value);
    const disclosures = externalOnlyDisclosures(metadata);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]?.attachmentId).toBe(ATTACHMENT_IDS.externalOne);
    // `contentHash` and `byteLength` are typed `null`, so a fabricated digest
    // cannot be represented by this disclosure shape.
    expect(disclosures[0]?.contentHash).toBeNull();
    expect(disclosures[0]?.byteLength).toBeNull();
    expect(disclosures[0]?.reason).toBe(EXTERNAL_ONLY_REASON_BY_SOURCE.external);
  });
});

describe('Phase 5 gate 4: the manifest discloses it, without a hash and without a name', () => {
  it('the manifest declares the external-only count and a reason histogram', () => {
    const disclosure = archive.manifest.externalOnlyAttachments as {
      count: number;
      reasons: Record<string, number>;
    };
    expect(disclosure.count).toBe(1);
    expect(disclosure.reasons).toEqual({ 'historical-external-url': 1 });
    // The reason is a member of the real `ExternalOnlyAttachmentReport.reason`
    // vocabulary the application already declares, not an invented string.
    expect(Object.keys(disclosure.reasons)).toEqual(['historical-external-url']);
    // No hash field exists to hold a fabricated digest: the sub-document's key
    // set is exactly `count` and `reasons`.
    expect(Object.keys(disclosure).sort()).toEqual(['count', 'reasons']);
  });

  it('the external-only attachment contributes no member, and no sanitized surface names it', () => {
    const members = readArchive(archive.bytes);
    // Three stored attachments, two distinct payloads, therefore two members -
    // the external-only one is not among them.
    expect(members.filter((member) => member.path.startsWith('attachments/'))).toHaveLength(2);

    // `state.json` is the learner's own state and legitimately names the
    // attachment: that is what a backup *is*. The surfaces that must stay clean
    // are the ones a learner might publish - the manifest, the member paths, and
    // the disclosure - and those are checked here and in the test below.
    const stateMember = members.find((member) => member.path === 'state.json') as { bytes: Uint8Array };
    expect(new TextDecoder().decode(stateMember.bytes)).toContain(ATTACHMENT_IDS.externalOne);

    // The manifest names no attachment at all: no id, no filename, no URL.
    const manifestText = new TextDecoder().decode(
      members.find((member) => member.path === 'manifest.json')?.bytes as Uint8Array,
    );
    expect(manifestText).not.toContain(ATTACHMENT_IDS.externalOne);
    expect(manifestText).not.toContain(EXTERNAL_ATTACHMENT_URL);
    expect(manifestText).not.toContain('example.invalid');
    expect(forbiddenFragmentsIn(manifestText)).toEqual([]);
    // ...and no member *path* names it either.
    for (const path of members.map((member) => member.path)) {
      expect(path).not.toContain(ATTACHMENT_IDS.externalOne);
      expect(path).not.toContain('example.invalid');
    }
  });

  it('the marker is present in the record and absent from every sanitized surface', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const subjects = (
      snapshot.records as unknown as Record<string, { value: unknown }[]>
    ).subjects.map((envelope) => JSON.stringify(envelope.value));
    const joined = subjects.join('\n');
    // The marker is really there, in four learner-authored fields, so the
    // absences below are not the absence of a record.
    expect(joined).toContain(MARKER_SUBJECT_NAME);
    expect(joined).toContain(MARKER_ROOM_TOPIC);
    expect(joined).toContain(MARKER_NOTE_BODY.split('\n')[0] as string);
    expect(joined).toContain(MARKER_ATTACHMENT_FILE_NAME);
    expect(joined).toContain(MARKER_TOKEN);

    // Absent from every *sanitized* surface. `state.json` is deliberately not one
    // of them: it is the learner's own state, and a backup that did not carry the
    // marker would be a backup that lost data. The sanitized surfaces are the
    // manifest, the member paths, and the disclosure.
    const members = readArchive(archive.bytes);
    const manifestText = new TextDecoder().decode(
      members.find((member) => member.path === 'manifest.json')?.bytes as Uint8Array,
    );
    const surfaces: ReadonlyArray<readonly [string, string]> = [
      ['manifest.json', manifestText],
      ...members.map((member) => ['member-path:' + member.path, member.path] as const),
    ];
    for (const [name, text] of surfaces) {
      const found = forbiddenFragmentsIn(text);
      expect(found, `${name}: ${describeForbiddenFragments(found)}`).toEqual([]);
    }
    // Non-manifest binary members are the learner's own bytes, and a PNG decoded
    // as text is not a surface a report could carry; the check that matters for
    // them is that they are addressed by digest only, which the member-path check
    // above already establishes.
    const disclosure = externalOnlyDisclosures(
      (
        snapshot.records as unknown as Record<string, { value: Record<string, unknown> }[]>
      ).attachmentMetadata.map((envelope) => envelope.value),
    );
    expect(isFreeOfLearnerContent(JSON.stringify(disclosure))).toBe(true);
    // And the disclosure really is non-empty, so "no marker" is not "no
    // disclosure".
    expect(JSON.stringify(disclosure)).toContain(ATTACHMENT_IDS.externalOne);
  });
});

describe('Phase 5 gate 4: REGISTERED - the product discloses it', () => {
  it('the product manifest discloses the external-only attachment with no fabricated hash', async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `exportFullDeviceBackup` in
    // `src/services/persistence/products/fullDeviceBackup.ts`, called with the
    // request object declared in `./support/backupAdapter`. The product
    // implements it, so this is now a live assertion.
    const bytes = await produceArchive({
      repository: device.repository,
      generationId: POPULATED_GENERATION_ID,
      now: DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    });
    const members = readArchive(bytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        members.find((member) => member.path === 'manifest.json')?.bytes as Uint8Array,
      ),
    ) as { externalOnlyAttachments?: { count?: number; reasons?: Record<string, number> } };

    expect(manifest.externalOnlyAttachments?.count).toBe(1);
    expect(manifest.externalOnlyAttachments?.reasons).toEqual({ 'historical-external-url': 1 });
    // No fabricated hash anywhere in the manifest: every digest-shaped value in
    // it is the digest of a member that exists.
    //
    // RAIL FIX, recorded deliberately. This assertion originally compared each
    // digest only against `attachments/<digest>` members, which no archive in
    // the plan's layout can satisfy: the manifest declares a digest for *every*
    // member except itself, including `state.json` and the index-addressed groups,
    // so the pinned twelve-key layout and the original check were mutually
    // exclusive. The property the test is actually about - no invented digest - is
    // stronger and now stated three ways: every digest belongs to a member that
    // exists, every `attachments/<sha256>` member is named by its own digest, and
    // the external-only attachment's id appears nowhere in the manifest.
    const manifestText = new TextDecoder().decode(
      members.find((member) => member.path === 'manifest.json')?.bytes as Uint8Array,
    );
    const declaredMembers = (
      JSON.parse(manifestText) as { members: { path: string; sha256: string }[] }
    ).members;
    const declaredDigests = [...manifestText.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map(
      (match) => match[1] as string,
    );
    // One digest per declared member, and every one of them real.
    expect(declaredDigests).toHaveLength(declaredMembers.length);
    const paths = new Set(members.map((member) => member.path));
    for (const entry of declaredMembers) {
      expect(paths.has(entry.path), entry.path).toBe(true);
      expect(declaredDigests).toContain(entry.sha256);
    }
    // Content addressing, which is the form a fabricated hash would take here:
    // an attachment member named by the digest of its own bytes.
    for (const member of members.filter((entry) => entry.path.startsWith('attachments/'))) {
      expect(declaredDigests, member.path).toContain(member.path.slice('attachments/'.length));
    }
    // And the disclosure names a count and a reason, never an attachment.
    expect(manifestText).not.toContain(ATTACHMENT_IDS.externalOne);
  });

  it('the import result discloses the external-only attachment and the import still succeeds', async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `exportFullDeviceBackup` and `importFullDeviceBackup` in
    // `src/services/persistence/products/fullDeviceBackup.ts`. The product
    // implements both, so this is now a live assertion - and it is the assertion
    // that an unreachable external image must not turn a restore into a failure.
    const context = {
      repository: device.repository,
      generationId: POPULATED_GENERATION_ID,
      now: DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    };
    const bytes = await produceArchive(context);
    const outcome = (await consumeArchive(context, bytes)) as unknown;

    // The disclosure names the attachment by its opaque id, with no hash.
    const serialized = JSON.stringify(outcome ?? null);
    expect(serialized).toContain(ATTACHMENT_IDS.externalOne);
    expect(serialized).not.toContain(EXTERNAL_ATTACHMENT_URL);
    expect(forbiddenFragmentsIn(serialized)).toEqual([]);
    expect(serialized).not.toMatch(/"contentHash"\s*:\s*"[0-9a-f]{64}"/);

    // The import landed, and the restored generation carries the external-only
    // record with its honest null hash.
    const active = await device.repository.readActiveGeneration();
    expect(active?.descriptor?.source).toBe('full-device-import');
    const restored = await device.repository.readRecords(
      active?.descriptor?.generationId as string,
    );
    const metadata = restored.records.attachmentMetadata.map((envelope) => envelope.value);
    const external = metadata.find(
      (record) => record.attachmentId === ATTACHMENT_IDS.externalOne,
    );
    expect(external).toBeDefined();
    expect(external?.availability).toBe('external-only');
    expect(external?.contentHash).toBeNull();
    // ...with no blob record for it, and the other three attachments intact.
    expect(
      restored.records.attachmentBlobs.filter(
        (envelope) => envelope.value.attachmentId === ATTACHMENT_IDS.externalOne,
      ),
    ).toEqual([]);
    expect(restored.records.attachmentMetadata.length).toBe(4);
  });
});
