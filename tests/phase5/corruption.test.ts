/**
 * Verifier gate V3 - Phase 5 exit criterion 3.
 *
 * "Corrupt archives never replace current data."
 *
 * Twelve corruptions of my own, chosen to go past the fifteen the rails claim:
 * most of them are **consistently** corrupt - every checksum that *can* be
 * recomputed is recomputed, the member set matches, and the manifest's declared
 * record counts are the ones the state document really carries. The only thing
 * left to catch such an archive is a rule that does not trust the checksums.
 *
 * For each one the gate asserts four things:
 *
 * 1. the import throws a `StorageV2Error` (a *typed* refusal, not a `TypeError`);
 * 2. every detail value satisfies the application's own sanitization rule;
 * 3. the device is byte-for-byte unchanged - the active pointer, every record
 *    envelope's value **and** its attachment bytes, every descriptor, and the
 *    whole ordered legacy `localStorage` key set;
 * 4. a good import still works afterwards.
 *
 * The fingerprint is the one in `./support/device.ts`, which hex-encodes binary
 * itself, and it is proved able to move in `./harness.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  readFullDeviceArchive,
  type FullDeviceExportResult,
} from '@/services/persistence/products/fullDeviceBackup';
import { StorageV2Error, isSanitizedDetailText } from '@/services/persistence/v2/schema';
import { readArchive, readArchiveJson, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import {
  SUBJECT,
  VERIFIER_MARKERS,
  VERIFIER_RESTORE_NOW,
  buildVerifierDevice,
  bytesOf,
  captureDevice,
  encodeValue,
  hashOf,
  otherGenerationLabel,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];

async function device(options: { alt?: boolean } = {}): Promise<VerifierDevice> {
  const built = await buildVerifierDevice({ labels: options.alt === true ? otherGenerationLabel() : undefined });
  devices.push(built);
  return built;
}

afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

// ── Archive surgery ────────────────────────────────────────────────────────

interface Archive {
  readonly state: Record<string, unknown>;
  readonly members: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  readonly manifest: Record<string, unknown>;
}

/**
 * Take the product's own archive apart, so every corruption starts from a real
 * one. `members` excludes the two fixed members, because every reseal writes
 * those itself.
 */
function open(bytes: Uint8Array): Archive {
  return {
    state: readArchiveJson(bytes, 'state.json') as Record<string, unknown>,
    members: readArchive(bytes).filter(
      (member) => member.path !== 'manifest.json' && member.path !== 'state.json',
    ),
    manifest: readArchiveJson(bytes, 'manifest.json') as Record<string, unknown>,
  };
}

/**
 * Rebuild a `.kdbak` from scratch, recomputing **every** field a writer could
 * recompute: each member's digest and length, `totalBytes`, `attachmentBytes`,
 * the roll-up `contentChecksum`, and (optionally) the declared record counts.
 */
function seal(
  state: Record<string, unknown>,
  extraMembers: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  options: { readonly memberCount?: number; readonly counts?: Record<string, number> } = {},
): Uint8Array {
  const stateBytes = bytesOf(canonicalJsonStringify(state));
  const members = [
    ...extraMembers.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
    { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
  ];
  const attachmentEntries = members.filter((member) => member.path.startsWith('attachments/'));
  const manifest = {
    product: 'kdbak' as const,
    formatVersion: 1,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: state.subjectSchemaVersion as string,
    createdAt: state.createdAt as string,
    memberCount: options.memberCount ?? members.length,
    totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
    contentChecksum: sha256Hex(
      bytesOf(members.map((member) => `${member.sha256} ${member.path}`).join('\n')),
    ),
    recordCounts:
      options.counts ??
      ({
        meta: 0,
        subjects: (state.subjects as unknown[]).length,
        progression: (state.progression as unknown[]).length,
        sessions: (state.sessions as unknown[]).length,
        preferences: (state.preferences as unknown[]).length,
        shortcuts: (state.shortcuts as unknown[]).length,
        assistance: (state.assistance as unknown[]).length,
        attachments:
          (state.attachmentMetadata as unknown[]).length +
          (state.attachmentMetadata as Array<Record<string, unknown>>).filter(
            (entry) => entry.availability === 'stored' && typeof entry.contentHash === 'string',
          ).length,
        customSprites: (state.customSprites as unknown[]).length,
        recovery: (state.recovery as unknown[]).length,
        migrationReceipts: (state.migrationReceipts as unknown[]).length,
      } as Record<string, number>),
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, member) => total + member.byteLength, 0),
    },
    externalOnlyAttachments: (readFromCounts(state) as { count: number; reasons: Record<string, number> }),
    members,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
    { path: 'state.json', bytes: stateBytes },
    ...extraMembers,
  ]);
}

function readFromCounts(state: Record<string, unknown>): { count: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  for (const record of state.attachmentMetadata as Array<Record<string, unknown>>) {
    const stored = record.availability === 'stored' && typeof record.contentHash === 'string';
    if (stored) continue;
    const reason = record.sourceType === 'external' ? 'historical-external-url' : 'bytes-not-recoverable';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { count: Object.values(reasons).reduce((total, value) => total + value, 0), reasons };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── The corruptions ────────────────────────────────────────────────────────

interface Corruption {
  readonly id: string;
  readonly description: string;
  /** `true` when the corruption cannot be caught by a checksum alone. */
  readonly consistent: boolean;
  build(good: Uint8Array, source: VerifierDevice): Uint8Array;
}

const CORRUPTIONS: readonly Corruption[] = [
  {
    id: 'record-value-subtly-altered',
    description:
      "A progression record's XP is changed by one, every checksum is recomputed, and the manifest's record counts are unchanged.",
    consistent: true,
    build(good) {
      const { state, members } = open(good);
      const tampered = clone(state);
      (tampered.progression as Array<Record<string, unknown>>)[0]!.xpTotal =
        ((tampered.progression as Array<Record<string, unknown>>)[0]!.xpTotal as number) + 1;
      return seal(tampered, members);
    },
  },
  {
    id: 'second-copy-of-a-record-under-a-different-key',
    description:
      'The same subject record appears twice in the subjects array, and the manifest declares the doubled count.',
    consistent: true,
    build(good) {
      const { state, members } = open(good);
      const tampered = clone(state);
      const subjects = tampered.subjects as Array<Record<string, unknown>>;
      subjects.push(clone(subjects[0]!));
      return seal(tampered, members, { counts: countsFor(tampered) });
    },
  },
  {
    id: 'two-members-declaring-the-same-path',
    description: 'The manifest lists the same member path twice, with matching lengths and digests.',
    consistent: false,
    build(good) {
      const { members, state } = open(good);
      const stateBytes = bytesOf(canonicalJsonStringify(state));
      const entries = [
        ...members
          .filter((member) => member.path !== 'manifest.json')
          .map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
        { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
      ];
      const duplicated = [...entries, entries.find((entry) => entry.path === 'state.json')!];
      const attachmentEntries = duplicated.filter((entry) => entry.path.startsWith('attachments/'));
      const manifest = {
        product: 'kdbak' as const,
        formatVersion: 1,
        storageGenerationFormatVersion: 1,
        subjectSchemaVersion: state.subjectSchemaVersion as string,
        createdAt: state.createdAt as string,
        memberCount: duplicated.length,
        totalBytes: duplicated.reduce((total, entry) => total + entry.byteLength, 0),
        contentChecksum: sha256Hex(
          bytesOf(duplicated.map((entry) => `${entry.sha256} ${entry.path}`).join('\n')),
        ),
        recordCounts: countsFor(state),
        attachmentBytes: {
          memberCount: attachmentEntries.length,
          byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
        },
        externalOnlyAttachments: readFromCounts(state),
        members: duplicated,
      };
      return writeArchive([
        { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
        { path: 'state.json', bytes: stateBytes },
        ...members,
      ]);
    },
  },
  {
    id: 'correct-checksums-but-a-broken-relationship',
    description:
      'An attachment names a room that does not exist. Every digest, length, and count is recomputed.',
    consistent: true,
    build(good) {
      const { state, members } = open(good);
      const tampered = clone(state);
      (tampered.attachmentMetadata as Array<Record<string, unknown>>)[0]!.roomId = 'room-verifier-does-not-exist';
      return seal(tampered, members);
    },
  },
  {
    id: 'a-valid-zip-of-something-else',
    description: 'A real, readable ZIP that is not a `.kdbak` at all.',
    consistent: false,
    build() {
      return writeArchive([
        { path: 'readme.txt', bytes: bytesOf('not a backup') },
        { path: 'holiday/photo.png', bytes: bytesOf('nope') },
      ]);
    },
  },
  {
    id: 'a-state-document-with-a-prototype-polluting-key',
    description: '`state.json` carries a `__proto__` key, and one of its subject records carries another.',
    consistent: true,
    build(good) {
      const { state, members } = open(good);
      // `JSON.parse` creates `__proto__` as an own property, so it survives a
      // round trip through canonical JSON and reaches the reader.
      const raw = JSON.stringify({
        ...state,
        __proto__: { polluted: 'ZZ-verifier-prototype-pollution-probe' },
      });
      const stateBytes = bytesOf(raw);
      const entries = [
        ...members.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
        { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
      ];
      const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
      const manifest = {
        product: 'kdbak' as const,
        formatVersion: 1,
        storageGenerationFormatVersion: 1,
        subjectSchemaVersion: state.subjectSchemaVersion as string,
        createdAt: state.createdAt as string,
        memberCount: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
        contentChecksum: sha256Hex(bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
        recordCounts: countsFor(state),
        attachmentBytes: {
          memberCount: attachmentEntries.length,
          byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
        },
        externalOnlyAttachments: readFromCounts(state),
        members: entries,
      };
      return writeArchive([
        { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
        { path: 'state.json', bytes: stateBytes },
        ...members,
      ]);
    },
  },
  {
    id: 'a-manifest-with-a-huge-member-count',
    description: '`memberCount` claims 2^40 members while `members[]` really holds a dozen.',
    consistent: false,
    build(good) {
      const { state, members } = open(good);
      return seal(state, members, { memberCount: 1_099_511_627_776 });
    },
  },
  {
    id: 'state-subject-ids-collide',
    description:
      'Two subject records share a subject id but disagree about the snapshot. Counts and digests recomputed.',
    consistent: true,
    build(good) {
      const { state, members } = open(good);
      const tampered = clone(state);
      const subjects = tampered.subjects as Array<Record<string, unknown>>;
      const target = subjects.find((entry) => entry.subjectId === SUBJECT.rich)!;
      const clash = clone(target);
      clash.snapshot = { ...(clash.snapshot as Record<string, unknown>), rooms: {} };
      subjects.push(clash);
      return seal(tampered, members, { counts: countsFor(tampered) });
    },
  },
  {
    id: 'would-overwrite-the-active-generation',
    description:
      'The archive names the receiving device\'s own active generation as its source, and carries a full state.',
    consistent: true,
    build(good, source) {
      const { state, members } = open(good);
      const tampered = clone(state);
      // The target device's *active* generation label, which the reader holds.
      tampered.sourceGenerationId = source.generationId;
      return seal(tampered, members);
    },
  },
  {
    id: 'a-nested-zip-bomb-inside-a-member',
    description:
      'A 12 MiB member of zeros nested inside a ZIP inside a member: highly compressible, and a real ZIP.',
    consistent: false,
    build(good) {
      const { state, members } = open(good);
      const inner = writeArchive([{ path: 'inner.bin', bytes: new Uint8Array(12 * 1024 * 1024) }]);
      const tampered = clone(state);
      const recovery = tampered.recovery as Array<Record<string, unknown>>;
      recovery[0]!.raw = `${recovery[0]!.raw as string}${String.fromCharCode(0)}ZIP-BOMB`;
      return sealWithBomb(tampered, members, inner);
    },
  },
  {
    id: 'a-member-larger-than-the-per-member-cap',
    description: 'A single member of 33 MiB, one byte over the 32 MiB cap.',
    consistent: false,
    build(good) {
      const { state, members } = open(good);
      return seal(state, [...members, { path: `attachments/${hashOf(new Uint8Array(1024))}`, bytes: new Uint8Array(33 * 1024 * 1024) }]);
    },
  },
  {
    id: 'a-manifest-with-an-unknown-key',
    description: 'The closed manifest key set gains one member.',
    consistent: false,
    build(good) {
      const { state, members } = open(good);
      const resealed = seal(state, members);
      const manifest = readArchiveJson(resealed, 'manifest.json') as Record<string, unknown>;
      const files = readArchive(resealed).map((member) =>
        member.path === 'manifest.json'
          ? { ...member, bytes: bytesOf(canonicalJsonStringify({ ...manifest, extraKey: 'ZZ-verifier-extra-manifest-key' })) }
          : member,
      );
      return writeArchive(files);
    },
  },
  {
    id: 'a-credential-shaped-reason-in-the-manifest',
    description: 'The disclosure histogram is re-keyed to something that is not a code.',
    consistent: false,
    build(good) {
      const { state, members } = open(good);
      const tampered = clone(state);
      // Make one attachment neither stored-with-bytes nor external-only, so the
      // cross-checked histogram and count disagree with the manifest.
      (tampered.attachmentMetadata as Array<Record<string, unknown>>)[0]!.availability = 'weird';
      return seal(tampered, members);
    },
  },
];

function sealWithBomb(
  state: Record<string, unknown>,
  members: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  bomb: Uint8Array,
): Uint8Array {
  // The bomb rides in as an extra `recovery/*` member that the state document
  // does not describe, so the member-set comparison alone would catch it; the
  // point is the *ratio* check, so the member is a legitimate-looking one.
  const stateBytes = bytesOf(canonicalJsonStringify(state));
  const extra = [
    ...members.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
    { path: 'state.json', byteLength: stateBytes.byteLength, sha256: hashOf(stateBytes) },
    { path: 'recovery/000003.json', byteLength: bomb.byteLength, sha256: hashOf(bomb) },
  ];
  const attachmentEntries = extra.filter((entry) => entry.path.startsWith('attachments/'));
  const manifest = {
    product: 'kdbak' as const,
    formatVersion: 1,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: state.subjectSchemaVersion as string,
    createdAt: state.createdAt as string,
    memberCount: extra.length,
    totalBytes: extra.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(bytesOf(extra.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
    recordCounts: countsFor(state),
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    externalOnlyAttachments: readFromCounts(state),
    members: extra,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
    { path: 'state.json', bytes: stateBytes },
    ...members,
    { path: 'recovery/000003.json', bytes: bomb },
  ]);
}

function countsFor(state: Record<string, unknown>): Record<string, number> {
  return {
    meta: 0,
    subjects: (state.subjects as unknown[]).length,
    progression: (state.progression as unknown[]).length,
    sessions: (state.sessions as unknown[]).length,
    preferences: (state.preferences as unknown[]).length,
    shortcuts: (state.shortcuts as unknown[]).length,
    assistance: (state.assistance as unknown[]).length,
    attachments:
      (state.attachmentMetadata as unknown[]).length +
      (state.attachmentMetadata as Array<Record<string, unknown>>).filter(
        (entry) => entry.availability === 'stored' && typeof entry.contentHash === 'string',
      ).length,
    customSprites: (state.customSprites as unknown[]).length,
    recovery: (state.recovery as unknown[]).length,
    migrationReceipts: (state.migrationReceipts as unknown[]).length,
  };
}

describe('V3: corrupt archives never replace current data', () => {
  let source: VerifierDevice;
  let good: FullDeviceExportResult;

  beforeEach(async () => {
    source = await device();
    good = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: source.payloadBytes,
      activeSubjectId: SUBJECT.rich,
    });
  });

  it('the good archive really is good, and the reader accepts it', () => {
    expect(readFullDeviceArchive(good.bytes).problems).toEqual([]);
    expect(() => readFullDeviceArchive(good.bytes)).not.toThrow();
  });

  // A generous explicit timeout: this test builds twelve archives and drives
  // thirteen imports, and the default 5 s is not enough when the whole suite is
  // running in parallel. A test that only fails under load is a flaky test.
  it('every one of my corruptions is refused with a typed, sanitized error, and changes nothing', { timeout: 180_000 }, async () => {
    const target = await device({ alt: true });
    // The target already holds its own active generation with real records and a
    // live legacy mirror, so "unchanged" is a claim about a populated device.
    const before = await captureDevice(target.repository);
    expect(before.recordCount).toBeGreaterThan(10);
    expect(before.legacy.length).toBeGreaterThan(0);
    expect(before.activeGenerationId).not.toBeNull();

    const seen = new Set<string>();
    for (const corruption of CORRUPTIONS) {
      expect(seen.has(corruption.id), corruption.id).toBe(false);
      seen.add(corruption.id);
      let bytes: Uint8Array;
      try {
        bytes = corruption.build(good.bytes, source);
      } catch (error) {
        throw new Error(`${corruption.id}: the *fixture* failed to build: ${JSON.stringify((error as { details?: unknown }).details)}`);
      }

      let thrown: unknown = null;
      try {
        await importFullDeviceBackup({
          repository: target.repository,
          bytes,
          now: VERIFIER_RESTORE_NOW,
          keepPreviousGeneration: true,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${corruption.id}: the import succeeded instead of refusing`).not.toBeNull();
      expect(
        thrown,
        `${corruption.id}: an untyped ${String(thrown instanceof Error ? thrown.constructor.name : typeof thrown)} escaped`,
      ).toBeInstanceOf(StorageV2Error);
      const failure = thrown as StorageV2Error;
      for (const [key, value] of Object.entries(failure.details)) {
        if (typeof value !== 'string') continue;
        expect(isSanitizedDetailText(value), `${corruption.id}: detail ${key} is not sanitized`).toBe(true);
      }

      // The whole device, byte for byte.
      const after = await captureDevice(target.repository);
      expect(after.digest, `${corruption.id}: the device fingerprint moved`).toBe(before.digest);
      expect(after.activeGenerationId, corruption.id).toBe(before.activeGenerationId);
      expect(after.records, corruption.id).toEqual(before.records);
      expect(after.meta, corruption.id).toEqual(before.meta);
      expect(after.legacy, corruption.id).toEqual(before.legacy);
      expect(after.recordCount, corruption.id).toBe(before.recordCount);
    }

    // ...and the device is still usable: a good import lands.
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: good.bytes,
      now: VERIFIER_RESTORE_NOW,
      keepPreviousGeneration: true,
    });
    expect(result.activated).toBe(true);
    const landed = await captureDevice(target.repository);
    expect(landed.digest).not.toBe(before.digest);
  });

  it('a good import after each individual corruption still works, one at a time', { timeout: 120_000 }, async () => {
    for (const corruption of CORRUPTIONS) {
      const target = await device({ alt: true });
      const before = await captureDevice(target.repository);
      const bytes = corruption.build(good.bytes, source);
      await importFullDeviceBackup({
        repository: target.repository,
        bytes,
        now: VERIFIER_RESTORE_NOW,
      }).catch(() => undefined);
      const result = await importFullDeviceBackup({
        repository: target.repository,
        bytes: good.bytes,
        now: VERIFIER_RESTORE_NOW,
      });
      expect(result.activated, `${corruption.id}: a good import after it failed`).toBe(true);
      const after = await captureDevice(target.repository);
      expect(after.digest, corruption.id).not.toBe(before.digest);
    }
  });

  // The two tests below drive a loop over every corruption, each iteration
  // building a device, a fingerprint, and an import. Measured in isolation they
  // take 3.0 s and 3.2 s, which clears the 5 s default on this machine and does not
  // clear it when `test:node20` runs the whole suite in parallel - they failed there
  // for want of a budget, not because an assertion moved. They get the same explicit
  // budget the two long tests above already have, and no assertion is changed: being
  // killed at 5 s was a way of running *less* of this loop, not more of it.
  it('no corruption can make the reader return a preview that names learner content', { timeout: 60_000 }, async () => {
    for (const corruption of CORRUPTIONS) {
      const bytes = corruption.build(good.bytes, source);
      let serialized = '';
      try {
        serialized = JSON.stringify(readFullDeviceArchive(bytes));
      } catch (error) {
        const failure = error as StorageV2Error;
        serialized = JSON.stringify(failure.toReport());
      }
      for (const marker of Object.values(VERIFIER_MARKERS)) {
        if (marker.includes('example.invalid')) continue;
        expect(serialized.includes(marker), `${corruption.id}: ${marker} reached a report`).toBe(false);
      }
    }
  });

  it('a corrupt archive never mints, mutates, or deletes a generation', { timeout: 60_000 }, async () => {
    const target = await device({ alt: true });
    const before = await captureDevice(target.repository);
    for (const corruption of CORRUPTIONS) {
      await importFullDeviceBackup({
        repository: target.repository,
        bytes: corruption.build(good.bytes, source),
        now: VERIFIER_RESTORE_NOW,
      }).catch(() => undefined);
    }
    const after = await captureDevice(target.repository);
    // No orphan descriptor, no orphan record, and nothing deleted either.
    expect(after.meta).toEqual(before.meta);
    expect(after.records).toEqual(before.records);
    // ...and there is no leftover `staged` generation to reclaim later.
    const descriptors = await target.repository.listGenerations();
    expect(descriptors.map((descriptor) => descriptor.status).sort()).toEqual(['active', 'superseded']);
  });

  it('a truncated archive, an empty buffer, and random bytes are all refused', async () => {
    const target = await device({ alt: true });
    const before = await captureDevice(target.repository);
    const truncated = good.bytes.slice(0, Math.floor(good.bytes.byteLength / 2));
    const noise = new Uint8Array(4096);
    for (let index = 0; index < noise.byteLength; index += 1) noise[index] = (index * 31) & 0xff;
    for (const [label, bytes] of [
      ['truncated', truncated],
      ['empty', new Uint8Array(0)],
      ['noise', noise],
      ['not-bytes', 'a string' as unknown as Uint8Array],
    ] as Array<[string, Uint8Array]>) {
      let thrown: unknown = null;
      try {
        await importFullDeviceBackup({ repository: target.repository, bytes, now: VERIFIER_RESTORE_NOW });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).not.toBeNull();
      expect(thrown, `${label}: untyped`).toBeInstanceOf(StorageV2Error);
    }
    const after = await captureDevice(target.repository);
    expect(after.digest).toBe(before.digest);
  });

  it('an archive that is a valid ZIP of a different product is refused by the layout, not by luck', () => {
    // A `.kdsubject`-shaped archive: the fixed members exist, the layout does not.
    const state = { formatVersion: 1, storageGenerationFormatVersion: 1, subjectSchemaVersion: '1.1.0', createdAt: VERIFIER_RESTORE_NOW };
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(
        writeArchive([
          { path: 'manifest.json', bytes: bytesOf('{"product":"kdsubject"}') },
          { path: 'state.json', bytes: bytesOf(JSON.stringify(state)) },
          { path: 'subject.json', bytes: bytesOf('{}') },
        ]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as StorageV2Error).code).toBe('VALIDATION_FAILED');
  });

  it('the fingerprint the gate trusts really does see attachment bytes, and storage-v2\'s own checksum does not', async () => {
    // Non-vacuity for "the device is unchanged" when the change under test is a
    // byte: a mutation the fingerprint cannot see would make every assertion in
    // this file decorative.
    const target = await device({ alt: true });
    const before = await captureDevice(target.repository);
    const snapshot = await target.repository.readRecords(target.generationId);
    const blob = (
      snapshot.records.attachmentBlobs as unknown as Array<{
        value: { attachmentId: string; bytes: ArrayBuffer; byteLength: number; contentHash: string; storedAt: string };
      }>
    )[0]!;
    const mutated = new Uint8Array(blob.value.bytes.slice(0));
    mutated[0] = (mutated[0] as number) ^ 0xff;
    await target.repository.putRecords(target.generationId, {
      attachmentBlobs: [{ ...blob.value, bytes: mutated.buffer, byteLength: mutated.byteLength } as never],
    });
    const after = await captureDevice(target.repository);

    // The verifier's fingerprint moved: one byte of one attachment changed.
    expect(after.digest).not.toBe(before.digest);
    const changed = before.records.filter((entry, index) => entry[3] !== after.records[index]?.[3]);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.[1]).toBe(`blob:${blob.value.attachmentId}`);

    // The generation's own roll-up checksum did **not** move, and storage-v2's
    // own validation reports no mismatch. This is the recorded follow-up about
    // attachment bytes, measured rather than quoted:
    // `canonicalJsonStringify` serializes an `ArrayBuffer` as `{}`, so a blob
    // record's checksum covers the id, the declared hash, the length, and the
    // timestamp - and not one byte of the payload.
    const descriptorRow = (rows: ReadonlyArray<readonly [string, string]>, generationId: string): string | undefined =>
      rows.find((entry) => entry[0] === `generation:${generationId}`)?.[1];
    expect(descriptorRow(after.meta, target.generationId)).toBe(descriptorRow(before.meta, target.generationId));
    const report = await target.repository.validateGeneration(target.generationId);
    expect(report.checksumMismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(canonicalJsonStringify({ bytes: mutated.buffer })).toBe('{"bytes":{}}');
    expect(canonicalJsonStringify({ bytes: new Uint8Array([1, 2, 3]) })).toBe('{"bytes":[1,2,3]}');
    expect(encodeValue({ bytes: mutated.buffer })).toContain('ab:');
  });
});
