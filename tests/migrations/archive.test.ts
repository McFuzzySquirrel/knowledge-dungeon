/**
 * Archive round trip and hostile-archive rejection.
 *
 * Every fixture here is synthetic. The "hostile" archives are constructed in the
 * test itself from synthetic bytes; nothing is downloaded and no file system is
 * touched.
 */
import { describe, expect, it } from 'vitest';
import { zipSync, type Zippable } from 'fflate/browser';

import {
  assertSafeArchivePath,
  DEFAULT_ARCHIVE_LIMITS,
  describeUnsafeArchivePath,
  readArchive,
  readArchiveBytes,
  readArchiveJson,
  readArchiveText,
  writeArchive,
  writeArchiveJson,
  type ArchiveLimits,
} from '@/services/persistence/v2/archive';
import { isStorageV2Error, type StorageV2ErrorCode } from '@/services/persistence/v2/schema';

const encoder = new TextEncoder();

function expectArchiveError(code: StorageV2ErrorCode, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(isStorageV2Error(error)).toBe(true);
    if (isStorageV2Error(error)) {
      expect(error.code).toBe(code);
      return;
    }
  }
  throw new Error(`expected a ${code} archive error`);
}

describe('archive round trip', () => {
  it('round-trips JSON text and binary members exactly', () => {
    const json = { product: 'kdbak', memberCount: 2, nested: { b: 2, a: 1 } };
    const jsonText = JSON.stringify(json);
    const binary = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);

    const archive = writeArchiveJson([
      { path: 'manifest.json', json },
      { path: 'attachments/blob.bin', json: null },
    ]);
    // Rebuild with a real binary member so both kinds are exercised together.
    const mixed = writeArchive([
      { path: 'manifest.json', bytes: encoder.encode(jsonText) },
      { path: 'attachments/blob.bin', bytes: binary },
    ]);

    expect(readArchiveText(mixed, 'manifest.json')).toBe(jsonText);
    expect(readArchiveJson(mixed, 'manifest.json')).toEqual(json);
    expect(readArchiveBytes(mixed, 'attachments/blob.bin')).toEqual(binary);
    expect(archive.byteLength).toBeGreaterThan(0);
  });

  it('round-trips a member with the same bytes it was given', () => {
    const bytes = new Uint8Array(64 * 1024).map((_, index) => (index * 31) % 256);

    const archive = writeArchive([{ path: 'attachments/blob.bin', bytes }]);
    const [member] = readArchive(archive);

    expect(member?.path).toBe('attachments/blob.bin');
    expect(member?.bytes).toEqual(bytes);
  });

  it('round-trips an empty member and an empty archive', () => {
    const empty = writeArchive([]);
    expect(readArchive(empty)).toEqual([]);

    const withEmptyMember = writeArchive([{ path: 'recovery/empty.txt', bytes: new Uint8Array(0) }]);
    expect(readArchiveText(withEmptyMember, 'recovery/empty.txt')).toBe('');
  });

  it('is byte-stable for identical input', () => {
    const files = [
      { path: 'manifest.json', bytes: encoder.encode('{"product":"kdbak"}') },
      { path: 'state.json', bytes: encoder.encode('{"subjects":[]}') },
    ];

    expect(writeArchive(files)).toEqual(writeArchive(files));
  });

  it('reports a missing member rather than returning undefined', () => {
    const archive = writeArchive([{ path: 'manifest.json', bytes: encoder.encode('{}') }]);

    expectArchiveError('ARCHIVE_MEMBER_MISSING', () => readArchiveText(archive, 'state.json'));
  });
});

describe('member path safety', () => {
  const unsafePaths: [string, string][] = [
    ['/etc/passwd', 'absolute-path'],
    ['../escape.json', 'parent-traversal'],
    ['a/../../escape.json', 'parent-traversal'],
    ['C:/windows/system.ini', 'drive-letter'],
    ['..\\escape.json', 'backslash-separator'],
    ['nested/../../escape', 'parent-traversal'],
    ['', 'empty-path'],
    ['a//b.json', 'empty-segment'],
    ['//server/share/file', 'unc-path'],
  ];

  for (const [path, reason] of unsafePaths) {
    it(`rejects "${reason}" member paths on write and on read`, () => {
      expect(describeUnsafeArchivePath(path)).toBe(reason);
      expectArchiveError('ARCHIVE_UNSAFE_PATH', () =>
        writeArchive([{ path, bytes: encoder.encode('{}') }]),
      );

      // A hostile archive is built with the raw library, bypassing this
      // module's writer, to prove the reader defends itself.
      const hostile = zipSync({ [path]: encoder.encode('{}') } as Zippable);
      expectArchiveError('ARCHIVE_UNSAFE_PATH', () => readArchive(hostile));
    });
  }

  it('rejects a control character in a member path', () => {
    expect(describeUnsafeArchivePath('a\u0000b.json')).toBe('control-character');
    expectArchiveError('ARCHIVE_UNSAFE_PATH', () => assertSafeArchivePath('a\u0000b.json'));
  });

  it('accepts ordinary product member paths', () => {
    for (const path of ['manifest.json', 'state.json', 'subject.json', 'attachments/abc123', 'recovery/r1.txt']) {
      expect(describeUnsafeArchivePath(path)).toBeNull();
    }
  });
});

describe('hostile archive limits', () => {
  it('refuses an archive with more members than the limit', () => {
    const limits: Partial<ArchiveLimits> = { maxMembers: 3 };
    const many = writeArchive(
      Array.from({ length: 4 }, (_, index) => ({
        path: `attachments/blob-${index}.bin`,
        bytes: encoder.encode('synthetic'),
      })),
    );

    expectArchiveError('ARCHIVE_MEMBER_LIMIT', () => readArchive(many, limits));
  });

  it('refuses a member larger than the per-member limit before decompressing', () => {
    const limits: Partial<ArchiveLimits> = { maxMemberBytes: 1024 };
    const large = writeArchive([
      { path: 'attachments/blob.bin', bytes: new Uint8Array(4096).fill(7) },
    ]);

    expectArchiveError('ARCHIVE_MEMBER_TOO_LARGE', () => readArchive(large, limits));
  });

  it('refuses a total decompressed size over the total limit', () => {
    const limits: Partial<ArchiveLimits> = { maxTotalBytes: 2048, maxMemberBytes: 1024 };
    const many = writeArchive(
      Array.from({ length: 4 }, (_, index) => ({
        path: `attachments/blob-${index}.bin`,
        bytes: new Uint8Array(1024).fill(3),
      })),
    );

    expectArchiveError('ARCHIVE_TOTAL_TOO_LARGE', () => readArchive(many, limits));
  });

  it('refuses a ratio bomb', () => {
    // 8 MiB of zeroes deflates to a few KiB: a legitimate-looking member that
    // expands far beyond its stored size.
    const bomb = zipSync(
      { 'attachments/bomb.bin': [new Uint8Array(8 * 1024 * 1024), { level: 9 }] } as unknown as Zippable,
      { level: 9 },
    );

    expectArchiveError('ARCHIVE_RATIO_EXCEEDED', () =>
      readArchive(bomb, { maxCompressionRatio: 50, maxMemberBytes: 64 * 1024 * 1024 }),
    );
  });

  it('refuses a duplicate member path', () => {
    const duplicate = [
      { path: 'manifest.json', bytes: encoder.encode('{}') },
      { path: 'manifest.json', bytes: encoder.encode('{}') },
    ];

    expectArchiveError('ARCHIVE_MALFORMED', () => writeArchive(duplicate));
  });

  it('refuses input that is not a byte array', () => {
    expectArchiveError('ARCHIVE_MALFORMED', () => readArchive('not-bytes' as unknown as Uint8Array));
  });

  it('ships defaults that bound a product archive', () => {
    expect(DEFAULT_ARCHIVE_LIMITS.maxMembers).toBeGreaterThan(0);
    expect(DEFAULT_ARCHIVE_LIMITS.maxMemberBytes).toBeLessThan(DEFAULT_ARCHIVE_LIMITS.maxTotalBytes);
    expect(DEFAULT_ARCHIVE_LIMITS.maxCompressionRatio).toBeGreaterThan(1);
  });
});

describe('archive text handling', () => {
  it('refuses a member that is not valid UTF-8', () => {
    const archive = writeArchive([{ path: 'state.json', bytes: new Uint8Array([0xff, 0xfe, 0xfd]) }]);

    expectArchiveError('ARCHIVE_MALFORMED', () => readArchiveText(archive, 'state.json'));
  });

  it('refuses a member that is not JSON', () => {
    const archive = writeArchive([{ path: 'manifest.json', bytes: encoder.encode('not json') }]);

    expectArchiveError('ARCHIVE_MALFORMED', () => readArchiveJson(archive, 'manifest.json'));
  });
});
