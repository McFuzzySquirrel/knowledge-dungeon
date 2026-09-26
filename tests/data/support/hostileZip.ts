/**
 * Raw ZIP bytes and hostile `.kdbak` fixtures for the Phase 5 data-product gate.
 *
 * Two kinds of archive are built here, and the difference matters:
 *
 * - **Well-formed archives are built by the audited production codec.**
 *   `src/services/persistence/v2/archive.ts` (`fflate`, ADR 002) writes them, so
 *   the "good" archive this gate attacks is the same kind of archive the product
 *   will write. Plan section 7.3 forbids hand-rolling ZIP *encoding* in the
 *   product, and the product does not hand-roll anything: `writeArchive` does.
 * - **Hostile archives are built byte by byte.** A directory entry, a member
 *   whose POSIX mode says "symbolic link", and an archive with its central
 *   directory removed cannot be produced by asking a well-behaved ZIP writer for
 *   them, because a well-behaved writer will not emit them. They are assembled
 *   here, in test code only, from a stored (uncompressed) local file header, a
 *   central directory header, and an end-of-central-directory record.
 *
 * Nothing in this module is reachable from `src/`. It is a fixture builder, not
 * an encoder the application could use, and it never runs in a build.
 *
 * Privacy: every payload is synthetic. Names are fixed, opaque, and
 * self-describing; no subject name, topic, note, filename, URL, or host appears
 * in any member name this module produces.
 */

import { zipSync } from 'fflate/browser';

import { writeArchive, type ArchiveFile } from '@/services/persistence/v2/archive';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
} from '@/services/persistence/v2/schema';
import { CURRENT_SCHEMA_VERSION, DATA_PRODUCT_FORMAT_VERSIONS } from '@/core/validation/persistence/types';
import { platformSha256, utf8 } from './hashes';
import {
  CORRUPTION_CASES,
  EXPECTED_VERSION_VALUES,
  FIXED_MEMBER_NAMES,
  FULL_DEVICE_PRODUCT,
  REQUIRED_MANIFEST_KEYS,
  type CorruptionCaseId,
} from './productInterface';

// ── CRC-32 (ZIP) ───────────────────────────────────────────────────────────

/**
 * The ZIP CRC-32, implemented here rather than taken from `node:zlib`.
 *
 * `zlib.crc32` only exists from Node 20.15, and this suite is required to behave
 * identically on the CI Node major and on the local one. A fifteen-line
 * polynomial loop has no version dependency at all.
 */
export function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Raw ZIP assembly (hostile fixtures only) ───────────────────────────────

/** A raw ZIP entry, with the structural fields a hostile fixture needs. */
export interface RawZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** POSIX mode written into the external attributes. */
  readonly unixMode?: number;
  /** Write the name with a trailing `/`, the directory-entry convention. */
  readonly directory?: boolean;
  /**
   * Declare a different uncompressed size in both headers.
   *
   * The hostile "lying header" shape: an extractor that trusts the declared
   * size reads a different member than one that reads the data descriptor.
   */
  readonly declaredUncompressedSize?: number;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UNIX_HOST_SYSTEM = 3;
const REGULAR_FILE_MODE = 0o100644;
const SYMLINK_MODE = 0o120777;

function findSignature(bytes: Uint8Array, signature: number, fromIndex = 0): number {
  for (let index = fromIndex; index + 4 <= bytes.length; index += 1) {
    const value =
      (bytes[index] as number) |
      ((bytes[index + 1] as number) << 8) |
      ((bytes[index + 2] as number) << 16) |
      ((bytes[index + 3] as number) << 24);
    if ((value >>> 0) === signature) return index;
  }
  return -1;
}

/**
 * Assemble a stored (uncompressed) ZIP from raw entries.
 *
 * Every structural choice is fixed: method 0 (store), no data descriptor, no
 * encryption, no ZIP64. A fixture that is trivially parseable is a better
 * fixture, because a failure then means the *reader* was wrong rather than the
 * fixture being accidentally invalid.
 */
export function rawZip(entries: readonly RawZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.directory === true ? `${entry.name}/` : entry.name);
    const declaredSize = entry.declaredUncompressedSize ?? entry.bytes.length;
    const crc = zipCrc32(entry.bytes);

    const local = new Uint8Array(30 + nameBytes.length + entry.bytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, declaredSize, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(entry.bytes, 30 + nameBytes.length);
    localParts.push(local);

    const externalAttributes = ((entry.unixMode ?? REGULAR_FILE_MODE) & 0xffff) << 16;
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    centralView.setUint16(4, (UNIX_HOST_SYSTEM << 8) | 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, externalAttributes >>> 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralDirectorySize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const total =
    offset + centralDirectorySize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** A ZIP with its central directory removed, keeping the local file headers. */
export function dropCentralDirectory(bytes: Uint8Array): Uint8Array {
  const start = findSignature(bytes, CENTRAL_HEADER_SIGNATURE);
  if (start < 0) throw new Error('The fixture has no central directory to remove.');
  return bytes.slice(0, start);
}

// ── The reference `.kdbak` ────────────────────────────────────────────────

/** One content-addressed attachment member. */
export interface AttachmentMemberInput {
  readonly bytes: Uint8Array;
  /** Omit to hash the bytes. */
  readonly contentHash?: string;
}

export interface ReferenceArchiveInput {
  /** The `state.json` document. */
  readonly stateJson: Record<string, unknown>;
  readonly attachmentMembers: readonly AttachmentMemberInput[];
  readonly customSpriteMembers: readonly { readonly bytes: Uint8Array; readonly extension: string }[];
  readonly recoveryMembers: readonly { readonly bytes: Uint8Array }[];
  readonly createdAt: string;
  /** Per-store record counts, as the manifest declares them. */
  readonly recordCounts: Readonly<Record<string, number>>;
  /** External-only disclosure the manifest declares. */
  readonly externalOnly: { readonly count: number; readonly reasons: Readonly<Record<string, number>> };
  /** Replace the bytes stored under one content hash, to build a lying member. */
  readonly overrideAttachmentBytes?: { readonly contentHash: string; readonly bytes: Uint8Array };
  /** Force a member-count disagreement, to build an inconsistent manifest. */
  readonly declaredMemberCountOverride?: number;
  /** Drop one manifest key, to build a manifest missing a required field. */
  readonly omittedManifestKey?: string;
  /** Write `manifest.json` as raw bytes instead of as canonical JSON. */
  readonly manifestRawBytes?: Uint8Array;
  /** Write `state.json` as raw bytes instead of as canonical JSON. */
  readonly stateRawBytes?: Uint8Array;
}

export interface ReferenceArchive {
  /** The archive bytes. */
  readonly bytes: Uint8Array;
  /** The manifest as the writer declared it. */
  readonly manifest: Record<string, unknown>;
  /** Member name to member bytes, in write order. */
  readonly members: ReadonlyMap<string, Uint8Array>;
  /** Member names in write order. */
  readonly memberNames: readonly string[];
}

/** Stable, opaque, zero-based index name: `000001`, `000002`, ... */
function indexName(position: number, extension: string): string {
  return `${String(position).padStart(6, '0')}.${extension}`;
}

/**
 * Build a reference `.kdbak` to the plan's fixed layout.
 *
 * This is a **reference** archive, not the product's: it exists so the gate has
 * a well-formed archive to attack and so the corruption cases have a known-good
 * baseline. The registered export tests assert that the product's own writer
 * produces the same layout.
 */
export function buildReferenceArchive(input: ReferenceArchiveInput): ReferenceArchive {
  const files: ArchiveFile[] = [];
  const members = new Map<string, Uint8Array>();

  const stateBytes = input.stateRawBytes ?? utf8(JSON.stringify(input.stateJson));
  files.push({ path: FIXED_MEMBER_NAMES[1], bytes: stateBytes });
  members.set(FIXED_MEMBER_NAMES[1], stateBytes);

  // Content addressing: identical payloads collapse onto one member.
  for (const member of input.attachmentMembers) {
    const contentHash = member.contentHash ?? platformSha256(member.bytes);
    const existing = members.get(`attachments/${contentHash}`);
    if (existing !== undefined) continue;
    const bytes = input.overrideAttachmentBytes?.contentHash === contentHash
      ? input.overrideAttachmentBytes.bytes
      : member.bytes;
    files.push({ path: `attachments/${contentHash}`, bytes });
    members.set(`attachments/${contentHash}`, bytes);
  }

  input.customSpriteMembers.forEach((member, position) => {
    const name = indexName(position + 1, member.extension);
    files.push({ path: `custom-sprites/${name}`, bytes: member.bytes });
    members.set(`custom-sprites/${name}`, member.bytes);
  });

  input.recoveryMembers.forEach((member, position) => {
    const name = indexName(position + 1, 'json');
    files.push({ path: `recovery/${name}`, bytes: member.bytes });
    members.set(`recovery/${name}`, member.bytes);
  });

  const memberEntries = files.map((file) => ({
    path: file.path,
    byteLength: file.bytes.length,
    sha256: platformSha256(file.bytes),
  }));
  const attachmentEntries = memberEntries.filter((entry) => entry.path.startsWith('attachments/'));
  const totalBytes = memberEntries.reduce((total, entry) => total + entry.byteLength, 0);

  const manifest: Record<string, unknown> = {
    product: FULL_DEVICE_PRODUCT,
    formatVersion: EXPECTED_VERSION_VALUES.formatVersion,
    storageGenerationFormatVersion: EXPECTED_VERSION_VALUES.storageGenerationFormatVersion,
    subjectSchemaVersion: EXPECTED_VERSION_VALUES.subjectSchemaVersion,
    createdAt: input.createdAt,
    memberCount: input.declaredMemberCountOverride ?? memberEntries.length,
    totalBytes,
    contentChecksum: platformSha256(
      utf8(memberEntries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n')),
    ),
    recordCounts: input.recordCounts,
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    externalOnlyAttachments: input.externalOnly,
    members: memberEntries,
  };
  if (input.omittedManifestKey !== undefined) delete manifest[input.omittedManifestKey];

  const manifestBytes = input.manifestRawBytes ?? utf8(JSON.stringify(manifest));
  files.unshift({ path: FIXED_MEMBER_NAMES[0], bytes: manifestBytes });
  members.set(FIXED_MEMBER_NAMES[0], manifestBytes);

  return {
    bytes: writeArchive(files),
    manifest,
    members,
    memberNames: files.map((file) => file.path),
  };
}

/**
 * A ZIP written by `fflate` directly, bypassing the production wrapper's own
 * path validation.
 *
 * `writeArchive` refuses an unsafe member name, which is the behaviour the gate
 * wants to test; producing the *input* for that test therefore has to come from
 * a writer that does not pre-validate. This is a fixture writer, not the
 * product's encoder.
 */
export function rawFflateZip(files: readonly ArchiveFile[]): Uint8Array {
  const zippable: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const file of files) zippable[file.path] = [file.bytes, { level: 0 }];
  return zipSync(zippable);
}

// ── The fifteen corruption cases ───────────────────────────────────────────

/** One built corruption case: its id, its bytes, and a description. */
export interface CorruptionFixture {
  readonly id: CorruptionCaseId;
  readonly bytes: Uint8Array;
  /** True when the fixture is still a *readable* ZIP, for the coverage report. */
  readonly structurallyReadableZip: boolean;
}

function referenceMembersAsFiles(archive: ReferenceArchive): ArchiveFile[] {
  return [...archive.members.entries()].map(([path, bytes]) => ({ path, bytes }));
}

/**
 * Build all fifteen corruption cases from one good archive.
 *
 * Every case is derived from the same reference archive, so a difference in
 * outcome cannot be explained by the baseline differing between cases.
 */
export function buildCorruptionCases(good: ReferenceArchive): Map<CorruptionCaseId, CorruptionFixture> {
  const built = new Map<CorruptionCaseId, CorruptionFixture>();
  const files = referenceMembersAsFiles(good);
  const manifestPath = FIXED_MEMBER_NAMES[0];
  const statePath = FIXED_MEMBER_NAMES[1];

  const put = (id: CorruptionCaseId, bytes: Uint8Array, structurallyReadableZip: boolean): void => {
    built.set(id, { id, bytes, structurallyReadableZip });
  };

  // 1. Truncated: keep everything but the last eighth of the bytes, which removes
  //    the end-of-central-directory record and part of the central directory.
  put('truncated-archive', good.bytes.slice(0, Math.floor(good.bytes.length * 0.875)), false);

  // 2. Missing central directory: local file headers only.
  put('missing-central-directory', dropCentralDirectory(good.bytes), false);

  // 3. A member whose bytes no longer hash to its content-addressed name. Built
  //    with the production writer so the archive stays structurally perfect and
  //    only the *contract* is violated.
  {
    const firstAttachment = good.memberNames.find((name) => name.startsWith('attachments/'));
    if (firstAttachment === undefined) throw new Error('The reference archive has no attachment member.');
    const tampered = buildReferenceArchive({
      ...referenceInputFor(good),
      overrideAttachmentBytes: {
        contentHash: firstAttachment.slice('attachments/'.length),
        bytes: utf8('synthetic tampered attachment payload'),
      },
    });
    put('member-checksum-mismatch', tampered.bytes, true);
  }

  // 4. state.json that is not JSON at all.
  put(
    'state-not-json',
    writeArchive([
      ...files.filter((file) => file.path !== statePath),
      { path: statePath, bytes: utf8('{"subjects": [ this is not json') },
    ]),
    true,
  );

  // 5. state.json that parses but has the wrong shape.
  put(
    'state-wrong-shape',
    writeArchive([
      ...files.filter((file) => file.path !== statePath),
      { path: statePath, bytes: utf8(JSON.stringify({ unexpected: true, version: 1 })) },
    ]),
    true,
  );

  // 6. manifest.json that is not JSON at all.
  put(
    'manifest-not-json',
    writeArchive([
      ...files.filter((file) => file.path !== manifestPath),
      { path: manifestPath, bytes: utf8('not json at all') },
    ]),
    true,
  );

  // 7. A manifest missing a required field: the checksums, which is the field
  //    whose absence would let a truncated or rewritten archive pass.
  {
    const withoutChecksum = buildReferenceArchive({
      ...referenceInputFor(good),
      omittedManifestKey: 'contentChecksum',
    });
    put('manifest-missing-field', withoutChecksum.bytes, true);
  }

  // 8. A manifest whose declared member count disagrees with its members.
  {
    const wrongCount = buildReferenceArchive({
      ...referenceInputFor(good),
      declaredMemberCountOverride: good.memberNames.length + 7,
    });
    put('manifest-counts-disagree', wrongCount.bytes, true);
  }

  // 9. A member name that escapes the extraction root.
  put(
    'zip-slip-member-name',
    rawFflateZip([...files, { path: '../escape.json', bytes: utf8('{"escaped":true}') }]),
    true,
  );

  // 10. A directory entry. Written as a raw entry so the external attributes are
  //     a real directory mode, not just a trailing slash.
  put(
    'directory-entry-member',
    rawZip([
      { name: 'manifest.json', bytes: good.members.get(manifestPath) as Uint8Array },
      { name: 'state.json', bytes: good.members.get(statePath) as Uint8Array },
      { name: 'attachments', directory: true, unixMode: 0o040755, bytes: new Uint8Array(0) },
    ]),
    true,
  );

  // 11. A symlink-style member: the external attributes say S_IFLNK and the
  //     payload is a path. A raw entry is the only way to produce it.
  put(
    'symlink-style-member',
    rawZip([
      { name: 'manifest.json', bytes: good.members.get(manifestPath) as Uint8Array },
      { name: 'state.json', bytes: good.members.get(statePath) as Uint8Array },
      {
        name: 'custom-sprites/000001.svg',
        unixMode: SYMLINK_MODE,
        bytes: utf8('/etc/hostname'),
      },
    ]),
    true,
  );

  // 12. An extra member the layout does not define.
  put(
    'unexpected-extra-member',
    writeArchive([...files, { path: 'extra/unexpected.bin', bytes: utf8('unexpected member payload') }]),
    true,
  );

  // 13. A structurally perfect archive with no members at all.
  put('empty-archive', rawZip([]), true);

  // 14. Bytes that are not a ZIP. Deterministic, so a failure is reproducible.
  put('random-bytes', deterministicNoise(4096), false);

  // 15. A state document that declares a subject schema version this build
  //     cannot read.
  {
    const state = JSON.parse(new TextDecoder().decode(good.members.get(statePath) as Uint8Array)) as Record<
      string,
      unknown
    >;
    const newer = buildReferenceArchive({
      ...referenceInputFor(good),
      stateJson: { ...state, subjectSchemaVersion: '99.0.0' },
    });
    put('unsupported-subject-schema-version', newer.bytes, true);
  }

  return built;
}

/**
 * Recover enough of the reference archive's inputs to rebuild a variant of it.
 *
 * Reading the inputs back out of the built archive keeps the variants derived
 * from the *same* bytes as the baseline, which is what makes "these two archives
 * differ only in this one respect" a claim rather than a hope.
 */
function referenceInputFor(archive: ReferenceArchive): ReferenceArchiveInput {
  const stateBytes = archive.members.get(FIXED_MEMBER_NAMES[1]) as Uint8Array;
  const stateJson = JSON.parse(new TextDecoder().decode(stateBytes)) as Record<string, unknown>;
  const manifest = JSON.parse(
    new TextDecoder().decode(archive.members.get(FIXED_MEMBER_NAMES[0]) as Uint8Array),
  ) as Record<string, unknown>;

  const attachmentMembers = archive.memberNames
    .filter((name) => name.startsWith('attachments/'))
    .map((name) => ({
      bytes: archive.members.get(name) as Uint8Array,
      contentHash: name.slice('attachments/'.length),
    }));
  const customSpriteMembers = archive.memberNames
    .filter((name) => name.startsWith('custom-sprites/'))
    .map((name) => ({
      bytes: archive.members.get(name) as Uint8Array,
      extension: name.slice(name.lastIndexOf('.') + 1),
    }));
  const recoveryMembers = archive.memberNames
    .filter((name) => name.startsWith('recovery/'))
    .map((name) => ({ bytes: archive.members.get(name) as Uint8Array }));

  return {
    stateJson,
    attachmentMembers,
    customSpriteMembers,
    recoveryMembers,
    createdAt: String(manifest.createdAt),
    recordCounts: manifest.recordCounts as Record<string, number>,
    externalOnly: manifest.externalOnlyAttachments as { count: number; reasons: Record<string, number> },
  };
}

/**
 * Deterministic pseudo-random bytes.
 *
 * Seeded from a fixed integer rather than `Math.random`, so the same 4096 bytes
 * are produced on every run, on every machine, and under every Node major - the
 * fixture a corruption case is built from must not vary between runs.
 */
export function deterministicNoise(byteLength: number, seed = 0x5eed1234): Uint8Array {
  const out = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < byteLength; index += 1) {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

/** The version values a reference archive declares, for report assertions. */
export const REFERENCE_VERSION_VALUES = {
  productFormat: DATA_PRODUCT_FORMAT_VERSIONS[FULL_DEVICE_PRODUCT],
  storageGeneration: STORAGE_V2_GENERATION_FORMAT_VERSION,
  subjectSchema: CANONICAL_SUBJECT_SCHEMA_VERSION,
  currentSubjectSchema: CURRENT_SCHEMA_VERSION,
  manifestKeys: REQUIRED_MANIFEST_KEYS.length,
} as const;

/** Case ids in declaration order, for report and evidence output. */
export const CORRUPTION_CASE_ORDER: readonly CorruptionCaseId[] = CORRUPTION_CASES.map(
  (spec) => spec.id,
);
