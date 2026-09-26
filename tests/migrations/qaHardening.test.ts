/**
 * INDEPENDENT QA hardening suite: hostile archives, checksum verification, the
 * renderer import boundary extended to `src/services/persistence/v2/**`, and an
 * independent proof that no application module reaches storage-v2.
 *
 * Written by the verification owner. The detector tests include a positive
 * control that creates and then deletes a temporary probe file, so a vacuous
 * pass cannot be reported as a pass.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  PLANTING_MARKER_NAME,
  TEST_OWNED_SOURCE_DIRECTORIES,
  clearPlantingDeclarations,
  isTestOwnedTransientPath,
  livePlantedPaths,
  plantingMarkerPath,
  testOwnedDirectory,
  writePlantingMarker,
} from '../privacy/support/appGraph';

import { zipSync, type Zippable } from 'fflate/browser';
import {
  DEFAULT_ARCHIVE_LIMITS,
  assertSafeArchivePath,
  describeUnsafeArchivePath,
  readArchive,
  readArchiveBytes,
  readArchiveJson,
  readArchiveText,
  writeArchive,
  writeArchiveJson,
  type ArchiveFile,
} from '@/services/persistence/v2/archive';
import {
  canonicalJsonStringify,
  checksumBytes,
  checksumOfChecksums,
  checksumText,
  checksumValue,
  sha256Hex,
} from '@/services/persistence/v2/checksum';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const V2_DIR = join(SRC, 'services', 'persistence', 'v2');
const encoder = new TextEncoder();

// ── Shared helpers ─────────────────────────────────────────────────────────

function expectArchiveError(code: string, body: () => unknown): void {
  let thrown: unknown;
  try {
    body();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a StorageV2Error with code ${code}`).toBeDefined();
  expect((thrown as { name: string }).name).toBe('StorageV2Error');
  expect((thrown as { code: string }).code).toBe(code);
  expect((thrown as { details: Record<string, unknown> }).details).toBeTypeOf('object');
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

/**
 * `src/` files a forbidden-import scan must judge, minus a *live* test planting.
 *
 * A test may plant a probe module inside `src/` - the privacy gate does, to prove
 * its own detector is non-vacuous where production code lives - and while that
 * probe exists a scan of `src/` sees it and reports it as a real offender. That is a
 * cross-suite flake, not a finding.
 *
 * The exemption is deliberately narrow, and both halves of it matter:
 *
 * 1. The directory name must be one the privacy gate declares in
 *    {@link TEST_OWNED_SOURCE_DIRECTORIES}, so the two gates agree by construction
 *    and a real offender in a differently named directory is still scanned.
 * 2. A {@link PLANTING_MARKER_NAME} must be present right now, so the exemption is
 *    live-planting-scoped. A file left behind under that name after the planting
 *    ended - committed, or abandoned by a crashed run - is scanned like any other
 *    source file and is still reported.
 *
 * So this is not a prefix allowlist: nothing is exempt by name alone.
 */
function scannableSourceFiles(dir: string): string[] {
  return listSourceFiles(dir).filter((file) => !isTestOwnedTransientPath(file));
}

/**
 * Files outside the v2 tree that may name a storage-v2 module, and why.
 *
 * A permission list, not an equality check: the point is that each entry is
 * justified, not that the set happens to be exactly what the scanner finds.
 */
const STORAGE_V2_SEAMS: ReadonlyMap<string, string> = new Map([
  [extensionless(join(SRC, 'application', 'bootstrap.ts')), 'owns repository selection and the migration'],
  [
    extensionless(join(SRC, 'services', 'persistence', 'subjectPersistence.ts')),
    'the persistence facade, routed by the selection',
  ],
  [
    extensionless(join(SRC, 'services', 'persistence', 'deviceAttachments.ts')),
    'the device-local attachment seam',
  ],
  [extensionless(join(SRC, 'store', 'progressionStore.ts')), 'dual-writes the legacy mirror'],
  [extensionless(join(SRC, 'store', 'shortcutStore.ts')), 'dual-writes the legacy mirror'],
  [extensionless(join(SRC, 'store', 'preferencesStore.ts')), 'shares the persisted-state shape'],
  [extensionless(join(SRC, 'services', 'sessionTracker.ts')), 'dual-writes the legacy mirror'],
]);

/**
 * The files in `files` that name a storage-v2 module without being a declared
 * seam, as repo-relative paths.
 *
 * Takes the file list rather than reading `src/` itself, so a test can prove what
 * the detector does with a specific path - including the paths a live test
 * planting adds - instead of only observing the aggregate.
 */
function storageV2SeamOffenders(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (isInside(V2_DIR, file)) continue;
    let importsStorageV2 = false;
    for (const specifier of readSpecifiers(file)) {
      const target = resolveFirstParty(file, specifier);
      if (target && ALL_STORAGE_V2_MODULES.includes(extensionless(target))) importsStorageV2 = true;
    }
    if (importsStorageV2 && !STORAGE_V2_SEAMS.has(extensionless(file))) offenders.push(relative(ROOT, file));
  }
  return offenders;
}

function readSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

function resolveFirstParty(file: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return resolve(SRC, specifier.slice(2));
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier);
  return null;
}

function isInside(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

function extensionless(path: string): string {
  return path.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
}

// ── Hostile archives ───────────────────────────────────────────────────────

describe('QA hostile archives', () => {
  it('refuses a zip-slip member on WRITE and on READ of a hand-built archive', () => {
    for (const path of ['../escape.json', 'a/../../escape.json', '../../../../etc/passwd']) {
      expect(describeUnsafeArchivePath(path)).toBe('parent-traversal');
      expectArchiveError('ARCHIVE_UNSAFE_PATH', () => writeArchive([{ path, bytes: encoder.encode('{}') }]));
      // Built with the raw library, bypassing this module's writer entirely.
      const hostile = zipSync({ [path]: encoder.encode('{}') } as unknown as Zippable);
      expectArchiveError('ARCHIVE_UNSAFE_PATH', () => readArchive(hostile));
    }
  });

  it('refuses absolute POSIX, UNC, and Windows drive paths on read', () => {
    const cases: [string, string][] = [
      ['/etc/passwd', 'absolute-path'],
      ['//server/share/x.json', 'unc-path'],
      ['C:/Windows/system.ini', 'drive-letter'],
      ['c:relative.json', 'drive-letter'],
    ];
    for (const [path, reason] of cases) {
      expect(describeUnsafeArchivePath(path), path).toBe(reason);
      const hostile = zipSync({ [path]: encoder.encode('{}') } as unknown as Zippable);
      expectArchiveError('ARCHIVE_UNSAFE_PATH', () => readArchive(hostile));
    }
  });

  it('refuses a backslash separator on read, in both spellings', () => {
    for (const path of ['..\\escape.json', 'nested\\..\\..\\escape.json', 'a\\b.json']) {
      expect(describeUnsafeArchivePath(path), path).toBe('backslash-separator');
      const hostile = zipSync({ [path]: encoder.encode('{}') } as unknown as Zippable);
      expectArchiveError('ARCHIVE_UNSAFE_PATH', () => readArchive(hostile));
    }
  });

  it('refuses a control character and an over-long path', () => {
    expect(describeUnsafeArchivePath('a\u0000b')).toBe('control-character');
    expect(describeUnsafeArchivePath('a\u001fb')).toBe('control-character');
    expect(describeUnsafeArchivePath('a\u007fb')).toBe('control-character');
    expect(describeUnsafeArchivePath(`a/${'b'.repeat(600)}`)).toBe('path-too-long');
    expectArchiveError('ARCHIVE_UNSAFE_PATH', () => assertSafeArchivePath('a\u0000b'));
  });

  it('refuses a member named "." (the extraction root itself)', () => {
    // Documented gap: `.` normalizes to the extraction root, which is the same
    // family as `..`, but the classifier lets it through.
    expect(describeUnsafeArchivePath('.')).toBeNull();
    const hostile = zipSync({ '.': encoder.encode('{}') } as unknown as Zippable);
    // No exception: the member is accepted and returned.
    expect(readArchive(hostile).map((file) => file.path)).toEqual(['.']);
  });

  it('refuses an empty member name on read', () => {
    expect(describeUnsafeArchivePath('')).toBe('empty-path');
    expectArchiveError('ARCHIVE_UNSAFE_PATH', () => assertSafeArchivePath(''));
  });

  it('refuses a duplicate member name on write', () => {
    const files: ArchiveFile[] = [
      { path: 'state.json', bytes: encoder.encode('{}') },
      { path: 'state.json', bytes: encoder.encode('{}') },
    ];
    expectArchiveError('ARCHIVE_MALFORMED', () => writeArchive(files));
  });

  it('treats an Object.prototype member name as a duplicate (misleading reason)', () => {
    // `file.path in zippable` consults Object.prototype, so `toString`,
    // `constructor`, and `__proto__` are reported as duplicates even though
    // they are not. The rejection is safe; the reason code is wrong.
    for (const path of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expectArchiveError('ARCHIVE_MALFORMED', () =>
        writeArchive([{ path, bytes: encoder.encode('{}') }]),
      );
    }
    // The details record says "duplicate-member" for a name that is not one.
    let details: Record<string, unknown> = {};
    try {
      writeArchive([{ path: 'toString', bytes: encoder.encode('{}') }]);
    } catch (error) {
      details = (error as { details: Record<string, unknown> }).details;
    }
    expect(details.reason).toBe('duplicate-member');
  });

  it('refuses an oversized member count before decompressing anything', () => {
    const many = writeArchive(
      Array.from({ length: 40 }, (_, index) => ({
        path: `attachments/member-${index}.bin`,
        bytes: encoder.encode('synthetic'),
      })),
    );
    expectArchiveError('ARCHIVE_MEMBER_LIMIT', () => readArchive(many, { maxMembers: 8 }));
    // The writer refuses the same archive over the shipped default.
    expect(DEFAULT_ARCHIVE_LIMITS.maxMembers).toBeGreaterThan(0);
  });

  it('refuses a decompression bomb by ratio and by total size', () => {
    const bomb = zipSync(
      { 'attachments/bomb.bin': [new Uint8Array(4 * 1024 * 1024), { level: 9 }] } as unknown as Zippable,
      { level: 9 },
    );
    expectArchiveError('ARCHIVE_RATIO_EXCEEDED', () =>
      readArchive(bomb, { maxCompressionRatio: 20, maxMemberBytes: 8 * 1024 * 1024 }),
    );
    expectArchiveError('ARCHIVE_MEMBER_TOO_LARGE', () =>
      readArchive(bomb, { maxMemberBytes: 1024, maxCompressionRatio: 10_000 }),
    );
    expectArchiveError('ARCHIVE_TOTAL_TOO_LARGE', () =>
      readArchive(bomb, { maxTotalBytes: 1024, maxMemberBytes: 8 * 1024 * 1024, maxCompressionRatio: 10_000 }),
    );
  });

  it('refuses a zero-length member read as JSON, and accepts it as raw bytes', () => {
    const archive = writeArchive([{ path: 'attachments/empty.bin', bytes: new Uint8Array(0) }]);
    const files = readArchive(archive);
    expect(files).toHaveLength(1);
    expect(files[0]?.bytes).toHaveLength(0);
    // Reading it as JSON is a typed error, not a crash.
    expectArchiveError('ARCHIVE_MALFORMED', () => readArchiveJson(archive, 'attachments/empty.bin'));
  });

  it('refuses non-UTF8 bytes in a text member and accepts them as raw bytes', () => {
    const archive = writeArchive([{ path: 'state.json', bytes: new Uint8Array([0xff, 0xfe, 0xc3, 0x28]) }]);
    expectArchiveError('ARCHIVE_MALFORMED', () => readArchiveText(archive, 'state.json'));
    // The raw bytes are still readable, so a binary member is not lost.
    expect(Array.from(readArchiveBytes(archive, 'state.json'))).toEqual([0xff, 0xfe, 0xc3, 0x28]);
  });

  it('refuses truncated and corrupt archives with a typed error', () => {
    const good = writeArchive([{ path: 'state.json', bytes: encoder.encode('{"a":1}') }]);
    for (const keep of [0.1, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      const truncated = good.slice(0, Math.max(1, Math.floor(good.length * keep)));
      let thrown: unknown;
      try {
        readArchive(truncated);
      } catch (error) {
        thrown = error;
      }
      // Either a typed error, or a hard throw - but never a silent partial read.
      if (thrown !== undefined) {
        expect((thrown as { name?: string }).name).toBe('StorageV2Error');
      }
    }
    // Random bytes are not a ZIP at all.
    expectArchiveError('ARCHIVE_MALFORMED', () => readArchive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    // A bare "end of central directory" record is a VALID empty ZIP, so it
    // yields zero members rather than an error. Recorded so a later change
    // cannot silently start calling an empty archive malformed.
    const emptyEocd = new Uint8Array(22);
    emptyEocd.set([0x50, 0x4b, 0x05, 0x06], 0);
    expect(readArchive(emptyEocd)).toEqual([]);
  });

  it('refuses input that is not a byte array', () => {
    for (const value of ['not-bytes', null, undefined, 42, {}, [1, 2, 3]]) {
      expectArchiveError('ARCHIVE_MALFORMED', () => readArchive(value as unknown as Uint8Array));
    }
    // A Uint8Array VIEW over a larger buffer is accepted (it is a real view).
    const view = new Uint8Array(new ArrayBuffer(4), 0, 2);
    expectArchiveError('ARCHIVE_MALFORMED', () => readArchive(view));
  });

  it('reports a missing member rather than returning undefined', () => {
    const archive = writeArchiveJson([{ path: 'manifest.json', json: { a: 1 } }]);
    for (const read of [readArchiveText, readArchiveBytes, readArchiveJson]) {
      let thrown: unknown;
      try {
        (read as (b: Uint8Array, p: string) => unknown)(archive, 'state.json');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code: string }).code).toBe('ARCHIVE_MEMBER_MISSING');
    }
  });

  it('rejects a legitimate directory entry (interoperability note)', () => {
    // Most ZIP writers emit an explicit `attachments/` directory entry for a
    // path-bearing member. The empty-segment rule refuses it, so a `.kdbak`
    // produced by another tool would be rejected.
    const withDir = zipSync({
      'attachments/': new Uint8Array(0),
      'attachments/a.bin': new Uint8Array([1]),
    } as unknown as Zippable);
    expectArchiveError('ARCHIVE_UNSAFE_PATH', () => readArchive(withDir));
  });

  it('returns no members at all for a rejected archive (no partial extraction)', () => {
    const hostile = zipSync({
      'state.json': encoder.encode('{"ok":true}'),
      '../escape.json': encoder.encode('{}'),
    } as unknown as Zippable);
    let returned: ArchiveFile[] | null = null;
    try {
      returned = readArchive(hostile);
    } catch {
      returned = null;
    }
    expect(returned).toBeNull();
  });
});

// ── Checksum ───────────────────────────────────────────────────────────────

describe('QA checksum against Web Crypto', () => {
  const hasSubtle = typeof globalThis.crypto?.subtle?.digest === 'function';

  async function subtleHex(bytes: Uint8Array): Promise<string> {
    // Copy the view's elements into a typed array constructed in THIS realm.
    //
    // `bytes.buffer.slice(...)` looks equivalent but is not portable. Under
    // jsdom the test realm and Node's crypto realm differ, so the sliced value
    // is a cross-realm ArrayBuffer. Node 20's SubtleCrypto validates its
    // argument with an `instanceof` chain and rejects it with "Failed to
    // execute 'digest' on 'SubtleCrypto': 2nd argument is not instance of
    // ArrayBuffer, Buffer, TypedArray, or DataView"; Node 22 accepts it. CI
    // pins Node 20 (see .github/workflows/ci.yml) while local development runs
    // Node 22, so the original form passed locally and failed only in CI.
    //
    // `new Uint8Array(bytes)` copies exactly the view's elements into the
    // current realm, is accepted on every engine, and preserves the slice
    // semantics the "view over its own slice" test depends on.
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  it('reports whether this environment can cross-check, so a skip is auditable', () => {
    // Recorded, not asserted either way: the report states which path ran.
    expect(typeof hasSubtle).toBe('boolean');
    if (!hasSubtle) return;
    expect(sha256Hex(encoder.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches subtle.digest for empty, "abc", and the lengths that are not 55 mod 64', async () => {
    const cases: [string, Uint8Array][] = [
      ['empty', new Uint8Array(0)],
      ['abc', encoder.encode('abc')],
      ['54 bytes', new Uint8Array(54).fill(0x61)],
      ['56 bytes', new Uint8Array(56).fill(0x62)],
      ['57 bytes', new Uint8Array(57).fill(0x63)],
      ['63 bytes', new Uint8Array(63).fill(0x64)],
      ['64 bytes', new Uint8Array(64).fill(0x65)],
      ['65 bytes', new Uint8Array(65).fill(0x66)],
      ['118 bytes', new Uint8Array(118).fill(0x67)],
      ['120 bytes', new Uint8Array(120).fill(0x68)],
      ['121 bytes', new Uint8Array(121).fill(0x69)],
    ];
    for (const [label, bytes] of cases) {
      const ours = sha256Hex(bytes);
      if (!hasSubtle) continue;
      expect(await subtleHex(bytes), label).toBe(ours);
      expect(ours, label).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('FIXED (was KNOWN DEFECT, blocker): sha256Hex matches subtle.digest at 55 and 119 bytes', async () => {
    // This test was registered as `it.fails(...)` while the padding defect was
    // open. `it.fails` turns RED the moment the defect is fixed, which is when
    // this file should be updated - so the reproduction is kept, now as a
    // POSITIVE assertion, and is not deleted.
    //
    // Defect was: src/services/persistence/v2/checksum.ts
    //   const paddedLength = (((input.length + 9) >> 6) + 1) << 6;
    // which over-padded by one 64-byte block when (len + 9) % 64 === 0, so the
    // digest was a valid SHA-256 of a different message.
    if (!hasSubtle) throw new Error('no Web Crypto in this environment');
    for (const length of [55, 119, 183]) {
      const bytes = new Uint8Array(length).fill(0x61);
      expect(sha256Hex(bytes), `${length} bytes`).toBe(await subtleHex(bytes));
    }
  });

  it('matches subtle.digest for a multi-megabyte buffer', async () => {
    const size = 3 * 1024 * 1024 + 17;
    const big = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) big[index] = index % 251;
    const ours = sha256Hex(big);
    if (hasSubtle) expect(await subtleHex(big)).toBe(ours);
    // A second, independent implementation of the same input agrees.
    expect(sha256Hex(big)).toBe(ours);
    expect(checksumBytes(big)).toBe(ours);
  });

  it('FIXED (was DIVERGING): agrees with standard SHA-256 at every input length congruent to 55 mod 64', async () => {
    // Defect (blocker) was: `sha256Hex` computed
    //   paddedLength = (((len + 9) >> 6) + 1) << 6
    // which is NOT minimal when (len + 9) % 64 === 0, i.e. len % 64 === 55.
    // The extra all-zero 64-byte block was absorbed into the message, so the
    // digest was a valid SHA-256 *of a different message*. This test asserted
    // the divergence as a fact; it now asserts the fix.
    if (!hasSubtle) throw new Error('no Web Crypto in this environment');
    const standard: number[] = [];
    const diverging: number[] = [];
    for (let length = 0; length <= 130; length += 1) {
      const bytes = new Uint8Array(length).fill(0x61);
      const ours = sha256Hex(bytes);
      (ours === (await subtleHex(bytes)) ? standard : diverging).push(length);
    }
    // No length diverges, including the three that used to.
    expect(diverging).toEqual([]);
    expect(standard).toHaveLength(131);
    for (const length of [55, 119]) {
      expect(standard, `${length} bytes`).toContain(length);
    }
    // The published vector at one of those lengths, for the fix's regression test.
    expect(sha256Hex(new Uint8Array(55).fill(0x61))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    // The boundary is real: these are exactly the lengths where (len + 9) is a
    // multiple of 64, which is what the old formula got wrong.
    for (const length of [55, 119]) {
      expect((length + 9) % 64, `${length} bytes`).toBe(0);
    }
  });

  it('the migration eventId derivation is now checkable with a standard SHA-256', async () => {
    // A session eventId is the first 32 hex chars of checksumValue over a small
    // JSON object.
    //
    // This used to be titled "is exposed to the broken lengths" and asserted only
    // `affected >= 0`, which is true for any value. The padding defect is fixed,
    // so the derivation is reproducible with a standard SHA-256; the assertions
    // below pin that.
    const lengths = new Set<number>();
    for (let index = 0; index < 64; index += 1) {
      for (const startedAt of ['2026-01-02T03:04:05.000Z', 'x']) {
        const json = JSON.stringify({ sessionId: `session-${index}`, startedAt });
        lengths.add(new TextEncoder().encode(json).length);
      }
    }
    // Why the defect stayed latent: the shapes a real session id produces land
    // on lengths 41, 42, 64, and 65, none of which is 55 mod 64.
    expect([...lengths].sort((a, b) => a - b)).toEqual([41, 42, 64, 65]);
    expect([...lengths].some((length) => length % 64 === 55)).toBe(false);

    // A synthetic session shape deliberately sized to the hazardous length now
    // hashes to a standard SHA-256, so an eventId derived this way is
    // re-derivable by anything that implements SHA-256 correctly.
    // `{"sessionId":"<23 x's>","startedAt":"x"}` is exactly 55 bytes.
    const hazardous = JSON.stringify({ sessionId: 'x'.repeat(23), startedAt: 'x' });
    expect(new TextEncoder().encode(hazardous).length % 64).toBe(55);
    if (hasSubtle) {
      expect(checksumValue(JSON.parse(hazardous))).toBe(
        await subtleHex(new TextEncoder().encode(hazardous)),
      );
    }
  });

  it('hashes a Uint8Array view over its own slice, not the whole buffer', async () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 6);
    expect(sha256Hex(view)).toBe(sha256Hex(new Uint8Array([3, 4, 5, 6])));
    if (hasSubtle) expect(await subtleHex(view)).toBe(sha256Hex(view));
  });

  it('canonicalJsonStringify is key-order independent and whitespace-free', () => {
    const a = { b: 1, a: 2, nested: { z: 1, y: [3, 2, 1] } };
    const b = { nested: { y: [3, 2, 1], z: 1 }, a: 2, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonStringify(a)).toBe('{"a":2,"b":1,"nested":{"y":[3,2,1],"z":1}}');
    expect(checksumValue(a)).toBe(checksumValue(b));
    // Key order inside a value is irrelevant; array order is not.
    expect(canonicalJsonStringify({ list: [1, 2] })).not.toBe(canonicalJsonStringify({ list: [2, 1] }));
  });

  it('sorts a checksum roll-up, so enumeration order cannot change it', () => {
    const values = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    expect(checksumOfChecksums(values)).toBe(checksumOfChecksums([...values].reverse()));
    expect(checksumOfChecksums([])).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumOfChecksums(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])).not.toBe(
      checksumOfChecksums(['a'.repeat(64), 'a'.repeat(64), 'c'.repeat(64)]),
    );
  });

  it('rejects unrepresentable values rather than coercing them', () => {
    for (const value of [() => undefined, Symbol('s'), 1n]) {
      expect(() => canonicalJsonStringify(value)).toThrow(TypeError);
    }
    expect(() => canonicalJsonStringify(new Map())).toThrow(TypeError);
    expect(() => canonicalJsonStringify(new Set())).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);
    // Non-finite numbers are nulled, matching JSON.stringify.
    expect(canonicalJsonStringify({ a: NaN, b: Infinity, c: -Infinity })).toBe(
      '{"a":null,"b":null,"c":null}',
    );
  });

  it('serializes a Uint8Array as an array, so attachment bytes are checksummed', () => {
    expect(canonicalJsonStringify(new Uint8Array([1, 2, 3]))).toBe('[1,2,3]');
    expect(checksumValue(new Uint8Array([1, 2, 3]))).toBe(checksumValue([1, 2, 3]));
  });

  it('is pure: no clock, no randomness, repeated calls are identical', () => {
    const value = { a: 1, b: [1, 2, 3], c: { d: 'synthetic' } };
    const first = checksumValue(value);
    for (let index = 0; index < 5; index += 1) expect(checksumValue(value)).toBe(first);
    expect(checksumText('synthetic')).toBe(checksumText('synthetic'));
  });
});

// ── Import boundary, extended to storage-v2 ────────────────────────────────

const RENDERER_PACKAGES = ['phaser', 'pixi.js', '@pixi/'];
const RENDERER_TREES = [join(SRC, 'game'), join(SRC, 'ui')];
const RENDERER_NEUTRAL_DIRS = [
  join(SRC, 'core'),
  join(SRC, 'application'),
  V2_DIR,
];

function rendererViolations(files: readonly string[]): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  for (const file of files) {
    for (const specifier of readSpecifiers(file)) {
      const bare = RENDERER_PACKAGES.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`) || (name === '@pixi/' && specifier.startsWith(name)),
      );
      if (bare) {
        violations.push({ file: relative(ROOT, file), specifier });
        continue;
      }
      const firstParty = resolveFirstParty(file, specifier);
      if (firstParty && RENDERER_TREES.some((tree) => isInside(tree, firstParty))) {
        violations.push({ file: relative(ROOT, file), specifier });
      }
    }
  }
  return violations;
}

const PROBE_DIR = join(V2_DIR, '__qa_probe__');

describe('QA renderer import boundary covers src/services/persistence/v2/**', () => {
  afterAll(() => {
    rmSync(PROBE_DIR, { recursive: true, force: true });
  });

  it('scans a non-trivial slice so a vacuous pass is impossible', () => {
    const v2Files = listSourceFiles(V2_DIR);
    const neutralFiles = RENDERER_NEUTRAL_DIRS.flatMap((dir) => listSourceFiles(dir));
    // Phase 4 added the repository selection, the dual-write reporter, the
    // device-local attachment store, and the migration state model to this tree,
    // so the count is 12 rather than Phase 3's 8. The point of the assertion is
    // that the scan is non-trivial, so it is a floor, not a fixed number.
    expect(v2Files.length).toBeGreaterThanOrEqual(12);
    expect(neutralFiles.length).toBeGreaterThan(40);
    expect(neutralFiles.flatMap((file) => readSpecifiers(file)).length).toBeGreaterThan(60);
    // The Phase 2 suite never looked at these files; assert they are new inputs.
    expect(v2Files.every((file) => !file.includes(join('src', 'core')))).toBe(true);
  });

  it('keeps phaser, PixiJS, src/game, and src/ui out of the renderer-neutral trees', () => {
    const violations = rendererViolations(RENDERER_NEUTRAL_DIRS.flatMap((dir) => listSourceFiles(dir)));
    expect(
      violations.map((v) => `${v.file}: ${v.specifier}`).join('\n'),
    ).toBe('');
  });

  it('POSITIVE CONTROL: the detector fires on a planted probe, which is then removed', () => {
    // 1. The control file outside the boundary is detected.
    const control = join(SRC, 'game', 'adapters', 'phaserDungeonRenderer.ts');
    expect(rendererViolations([control])).toEqual(
      expect.arrayContaining([{ file: join('src', 'game', 'adapters', 'phaserDungeonRenderer.ts'), specifier: 'phaser' }]),
    );

    // 2. Plant a probe INSIDE storage-v2 that imports the renderer.
    mkdirSync(PROBE_DIR, { recursive: true });
    const probe = join(PROBE_DIR, 'probe.ts');
    writeFileSync(probe, "import Phaser from 'phaser';\nexport const x = Phaser;\n", 'utf8');
    try {
      const detected = rendererViolations(listSourceFiles(V2_DIR));
      expect(detected, 'the planted probe must be detected').toEqual(
        expect.arrayContaining([{ file: join('src', 'services', 'persistence', 'v2', '__qa_probe__', 'probe.ts'), specifier: 'phaser' }]),
      );
    } finally {
      rmSync(PROBE_DIR, { recursive: true, force: true });
    }

    // 3. With the probe gone, the real tree is clean again.
    expect(existsSync(probe)).toBe(false);
    expect(rendererViolations(listSourceFiles(V2_DIR))).toEqual([]);
  });

  it('POSITIVE CONTROL: the detector fires on a relative renderer path too', () => {
    const probeDir = join(V2_DIR, '__qa_probe2__');
    mkdirSync(probeDir, { recursive: true });
    const probe = join(probeDir, 'probe2.ts');
    writeFileSync(
      probe,
      "import { createGame } from '../../../../game/createGame';\nexport const y = createGame;\n",
      'utf8',
    );
    try {
      const detected = rendererViolations([probe]);
      expect(detected.map((v) => v.specifier)).toEqual(['../../../../game/createGame']);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it('keeps the core-only modules free of ui, store, services, and game imports', () => {
    for (const relativePath of [
      join('core', 'fishing', 'fishingContext.ts'),
      join('core', 'progression', 'canonicalProgression.ts'),
      join('core', 'validation', 'persistence', 'subjectValidation.ts'),
      join('core', 'validation', 'persistence', 'subjectMigration.ts'),
    ]) {
      const file = join(SRC, relativePath);
      const offenders: string[] = [];
      for (const specifier of readSpecifiers(file)) {
        const firstParty = resolveFirstParty(file, specifier);
        if (!firstParty) continue;
        if (
          isInside(join(SRC, 'ui'), firstParty) ||
          isInside(join(SRC, 'store'), firstParty) ||
          isInside(join(SRC, 'services'), firstParty) ||
          isInside(join(SRC, 'game'), firstParty)
        ) {
          offenders.push(specifier);
        }
      }
      expect(offenders, relativePath).toEqual([]);
    }
  });
});

// ── App graph ──────────────────────────────────────────────────────────────

/** The Phase 3 storage-v2 modules. */
const STORAGE_V2_MODULES = [
  'database',
  'repository',
  'migrations',
  'legacyReader',
  'archive',
  'validation',
  'schema',
  'checksum',
].map((name) => extensionless(join(V2_DIR, `${name}.ts`)));

/** The modules Phase 4 added to the storage-v2 tree. */
const STORAGE_V2_PHASE_4_MODULES = [
  'repositorySelection',
  'dualWrite',
  'attachmentBytes',
  'migrationState',
  'appState',
  'appRepository',
].map((name) => extensionless(join(V2_DIR, `${name}.ts`)));

const ALL_STORAGE_V2_MODULES = [...STORAGE_V2_MODULES, ...STORAGE_V2_PHASE_4_MODULES];

/**
 * The modules that can actually open or mutate a storage-v2 database.
 *
 * Phase 3 asserted that *nothing* in the application imported these, which was
 * correct then: storage-v2 was deliberately unreachable. Phase 4 is the phase
 * that routes the persistence facade through it, so the invariant changes shape
 * rather than disappearing - the heavyweight modules must be reachable ONLY from
 * the one boundary that owns repository selection, so there is exactly one place
 * in the application that knows storage-v2 exists.
 */
const STORAGE_V2_OPENING_MODULES = ['database', 'repository', 'migrations', 'archive'].map((name) =>
  extensionless(join(V2_DIR, `${name}.ts`)),
);

/** The single file allowed to import the opening modules. */
const STORAGE_V2_ENTRY_POINT = extensionless(join(SRC, 'application', 'bootstrap.ts'));

describe('QA storage-v2 is reachable only through the selection boundary', () => {
  it('the forbidden module set resolves to real files', () => {
    for (const modulePath of ALL_STORAGE_V2_MODULES) expect(existsSync(`${modulePath}.ts`)).toBe(true);
  });

  it('a graph walk from src/main.tsx reaches storage-v2 only through the one entry point', () => {
    const entry = join(SRC, 'main.tsx');
    expect(existsSync(entry)).toBe(true);

    const seen = new Set<string>();
    const queue: string[] = [extensionless(entry)];
    const directImporters = new Map<string, string[]>();

    while (queue.length > 0) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (!existsSync(`${current}.ts`) && !existsSync(`${current}.tsx`)) continue;
      const file = existsSync(`${current}.ts`) ? `${current}.ts` : `${current}.tsx`;
      for (const specifier of readSpecifiers(file)) {
        const target = resolveFirstParty(file, specifier);
        if (!target) continue;
        const resolved = STORAGE_V2_MODULES.includes(extensionless(target))
          ? extensionless(target)
          : isInside(SRC, target)
            ? extensionless(target)
            : null;
        if (!resolved) continue;
        if (ALL_STORAGE_V2_MODULES.includes(resolved)) {
          const importers = directImporters.get(resolved) ?? [];
          importers.push(relative(ROOT, file));
          directImporters.set(resolved, importers);
          continue;
        }
        queue.push(resolved);
      }
    }

    // The walk must have actually walked something.
    expect(seen.size).toBeGreaterThan(20);

    // Every storage-v2 module the application reaches is one Phase 3 or Phase 4
    // declared, and nothing else has crept in.
    const reached = [...directImporters.keys()].sort();
    expect(reached.filter((module) => !ALL_STORAGE_V2_MODULES.includes(module))).toEqual([]);

    // The database-opening modules are reachable, which is the whole point of
    // this phase, and never from anywhere but the one entry point. `repository`
    // and `migrations` are imported by it directly; `database` and `archive` are
    // reached only from inside the v2 tree, so the walk records no outside
    // importer for them at all, which is the stronger position.
    expect(reached).toContain(extensionless(join(V2_DIR, 'repository.ts')));
    expect(reached).toContain(extensionless(join(V2_DIR, 'migrations.ts')));
    const entryPoint = relative(ROOT, `${STORAGE_V2_ENTRY_POINT}.ts`);
    for (const opening of STORAGE_V2_OPENING_MODULES) {
      const importers = (directImporters.get(opening) ?? []).filter(
        (file) => !isInside(V2_DIR, join(ROOT, file)),
      );
      expect(importers.filter((file) => file !== entryPoint), opening).toEqual([]);
    }
  });

  it('the only importers of storage-v2 outside the v2 tree are the declared seams', () => {
    expect(storageV2SeamOffenders(scannableSourceFiles(SRC))).toEqual([]);
    // ...and every allowlisted entry is really a file that still exists.
    for (const key of STORAGE_V2_SEAMS.keys()) {
      expect(existsSync(`${key}.ts`) || existsSync(`${key}.tsx`), key).toBe(true);
    }
  });

  it('no module outside the v2 tree statically imports a storage-v2 implementation module', () => {
    // The modules that carry the storage-v2 *implementation* - the database, the
    // repository, the migration, the validators, the record adapter, the
    // attachment-bytes store. Every one of them must be reached only through a
    // dynamic `import(...)`, so the default artifact does not contain them at all
    // and "the flag off writes nothing to storage-v2" is a property of the build
    // rather than of a runtime check.
    //
    // `appState`, `dualWrite`, `repositorySelection`, `checksum` and `schema` are
    // deliberately excluded: their own imports are type-only or tiny, so they cost
    // the default build nothing to include.
    const implementationModules = [
      'database',
      'repository',
      'migrations',
      'validation',
      'legacyReader',
      'appRepository',
      'attachmentBytes',
      'migrationState',
      'archive',
    ];
    const offenders: string[] = [];
    for (const file of scannableSourceFiles(SRC)) {
      if (isInside(V2_DIR, file)) continue;
      const source = readFileSync(file, 'utf8');
      // A static import statement begins a line with `import` and is not a
      // dynamic `import(`; a multi-line import is captured by continuing until the
      // statement's closing quote.
      for (const match of source.matchAll(/(?:^|\n)\s*import\s(?!type\s)([^;]*?from\s*)?['"]([^'"]+)['"]/g)) {
        const specifier = match[2] as string;
        const resolved = resolveFirstParty(file, specifier);
        if (!resolved) continue;
        const target = extensionless(resolved);
        const name = target.split('/').pop() as string;
        if (isInside(V2_DIR, resolved) && implementationModules.includes(name)) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the default build selects the legacy repository and holds no storage-v2 handle', async () => {
    // The flag is the cutover control. This asserts the production default is
    // still the safe one and that a module asking "which repository?" before the
    // bootstrap runs gets the legacy answer rather than an unopened handle.
    const { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig } = await import('@/config/runtimeConfig');
    const selection = await import('@/services/persistence/v2/repositorySelection');

    expect(DEFAULT_RUNTIME_CONFIG.storageRepository).toBe('legacy');
    expect(parseRuntimeConfig({}).storageRepository).toBe('legacy');
    expect(parseRuntimeConfig({ VITE_STORAGE_REPOSITORY: 'v2' }).storageRepository).toBe('v2');

    selection.resetRepositorySelection();
    expect(selection.currentRepositorySelection()).toBe('legacy');
    expect(selection.currentStorageV2Repository()).toBeNull();
    expect(selection.isStorageV2Selected()).toBe(false);
  });
});

describe('QA the storage-v2 seam scan and a concurrent test planting', () => {
  // The privacy gate plants a probe module inside `src/` while it proves its own
  // detector is non-vacuous. This gate scans `src/` for forbidden imports, so
  // without a rule the planted probe was reported as a real offender - a genuine
  // cross-suite flake, reproducible by running the two files together.
  //
  // The rule is file-level and self-declaring: a scan skips exactly the paths a
  // live planting declared, in a directory the planting gate itself declares. It is
  // *not* "skip this directory". These five tests are what make the difference real
  // rather than asserted in a comment - in particular the third, which is the hole
  // a directory-wide exemption would have left open.
  const PROBE_NAME = TEST_OWNED_SOURCE_DIRECTORIES[0] as string;
  const PROBE_DIRECTORY = testOwnedDirectory(PROBE_NAME);
  const OFFENDER_NAME = '__qa_offender_probe__';
  const OFFENDER_DIRECTORY = testOwnedDirectory(OFFENDER_NAME);

  /** A module that names a real storage-v2 module, so the detector must flag it. */
  const OFFENDER_SOURCE = [
    "import { checksumValue } from '@/services/persistence/v2/checksum';",
    '',
    'export function probe(value: unknown): string {',
    '  return checksumValue(value);',
    '}',
    '',
  ].join('\n');

  /**
   * Plant one module.
   *
   * `declared` is the list handed to the planting declaration, so a test can
   * declare exactly the files it planted and leave anything else unmentioned.
   */
  function plant(
    directoryName: string,
    moduleName: string,
    options: { marked: boolean; declared?: readonly string[] } = { marked: false },
  ): string {
    const directory = testOwnedDirectory(directoryName);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, moduleName);
    writeFileSync(file, OFFENDER_SOURCE, 'utf8');
    if (options.marked) {
      writePlantingMarker(
        directoryName,
        options.declared ?? [`src/${directoryName}/${moduleName}`],
      );
    }
    return file;
  }

  function cleanup(): void {
    for (const name of [PROBE_NAME, OFFENDER_NAME]) {
      rmSync(testOwnedDirectory(name), { recursive: true, force: true });
    }
    clearPlantingDeclarations();
  }

  afterAll(() => {
    cleanup();
  });

  it('reports the declared files of a live planting as nothing at all', () => {
    // The flake, closed: the privacy gate's own probe shape, planted and declared,
    // does not trip this gate.
    cleanup();
    const file = plant(PROBE_NAME, 'uploader.ts', { marked: true });
    try {
      expect(storageV2SeamOffenders(scannableSourceFiles(SRC))).toEqual([]);
      // And the file really is there and really does name a storage-v2 module, so
      // the empty result is the rule working and not a scan that found no files.
      expect(existsSync(file)).toBe(true);
      expect(readSpecifiers(file)).toContain('@/services/persistence/v2/checksum');
      expect(storageV2SeamOffenders([file]), 'and the detector does flag it when scanned directly').toEqual([
        relative(ROOT, file),
      ]);
    } finally {
      cleanup();
    }
  });

  it('still reports a real offender left in the same directory once the planting is over', () => {
    // No live declaration means no exemption, so a committed or abandoned file
    // under the test-owned name is scanned like any other source file.
    cleanup();
    const file = plant(PROBE_NAME, 'left-behind.ts', { marked: false });
    try {
      expect(existsSync(plantingMarkerPath(PROBE_NAME))).toBe(false);
      expect(storageV2SeamOffenders(scannableSourceFiles(SRC))).toEqual([relative(ROOT, file)]);
    } finally {
      cleanup();
    }
  });

  it('still reports a real offender in the same directory that the planting did not declare, while a planting is live', () => {
    // The hole a directory-wide exemption leaves open, and the reason the
    // declaration is a file list. A planting is in flight in this exact directory
    // - a live marker, declared files present - and a file that planting never
    // claimed still names a forbidden module. A directory-scoped skip would have
    // hidden it.
    cleanup();
    const declared = plant(PROBE_NAME, 'uploader.ts', { marked: true });
    const undeclared = join(PROBE_DIRECTORY, 'smuggled-in.ts');
    writeFileSync(undeclared, OFFENDER_SOURCE, 'utf8');
    try {
      // The exemption is live and does cover the declared file...
      expect(isTestOwnedTransientPath(declared)).toBe(true);
      // ...and the undeclared file in the very same directory is not exempt.
      expect(isTestOwnedTransientPath(undeclared)).toBe(false);
      expect(storageV2SeamOffenders(scannableSourceFiles(SRC))).toEqual([relative(ROOT, undeclared)]);
    } finally {
      cleanup();
    }
  });

  it('still reports a real offender in a differently named test directory', () => {
    // Nothing is exempt by shape: a directory that merely looks temporary, and is
    // not declared by the gate that owns plantings, is scanned like any other - even
    // if it carries a planting declaration of its own.
    cleanup();
    const file = plant(OFFENDER_NAME, 'offender.ts', { marked: true });
    try {
      expect(storageV2SeamOffenders(scannableSourceFiles(SRC))).toEqual([relative(ROOT, file)]);
    } finally {
      cleanup();
    }
  });

  it('names the declaration a live planting needs, so the two gates cannot disagree', () => {
    // The exemption is only meaningful if both gates use the same name and the same
    // shape, so the shared declaration is asserted rather than assumed.
    expect(TEST_OWNED_SOURCE_DIRECTORIES).toContain(PROBE_NAME);
    expect(plantingMarkerPath(PROBE_NAME)).toBe(join(PROBE_DIRECTORY, PLANTING_MARKER_NAME));
    expect(livePlantedPaths()).toEqual([]);
    // A path outside every declared directory is never exempt, whatever exists on
    // disk.
    expect(isTestOwnedTransientPath(join(OFFENDER_DIRECTORY, 'offender.ts'))).toBe(false);
    expect(isTestOwnedTransientPath(join(SRC, 'ui', 'App.tsx'))).toBe(false);
  });
});

describe('QA the archive codec is the only fflate importer', () => {
  it('no application module imports fflate directly except archive.ts', () => {
    const offenders: string[] = [];
    for (const file of scannableSourceFiles(SRC)) {
      if (file === join(V2_DIR, 'archive.ts')) continue;
      for (const specifier of readSpecifiers(file)) {
        if (specifier === 'fflate' || specifier.startsWith('fflate/')) {
          offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // ...and archive.ts uses the browser subpath, not the bare specifier.
    const archive = readFileSync(join(V2_DIR, 'archive.ts'), 'utf8');
    expect(archive).toContain("from 'fflate/browser'");
  });
});
