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
 *   rejected *before* it is decompressed into memory.
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
};

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

function resolveLimits(limits?: Partial<ArchiveLimits>): ArchiveLimits {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...(limits ?? {}) };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Write a ZIP archive.
 *
 * Member order is preserved, so writing the same files twice produces
 * byte-identical output for the same `fflate` build.
 */
export function writeArchive(files: readonly ArchiveFile[]): Uint8Array {
  if (files.length > DEFAULT_ARCHIVE_LIMITS.maxMembers) {
    throw archiveError('ARCHIVE_MEMBER_LIMIT', { count: files.length });
  }
  const zippable: Zippable = {};
  for (const file of files) {
    assertSafeArchivePath(file.path);
    if (file.path in zippable) {
      throw archiveError('ARCHIVE_MALFORMED', { reason: 'duplicate-member' });
    }
    zippable[file.path] = [file.bytes.slice(), { level: 6 }];
  }
  return zipSync(zippable);
}

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
  limits?: Partial<ArchiveLimits>,
): ArchiveFile[] {
  const effective = resolveLimits(limits);
  if (!(bytes instanceof Uint8Array)) {
    throw archiveError('ARCHIVE_MALFORMED', { reason: 'not-bytes' });
  }

  let entryCount = 0;
  let totalBytes = 0;

  const filter = (file: { name: string; originalSize: number; size: number }): boolean => {
    entryCount += 1;
    if (entryCount > effective.maxMembers) {
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

/** Read one member as UTF-8 text. */
export function readArchiveText(
  bytes: Uint8Array,
  path: string,
  limits?: Partial<ArchiveLimits>,
): string {
  const files = readArchive(bytes, limits);
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

/** Read one member as raw bytes. */
export function readArchiveBytes(
  bytes: Uint8Array,
  path: string,
  limits?: Partial<ArchiveLimits>,
): Uint8Array {
  const files = readArchive(bytes, limits);
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
  limits?: Partial<ArchiveLimits>,
): unknown {
  const text = readArchiveText(bytes, path, limits);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw archiveError('ARCHIVE_MALFORMED', { reason: 'member-not-json' });
  }
}
