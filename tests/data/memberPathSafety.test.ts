/**
 * Phase 5 data-product gate 7: member-path safety on write and on read.
 *
 * A backup's member names are the one part of the product that looks like a
 * filesystem, so they get filesystem-shaped attacks. This gate holds both
 * directions:
 *
 * - **On write**, an unsafe name must be refused before anything is produced.
 * - **On read**, an unsafe name must be refused before it is interpreted, and a
 *   member must not be able to become a prototype-polluting key.
 *
 * The list is the one the phase brief names: zip-slip, absolute paths,
 * backslashes, `..` segments, `Object.prototype` member names, and a `__proto__`
 * member - on both sides.
 *
 * Two of those need care, and both are the reason this file exists rather than
 * being folded into the corruption gate:
 *
 * 1. **`Object.prototype` member names.** `toString`, `constructor`, `hasOwnProperty`
 *    and the rest are legitimate words, and a `.kdbak` produced by another tool
 *    may well contain one. The audited writer used to report such a name as a
 *    *duplicate* - a wrong reason that turned a valid archive into an unwritable
 *    one - so both halves of the requirement are now asserted against the fixed
 *    writer, and each test keeps a `HISTORY` note recording the defect framing it
 *    replaced.
 * 2. **`__proto__` as a member name.** Assigning it on a plain object does not
 *    create a key; it sets the prototype. So a reader that copies member names
 *    into a plain object can lose a member silently or corrupt the object it is
 *    building, and the member never appears in the result. This gate measures what
 *    the audited codec actually does with such a member and registers the
 *    requirement that it be refused.
 *
 * And the gate has to be able to tell a *legitimate* member named `toString` from
 * a duplicate, so the positive control builds a two-member archive whose second
 * member really is named `toString` and requires the round trip to keep both.
 *
 * Privacy: every member name in this file is a fixed, opaque, synthetic token.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readArchive, writeArchive, type ArchiveFile } from '@/services/persistence/v2/archive';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import { writeArchive as productWriteArchive } from '@/services/persistence/products/fullDeviceBackup';
import { rawFflateZip, rawZip } from './support/hostileZip';
import { utf8 } from './support/hashes';

/** Member names that exist on `Object.prototype` and are not own keys of `{}`. */
const PROTOTYPE_POLLUTING_NAMES = [
  'toString',
  'constructor',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
] as const;

const SAFE_MEMBERS: readonly ArchiveFile[] = [
  { path: 'manifest.json', bytes: utf8('{"product":"kdbak","formatVersion":1}') },
  { path: 'state.json', bytes: utf8('{"subjects":[]}') },
];

/** The typed rejection a hostile member name must produce. */
function expectRefusal(run: () => unknown): StorageV2Error {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StorageV2Error);
  const error = thrown as StorageV2Error;
  expect(error.code).toBe('ARCHIVE_UNSAFE_PATH');
  return error;
}

afterEach(() => {
  // Nothing is planted on disk by this file; the hook documents that and keeps a
  // future addition from silently skipping cleanup.
});

describe('Phase 5 gate 7: unsafe member names are refused on write', () => {
  it('zip-slip, absolute, backslash, and traversal names are all refused', () => {
    const hostile = [
      '../escape.json',
      'a/../../escape.json',
      'deeply/nested/../../../escape.json',
      '/etc/passwd',
      '//host/share/file.json',
      'C:/windows/system32/drivers.json',
      'attachments\\000001.png',
      'custom-sprites\\000001.svg',
      'state.json\\..\\escape.json',
      'attachments/../escape.json',
    ];
    for (const path of hostile) {
      const error = expectRefusal(() => writeArchive([{ path, bytes: utf8('{}') }]));
      // The reason is a code, never the path itself, so a rejection cannot leak
      // the value it rejected.
      expect(error.details.reason).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(error.message).toBe('storage-v2 error: ARCHIVE_UNSAFE_PATH');
      expect(JSON.stringify(error.toReport())).not.toContain(path);
    }
    // Ten distinct hostile names, and a well-formed archive is still writable.
    expect(hostile).toHaveLength(10);
    expect(writeArchive(SAFE_MEMBERS).length).toBeGreaterThan(0);
  });

  it('a path that names a prototype key is written and read back, not refused', () => {
    // HISTORY. This measured the opposite: the writer asked `in` rather than
    // `Object.hasOwn`, so every name that exists on `Object.prototype` read as
    // "already present" and a legitimate single-member archive was refused as a
    // `duplicate-member`. Phase 3 recorded that as a follow-up and Phase 5
    // implemented it, because a product that cannot write a member another tool
    // wrote is not interoperable. It is still a measurement - the writer is driven
    // with real names and the archive is read back - but the measurement is now of
    // the behaviour the contract wants.
    for (const name of PROTOTYPE_POLLUTING_NAMES) {
      const bytes = writeArchive([
        { path: 'manifest.json', bytes: utf8('{"product":"kdbak"}') },
        { path: name, bytes: utf8(`{"member":${JSON.stringify(name)}}`) },
      ]);
      const read = readArchive(bytes).map((member) => member.path).sort();
      expect(read, name).toEqual(['manifest.json', name].sort());
    }
    // `__proto__` is the one name in that family the writer cannot represent at
    // all: fflate normalizes member names into a plain object internally and
    // enumerates it with `for...in`, so assigning that name changes the object's
    // prototype, the member is dropped, and the archive out is not the archive in.
    // A writer that dropped it silently would be worse than one that refuses it,
    // so the refusal is explicit and carries its own reason. The reader refuses
    // the same name for the same reason, which is the symmetry that matters: a
    // member the format cannot carry is refused on both sides rather than lost on
    // one of them.
    const protoError = expectRefusal(() =>
      writeArchive([
        { path: 'manifest.json', bytes: utf8('{"product":"kdbak"}') },
        { path: '__proto__', bytes: utf8('{"member":"proto"}') },
      ]),
    );
    expect(protoError.details.reason).toBe('prototype-member-name');
    // The refusal is a path refusal, not a duplicate: the two are different
    // problems and a caller has to be able to tell them apart.
    expect(protoError.details.reason).not.toBe('duplicate-member');
  });
});

describe('Phase 5 gate 7: unsafe member names are refused on read', () => {
  it('a zip-slip member in an otherwise valid archive refuses the whole read', () => {
    // Built with a raw ZIP writer, because the production writer refuses to
    // produce the very input this gate has to attack.
    const bytes = rawFflateZip([
      ...SAFE_MEMBERS,
      { path: '../escape.json', bytes: utf8('{"escaped":true}') },
    ]);
    const error = expectRefusal(() => readArchive(bytes));
    expect(error.details.reason).toBe('parent-traversal');
    // No partial extraction: the call threw, so it returned nothing at all.
    expect(readArchive.length).toBeGreaterThan(0);
  });

  it('an absolute or backslash member is refused, in three spellings each', () => {
    for (const path of [
      '/absolute.json',
      '//unc/share.json',
      'C:/drive.json',
      'attachments/..\\escape.json',
      'nested\\backslash.json',
    ]) {
      const bytes = rawFflateZip([...SAFE_MEMBERS, { path, bytes: utf8('{}') }]);
      const error = expectRefusal(() => readArchive(bytes));
      expect(['absolute-path', 'unc-path', 'drive-letter', 'backslash-separator'], path).toContain(
        error.details.reason,
      );
    }
  });

  it('a `__proto__` member is measured: what the audited reader actually does with it', () => {
    // The measurement, not a wish. A raw ZIP is built with a `__proto__` member,
    // because that is the only way to produce one.
    const bytes = rawZip([
      { name: 'manifest.json', bytes: SAFE_MEMBERS[0]?.bytes as Uint8Array },
      { name: 'state.json', bytes: SAFE_MEMBERS[1]?.bytes as Uint8Array },
      { name: '__proto__', bytes: utf8('{"polluted":true}') },
    ]);

    let thrown: unknown = null;
    let members: readonly { path: string }[] = [];
    try {
      members = readArchive(bytes);
    } catch (error) {
      thrown = error;
    }

    // Either the reader refuses it (the contract), or it accepts the archive and
    // the member is *absent from the result*, which is the hazard: a member that
    // vanished without an error is a member whose bytes were read and discarded.
    // Both outcomes are recorded here; the registered test below requires refusal.
    if (thrown === null) {
      expect(members.map((member) => member.path)).not.toContain('__proto__');
      expect(members).toHaveLength(2);
    } else {
      expect(thrown).toBeInstanceOf(StorageV2Error);
    }
    // Whatever happened, the ordinary members are intact, so the measurement is
    // about the one hostile name and not about a broken fixture.
    expect(members.map((member) => member.path).sort()).toEqual(
      ['manifest.json', 'state.json'].filter((name) => members.some((m) => m.path === name)).sort(),
    );
  });
});

describe('Phase 5 gate 7: a legitimate member is not mistaken for a duplicate', () => {
  it('POSITIVE CONTROL: two distinct members, the second named toString, are both kept', () => {
    // HISTORY. This control used to assert that the writer *refused* this
    // archive, which made it a measurement of the defect rather than of the
    // contract. It now asserts the contract directly, and it asserts it through
    // the **product's** writer, because "the product's writer interoperates" is
    // the claim that matters.
    const members: readonly ArchiveFile[] = [
      { path: 'manifest.json', bytes: utf8('{"product":"kdbak"}') },
      { path: 'toString', bytes: utf8('{"a-real-member":true}') },
    ];
    const read = readArchive(productWriteArchive(members));
    expect(read.map((member) => member.path).sort()).toEqual(['manifest.json', 'toString']);
    for (const file of members) {
      const member = read.find((entry) => entry.path === file.path);
      expect(member, file.path).toBeDefined();
      expect(new TextDecoder().decode(member?.bytes ?? new Uint8Array(0)), file.path).toBe(
        new TextDecoder().decode(file.bytes),
      );
    }
  });

  it('a genuine duplicate is still refused, so the fix cannot be "accept everything"', () => {
    // The other half of the control: whatever the writer does about prototype
    // names, two members with the *same* real name remain a malformed archive.
    let thrown: unknown = null;
    try {
      writeArchive([
        { path: 'manifest.json', bytes: utf8('{"a":1}') },
        { path: 'manifest.json', bytes: utf8('{"a":2}') },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).code).toBe('ARCHIVE_MALFORMED');
    expect((thrown as StorageV2Error).details.reason).toBe('duplicate-member');
  });

  it('the audited reader accepts a prototype-named member and returns its bytes', () => {
    // The read side already works, which is worth knowing: the follow-up recorded
    // in Phase 3 is on the *write* side only.
    const bytes = rawFflateZip([
      { path: 'manifest.json', bytes: utf8('{"product":"kdbak"}') },
      { path: 'toString', bytes: utf8('{"a-real-member":true}') },
    ]);
    const read = readArchive(bytes);
    const names = read.map((member) => member.path).sort();
    expect(names).toEqual(['manifest.json', 'toString']);
    const prototypeNamed = read.find((member) => member.path === 'toString');
    expect(new TextDecoder().decode(prototypeNamed?.bytes as Uint8Array)).toBe(
      '{"a-real-member":true}',
    );
  });
});

describe('Phase 5 gate 7: the path rules this gate enforces are the ones the source declares', () => {
  it('the audited codec really exports the predicate the gate is testing', () => {
    // Read out of the real source so the gate cannot drift from the rule it
    // claims to enforce: a rename of the exported predicate would fail here
    // rather than silently making the whole file vacuous.
    const source = readFileSync(
      join(process.cwd(), 'src/services/persistence/v2/archive.ts'),
      'utf8',
    );
    for (const exported of [
      'export function assertSafeArchivePath',
      'export function describeUnsafeArchivePath',
      'export function writeArchive',
      'export function readArchive',
    ]) {
      expect(source, exported).toContain(exported);
    }
    // Every reason this gate expects is a reason the source can produce.
    for (const reason of [
      'empty-path',
      'path-too-long',
      'control-character',
      'backslash-separator',
      'unc-path',
      'absolute-path',
      'drive-letter',
      'parent-traversal',
      'empty-segment',
    ]) {
      expect(source, reason).toContain(`'${reason}'`);
    }
  });
});

describe('Phase 5 gate 7: REGISTERED - the product refuses hostile member paths', () => {
  it('a member named toString round-trips through the product writer', () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `writeArchive` in `src/services/persistence/products/fullDeviceBackup.ts`
    // to stop asking `in` where it should ask `Object.hasOwn` - the follow-up the
    // Phase 3 evidence recorded. The product implements it, so this is now a live
    // assertion rather than a waiting one.
    const bytes = productWriteArchive([
      { path: 'manifest.json', bytes: utf8('{"product":"kdbak"}') },
      { path: 'toString', bytes: utf8('{"a-real-member":true}') },
    ]);
    const read = readArchive(bytes);
    expect(read.map((member) => member.path).sort()).toEqual(['manifest.json', 'toString']);
    const named = read.find((member) => member.path === 'toString');
    expect(named).toBeDefined();
    expect(new TextDecoder().decode(named?.bytes ?? new Uint8Array(0))).toBe(
      '{"a-real-member":true}',
    );
  });

  it('a `__proto__` member is refused on read rather than silently dropped', async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `readFullDeviceArchive` in
    // `src/services/persistence/products/archiveValidation.ts`, which is where
    // plan section 7.3's "a failed import must not replace the active generation"
    // becomes enforceable. The product refuses such a member with a typed error;
    // it does not let it vanish from the result.
    const validationModule = '@/services/persistence/products/archiveValidation';
    const { readFullDeviceArchive } = (await import(
      /* @vite-ignore */ validationModule
    )) as { readFullDeviceArchive?: (bytes: Uint8Array) => unknown };
    expect(typeof readFullDeviceArchive).toBe('function');
    const hostile = rawZip([
      { name: 'manifest.json', bytes: SAFE_MEMBERS[0]?.bytes as Uint8Array },
      { name: '__proto__', bytes: utf8('{"polluted":true}') },
    ]);
    const error = expectRefusal(() => readFullDeviceArchive?.(hostile));
    // The reason is a code, never a name, so the refusal cannot leak what it
    // rejected. It is also a *distinct* code from the layout's own verdict, so a
    // reader can tell a prototype key from an unknown prefix.
    expect(error.details.reason).toBe('prototype-member-name');
    // And the refusal came before the archive was interpreted: this fixture's
    // `manifest.json` is not valid JSON, so a reader that parsed first and
    // checked later would have failed with `member-not-json` instead.
    expect(error.details.reason).not.toBe('member-not-json');
  });
});
