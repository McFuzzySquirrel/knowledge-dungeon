/**
 * ZIP read/write for the `.kdbak`, `.kdsubject`, and `.kdtemplate` products.
 *
 * ZIP encoding is delegated to `fflate` (ADR 002, "Phase 3 archive dependency
 * selection"). Only the explicit `fflate/browser` subpath is imported: the bare
 * specifier resolves to fflate's Node entry under Vitest and to its browser
 * entry in the web build, so the unit tests and the shipped bundle would not
 * exercise the same code. The subpath resolves to the browser build in both.
 *
 * `fflate` does not define an archive *format* and does not defend against a
 * hostile archive, so this module owns both:
 *
 * - the member-path rules (zip-slip, absolute paths, drive letters, traversal),
 * - the resource limits (member count, per-member bytes, total bytes, and
 *   compression ratio), enforced through fflate's `filter` hook so a member is
 *   rejected *before* it is decompressed into memory,
 * - the *writer's* duplicate-name check, which must ask `Object.hasOwn` rather
 *   than `in` so a legitimate member named after an `Object.prototype` key is not
 *   mistaken for a duplicate, and
 * - two read-only structural classifiers ({@link classifyArchiveMemberTypes} and
 *   {@link classifyUnreadableArchive}) that read fixed ZIP header fields to
 *   classify an archive. Neither decompresses anything, neither reconstructs a
 *   member, and neither can make an archive readable: they can only classify it
 *   so the caller can *refuse* it with a precise reason.
 *
 * There is no file-system access, no network access, and no `eval`. Paths are
 * validated as data and are never handed to a file API.
 */

import { unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate/browser';
import { StorageV2Error } from './schema';

export interface ArchiveFile {
  /** Member path inside the archive. Never absolute, never traversing. */
  path: string;
  bytes: Uint8Array;
  /**
   * The member's modification time, written into the ZIP entry's DOS timestamp.
   *
   * Omitted means "now", which is fflate's default and the reason an archive
   * written twice from identical bytes is **not** byte-identical. A caller that
   * needs a reproducible archive must pass it, because the clock is not the
   * caller's data and this module deliberately has no clock of its own.
   */
  mtime?: Date;
}

export interface ArchiveLimits {
  /** Maximum number of members. */
  maxMembers: number;
  /** Maximum decompressed size of a single member. */
  maxMemberBytes: number;
  /** Maximum decompressed size of the whole archive. */
  maxTotalBytes: number;
  /** Maximum decompressed-to-compressed ratio for a single member. */
  maxCompressionRatio: number;
  /**
   * Maximum number of directory entries tolerated.
   *
   * A directory entry carries no payload, so it is nearly free; it is bounded
   * anyway so a crafted file cannot use one to spend unbounded time here.
   */
  maxDirectoryEntries: number;
}

/**
 * Default limits, sized for the bounded local products the plan describes: a
 * handful of JSON documents plus attachment bytes. A member cap of 32 MiB and a
 * total cap of 256 MiB leave generous headroom while still bounding the damage
 * a malformed or hostile file can do.
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxMembers: 2048,
  maxMemberBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxDirectoryEntries: 32,
};

/**
 * Per-call read options.
 *
 * `acceptDirectoryEntry` is the single opt-in that changes what counts as a
 * member, and it is a **predicate on the raw member name** so the ZIP codec
 * never has to know a product's layout. The default is the strict rule: a name
 * with an empty segment is refused, so a `.kdbak` carrying a bare
 * `attachments/` entry is malformed unless the caller has said it is metadata.
 */
export interface ArchiveReadOptions extends Partial<ArchiveLimits> {
  /**
   * Return `true` to accept a directory-entry name as metadata and drop it from
   * the member list, instead of refusing it as an empty segment.
   *
   * This exists so an archive written by ordinary ZIP tooling - which emits
   * `attachments/`, `custom-sprites/`, and `recovery/` entries - is readable.
   * A member is only ever dropped, never reinterpreted, and a name the predicate
   * rejects is still refused.
   */
  acceptDirectoryEntry?: (name: string) => boolean;
}

const WINDOWS_DRIVE = /^[a-zA-Z]:/;

function archiveError(
  code:
    | 'ARCHIVE_UNSAFE_PATH'
    | 'ARCHIVE_MEMBER_LIMIT'
    | 'ARCHIVE_MEMBER_TOO_LARGE'
    | 'ARCHIVE_TOTAL_TOO_LARGE'
    | 'ARCHIVE_RATIO_EXCEEDED'
    | 'ARCHIVE_MALFORMED'
    | 'ARCHIVE_MEMBER_MISSING',
  details: Record<string, string | number | boolean>,
): StorageV2Error {
  return new StorageV2Error(code, details);
}

/**
 * Reject a member path that could escape the extraction root.
 *
 * A path is unsafe when it is empty, absolute (POSIX or Windows), a drive
 * letter, contains a `..` segment, contains a NUL or control character, or uses
 * backslashes as separators (which some extractors normalize to `/` after this
 * check would have passed).
 */
export function assertSafeArchivePath(path: string): void {
  const reason = describeUnsafeArchivePath(path);
  if (reason === null) return;
  throw archiveError('ARCHIVE_UNSAFE_PATH', { reason, pathLength: path.length });
}

/**
 * Classify why a path is unsafe, or `null` when it is safe.
 *
 * Returns a reason code rather than the path itself, so the value never reaches a
 * log or an error report.
 */
export function describeUnsafeArchivePath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'empty-path';
  if (path.length > 512) return 'path-too-long';
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'control-character';
  if (path.includes('\\')) return 'backslash-separator';
  if (path.startsWith('//')) return 'unc-path';
  if (path.startsWith('/')) return 'absolute-path';
  if (WINDOWS_DRIVE.test(path)) return 'drive-letter';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) return 'parent-traversal';
  if (segments.some((segment) => segment.length === 0)) return 'empty-segment';
  return null;
}

function isSafeArchivePath(path: string): boolean {
  return describeUnsafeArchivePath(path) === null;
}

/**
 * Whether a member name is the ZIP convention for a directory entry.
 *
 * A trailing `/` is the convention every ZIP writer follows, and it is the *only*
 * signal available without reading the external attributes: the name alone.
 */
export function isDirectoryEntryName(path: string): boolean {
  return typeof path === 'string' && path.length > 1 && path.endsWith('/');
}

function resolveLimits(options?: ArchiveReadOptions): ArchiveLimits {
  return {
    maxMembers: options?.maxMembers ?? DEFAULT_ARCHIVE_LIMITS.maxMembers,
    maxMemberBytes: options?.maxMemberBytes ?? DEFAULT_ARCHIVE_LIMITS.maxMemberBytes,
    maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
    maxCompressionRatio: options?.maxCompressionRatio ?? DEFAULT_ARCHIVE_LIMITS.maxCompressionRatio,
    maxDirectoryEntries: options?.maxDirectoryEntries ?? DEFAULT_ARCHIVE_LIMITS.maxDirectoryEntries,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Write a ZIP archive.
 *
 * Member order is preserved, so writing the same files twice produces
 * byte-identical output for the same `fflate` build - provided every
 * {@link ArchiveFile.mtime} is the same value. Without one, each entry is stamped
 * from the wall clock and two archives over identical member bytes differ.
 *
 * Two details are load-bearing rather than stylistic:
 *
 * - The duplicate check is `Object.hasOwn`, not `in`. With `in`, a member named
 *   `toString` (or `constructor`, or any other `Object.prototype` key) reads as
 *   already present and a legitimate archive becomes unwritable. Phase 3 recorded
 *   this as a follow-up; Phase 5 implements it, because a product that cannot
 *   write a member another tool wrote is not interoperable.
 * - The object handed to fflate has a **null prototype**, and the duplicate check
 *   is `Object.hasOwn`. Together they make every representable name an ordinary
 *   own property, and member order is still insertion order because no member
 *   name is integer-like. `__proto__` is the single exception fflate cannot
 *   represent at all, and it is refused with its own reason rather than written
 *   into an archive that would come back without it.
 */
export function writeArchive(files: readonly ArchiveFile[]): Uint8Array {
  if (files.length > DEFAULT_ARCHIVE_LIMITS.maxMembers) {
    throw archiveError('ARCHIVE_MEMBER_LIMIT', { count: files.length });
  }
  const zippable = Object.create(null) as Zippable;
  for (const file of files) {
    assertSafeArchivePath(file.path);
    if (file.path === UNREPRESENTABLE_MEMBER_NAME) {
      // fflate normalizes member names into a plain object internally and then
      // enumerates it with `for...in`, so a name that cannot be an ordinary key
      // there changes that object's prototype, the member vanishes, and the
      // archive that comes out is not the archive that went in. There is no
      // arrangement of options that fixes it, so the one unrepresentable name is
      // refused up front with its own reason rather than dropped in silence.
      throw archiveError('ARCHIVE_UNSAFE_PATH', { reason: 'prototype-member-name' });
    }
    if (Object.hasOwn(zippable, file.path)) {
      throw archiveError('ARCHIVE_MALFORMED', { reason: 'duplicate-member' });
    }
    // `mtime` is passed straight through: fflate stamps it into the DOS timestamp
    // of the local and central headers, and `mrg` carries it into the entry it
    // writes. A fixed `mtime` therefore makes the *container* deterministic, not
    // just the members.
    zippable[file.path] = [
      file.bytes.slice(),
      file.mtime === undefined ? { level: 6 } : { level: 6, mtime: file.mtime },
    ];
  }
  return zipSync(zippable);
}

/**
 * The one member name this writer cannot represent.
 *
 * Every other name on `Object.prototype` is an ordinary string and round-trips
 * fine; `__proto__` is the one whose assignment has a side effect.
 */
export const UNREPRESENTABLE_MEMBER_NAME = '__proto__';

/** Serialize a value as canonical JSON inside an archive. */
export function writeArchiveJson(
  files: readonly { path: string; json: unknown }[],
): Uint8Array {
  return writeArchive(
    files.map((file) => ({ path: file.path, bytes: encoder.encode(JSON.stringify(file.json)) })),
  );
}

/**
 * Read a ZIP archive, enforcing every limit before decompressing.
 *
 * The `filter` hook receives fflate's per-entry metadata, including
 * `originalSize` and the compressed `size`, so a ratio bomb or an oversize
 * member is refused before any bytes are produced.
 */
export function readArchive(
  bytes: Uint8Array,
  options?: ArchiveReadOptions,
): ArchiveFile[] {
  const effective = resolveLimits(options);
  if (!(bytes instanceof Uint8Array)) {
    throw archiveError('ARCHIVE_MALFORMED', { reason: 'not-bytes' });
  }

  let memberCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  const filter = (file: { name: string; originalSize: number; size: number }): boolean => {
    // Directory entries are classified first: one the caller has declared to be
    // metadata is not a member, so it is neither counted against `maxMembers`
    // nor decompressed. It is still bounded, so a crafted file cannot spend
    // unbounded time here.
    if (isDirectoryEntryName(file.name)) {
      directoryCount += 1;
      if (directoryCount > effective.maxDirectoryEntries) {
        throw archiveError('ARCHIVE_MEMBER_LIMIT', { limit: effective.maxDirectoryEntries });
      }
      if (options?.acceptDirectoryEntry?.(file.name) === true) return false;
    }

    memberCount += 1;
    if (memberCount > effective.maxMembers) {
      throw archiveError('ARCHIVE_MEMBER_LIMIT', { limit: effective.maxMembers });
    }
    const reason = describeUnsafeArchivePath(file.name);
    if (reason !== null) {
      throw archiveError('ARCHIVE_UNSAFE_PATH', { reason, pathLength: file.name.length });
    }
    if (file.originalSize > effective.maxMemberBytes) {
      throw archiveError('ARCHIVE_MEMBER_TOO_LARGE', {
        limit: effective.maxMemberBytes,
        declaredBytes: file.originalSize,
      });
    }
    totalBytes += file.originalSize;
    if (totalBytes > effective.maxTotalBytes) {
      throw archiveError('ARCHIVE_TOTAL_TOO_LARGE', { limit: effective.maxTotalBytes });
    }
    const compressed = Math.max(file.size, 1);
    if (file.originalSize / compressed > effective.maxCompressionRatio) {
      throw archiveError('ARCHIVE_RATIO_EXCEEDED', {
        limit: effective.maxCompressionRatio,
        declaredBytes: file.originalSize,
      });
    }
    return true;
  };

  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(bytes, { filter });
  } catch (error) {
    if (error instanceof StorageV2Error) throw error;
    throw archiveError('ARCHIVE_MALFORMED', { reason: 'unzip-failed' });
  }

  const names = Object.keys(unzipped);
  if (names.length > effective.maxMembers) {
    throw archiveError('ARCHIVE_MEMBER_LIMIT', { count: names.length, limit: effective.maxMembers });
  }
  return names.map((name) => {
    if (!isSafeArchivePath(name)) {
      throw archiveError('ARCHIVE_UNSAFE_PATH', { reason: 'post-read', pathLength: name.length });
    }
    const content = unzipped[name];
    if (content.length > effective.maxMemberBytes) {
      throw archiveError('ARCHIVE_MEMBER_TOO_LARGE', { limit: effective.maxMemberBytes });
    }
    return { path: name, bytes: content };
  });
}

/** Decode one already-read member as UTF-8 text. */
function decodeMemberText(files: readonly ArchiveFile[], path: string): string {
  const member = files.find((file) => file.path === path);
  if (!member) {
    throw archiveError('ARCHIVE_MEMBER_MISSING', { memberCount: files.length });
  }
  try {
    return decoder.decode(member.bytes);
  } catch {
    throw archiveError('ARCHIVE_MALFORMED', { reason: 'member-not-utf8' });
  }
}

/**
 * Parse one already-read member as JSON.
 *
 * The same three outcomes as {@link readArchiveJson} - absent member, non-UTF-8
 * bytes, unparseable text - with the same codes and reasons, so a caller that
 * reads an archive once and then decodes two members from it cannot drift from a
 * caller that uses {@link readArchiveJson} twice.
 */
export function decodeArchiveJsonMember(files: readonly ArchiveFile[], path: string): unknown {
  const text = decodeMemberText(files, path);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw archiveError('ARCHIVE_MALFORMED', { reason: 'member-not-json' });
  }
}

/** Read one member as UTF-8 text. */
export function readArchiveText(
  bytes: Uint8Array,
  path: string,
  options?: ArchiveReadOptions,
): string {
  return decodeMemberText(readArchive(bytes, options), path);
}

/** Read one member as raw bytes. */
export function readArchiveBytes(
  bytes: Uint8Array,
  path: string,
  options?: ArchiveReadOptions,
): Uint8Array {
  const files = readArchive(bytes, options);
  const member = files.find((file) => file.path === path);
  if (!member) {
    throw archiveError('ARCHIVE_MEMBER_MISSING', { memberCount: files.length });
  }
  return member.bytes;
}

/** Parse one member as JSON. */
export function readArchiveJson(
  bytes: Uint8Array,
  path: string,
  options?: ArchiveReadOptions,
): unknown {
  return decodeArchiveJsonMember(readArchive(bytes, options), path);
}

// ── Read-only structural classification ───────────────────────────────────
//
// The two functions below read fixed ZIP header fields and nothing else. They
// never inflate a member, never reconstruct data, and never return bytes: the
// only thing a caller can do with their output is refuse an archive with a
// precise reason. That is the whole reason they live here, next to the codec
// that will do the real reading, rather than in a product module that would
// otherwise have to parse ZIP itself.

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const FIXED_LOCAL_HEADER_BYTES = 30;
const FIXED_CENTRAL_HEADER_BYTES = 46;

const UNIX_HOST_SYSTEM = 3;
const POSIX_MODE_MASK = 0o170000;
const POSIX_DIRECTORY = 0o040000;
const POSIX_SYMLINK = 0o120000;
const POSIX_REGULAR_FILE = 0o100000;

/** What a ZIP entry's recorded POSIX mode says the member *is*. */
export type ArchiveMemberType =
  | 'regular-file'
  | 'directory'
  | 'symlink'
  | 'other-special'
  | 'unknown';

function byteView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function utf8At(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, start + length));
}

/**
 * Classify the member type each central-directory entry records, for the entries
 * whose name is in `names`.
 *
 * A ZIP entry can claim to be a directory or a symbolic link. A backup member is
 * data, so a caller that intends to refuse those needs to be able to *see* them.
 * fflate's `unzipSync` reports only name, sizes, and compression, so this reads
 * the two fixed header fields that carry the claim: "version made by" (whose high
 * byte is the originating host system) and "external file attributes" (whose high
 * 16 bits are the POSIX mode, when the host is Unix).
 *
 * Only entries the caller asked about are reported, and an entry whose name does
 * not appear at all is simply absent from the result - a `Map`, because a member
 * name is attacker-controlled and must never become an object key.
 *
 * `unknown` is returned when the entry was not made on a Unix host, because an
 * MS-DOS or OS/2 host records no mode and interpreting zero as "regular file"
 * would be an invention.
 */
export function classifyArchiveMemberTypes(
  bytes: Uint8Array,
  names: readonly string[],
): Map<string, ArchiveMemberType> {
  const result = new Map<string, ArchiveMemberType>();
  if (!(bytes instanceof Uint8Array) || names.length === 0) return result;
  const wanted = new Set(names);
  const view = byteView(bytes);

  for (let index = 0; index + FIXED_CENTRAL_HEADER_BYTES <= bytes.length; index += 1) {
    if (view.getUint32(index, true) !== CENTRAL_HEADER_SIGNATURE) continue;
    const madeBy = view.getUint16(index + 4, true);
    const nameLength = view.getUint16(index + 28, true);
    const extraLength = view.getUint16(index + 30, true);
    const commentLength = view.getUint16(index + 32, true);
    const externalAttributes = view.getUint32(index + 38, true);
    const nameStart = index + FIXED_CENTRAL_HEADER_BYTES;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) continue;
    const name = utf8At(bytes, nameStart, nameLength);
    if (!wanted.has(name)) continue;
    // The next central header begins after this entry's variable-length fields.
    index = nameEnd + extraLength + commentLength - 1;

    const hostSystem = (madeBy >> 8) & 0xff;
    if (hostSystem !== UNIX_HOST_SYSTEM) {
      result.set(name, 'unknown');
      continue;
    }
    const mode = (externalAttributes >>> 16) & 0xffff;
    switch (mode & POSIX_MODE_MASK) {
      case POSIX_REGULAR_FILE:
        result.set(name, 'regular-file');
        break;
      case POSIX_DIRECTORY:
        result.set(name, 'directory');
        break;
      case POSIX_SYMLINK:
        result.set(name, 'symlink');
        break;
      default:
        result.set(name, mode === 0 ? 'unknown' : 'other-special');
        break;
    }
  }
  return result;
}

/**
 * Every member name the archive's central directory lists, in file order.
 *
 * This is the archive's own account of what it contains, and it is deliberately
 * *not* the same as what {@link readArchive} returns. fflate builds its result by
 * assigning each name onto an object, so a name that cannot be an ordinary key -
 * `__proto__` above all - changes the object's prototype instead of adding a
 * member, and that member's bytes are inflated and then silently discarded. A
 * caller that only ever sees `readArchive`'s result cannot tell "this archive had
 * no such member" from "this archive had a member I threw away".
 *
 * Comparing the two lists is therefore how a member is proven not to have been
 * dropped. Like the classifiers above this reads fixed header fields and inflates
 * nothing.
 */
export function readArchiveEntryNames(bytes: Uint8Array): string[] {
  if (!(bytes instanceof Uint8Array) || bytes.length < FIXED_CENTRAL_HEADER_BYTES) return [];
  const view = byteView(bytes);
  const names: string[] = [];
  for (let index = 0; index + FIXED_CENTRAL_HEADER_BYTES <= bytes.length; index += 1) {
    if (view.getUint32(index, true) !== CENTRAL_HEADER_SIGNATURE) continue;
    const nameLength = view.getUint16(index + 28, true);
    const extraLength = view.getUint16(index + 30, true);
    const commentLength = view.getUint16(index + 32, true);
    const nameStart = index + FIXED_CENTRAL_HEADER_BYTES;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) continue;
    names.push(utf8At(bytes, nameStart, nameLength));
    index = nameEnd + extraLength + commentLength - 1;
  }
  return names;
}

/** Why an archive could not be read, in terms of its own structure. */
export type UnreadableArchiveShape =
  | 'not-an-archive'
  | 'truncated-archive'
  | 'missing-central-directory'
  | 'unreadable-with-end-of-central-directory';

/**
 * Classify a ZIP the codec could not inflate.
 *
 * `unzip-failed` is one outcome for three different problems, and "your file is
 * corrupt" is not a useful thing to tell someone about a file they are about to
 * restore. This reads the local file headers - 30 fixed bytes each - and reports
 * which of the three it is:
 *
 * - **not-an-archive** - no local file header at all. The bytes are not a ZIP,
 *   so nothing in them is interpreted.
 * - **truncated-archive** - the last local file header found is not followed by
 *   all the bytes that header declares. The file stops mid-member.
 * - **missing-central-directory** - every local entry is intact but no member
 *   index follows, so no member can be addressed safely (plan section 7.3).
 * - **unreadable-with-end-of-central-directory** - an end-of-central-directory
 *   record is present, so the file is a ZIP whose index or member data is
 *   unusable; that is the codec's business, not this function's.
 *
 * Like {@link classifyArchiveMemberTypes} this inflates nothing and returns no
 * bytes.
 */
export function classifyUnreadableArchive(bytes: Uint8Array): UnreadableArchiveShape {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return 'not-an-archive';
  const view = byteView(bytes);
  let localHeaders = 0;
  let lastHeaderComplete = true;
  let sawEndOfCentralDirectory = false;

  for (let index = 0; index + 4 <= bytes.length; index += 1) {
    const signature = view.getUint32(index, true);
    if (signature === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      sawEndOfCentralDirectory = true;
      continue;
    }
    if (signature !== LOCAL_HEADER_SIGNATURE) continue;
    localHeaders += 1;
    if (index + FIXED_LOCAL_HEADER_BYTES > bytes.length) {
      lastHeaderComplete = false;
      break;
    }
    const compressedSize = view.getUint32(index + 18, true);
    const nameLength = view.getUint16(index + 26, true);
    const extraLength = view.getUint16(index + 28, true);
    const dataStart = index + FIXED_LOCAL_HEADER_BYTES + nameLength + extraLength;
    lastHeaderComplete = dataStart + compressedSize <= bytes.length;
  }

  if (localHeaders === 0) {
    return sawEndOfCentralDirectory
      ? 'unreadable-with-end-of-central-directory'
      : 'not-an-archive';
  }
  if (!lastHeaderComplete) return 'truncated-archive';
  if (sawEndOfCentralDirectory) return 'unreadable-with-end-of-central-directory';
  return 'missing-central-directory';
}
