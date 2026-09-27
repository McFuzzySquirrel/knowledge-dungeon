/**
 * Phase 6 verifier - harness self-check.
 *
 * Nothing here asserts a property of the product. It asserts that the verifier's
 * own instrument works, because every other file in this directory is worthless
 * if the forge produces a device the repository refuses or the fingerprint cannot
 * move.
 *
 * Phase 3 review found five vacuous gates in this repository. This file is the
 * answer to that: the instrument is calibrated before it is used.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprintDevice, forgeDevice, diffFingerprints, ALPHA } from './support/forge';

const REPO_ROOT = process.cwd();

/**
 * Source with comments and string bodies blanked.
 *
 * Necessary for both checks below: this file, and several gates it audits, *name*
 * `it.fails` and `tests/data/support/` in prose while asserting that neither is used.
 * A scanner that reads prose would report the very thing it is looking for in the
 * sentence promising its absence.
 */
function code(source: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1] ?? '';
    if (mode === 'code') {
      if (char === '/' && next === '/') { mode = 'line'; out += '  '; index += 1; continue; }
      if (char === '/' && next === '*') { mode = 'block'; out += '  '; index += 1; continue; }
      if (char === "'") { mode = 'single'; out += char; continue; }
      if (char === '"') { mode = 'double'; out += char; continue; }
      if (char === '`') { mode = 'template'; out += char; continue; }
      out += char;
      continue;
    }
    if (mode === 'line') { if (char === '\n') { mode = 'code'; out += char; } else out += ' '; continue; }
    if (mode === 'block') {
      if (char === '*' && next === '/') { mode = 'code'; out += '  '; index += 1; } else out += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (char === '\\') { out += '  '; index += 1; continue; }
    if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"') || (mode === 'template' && char === '`')) mode = 'code';
    out += char;
  }
  return out;
}

function filesUnder(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('Phase 6 verifier harness: the instrument works', () => {
  it('forges a device the repository accepts, with a populated active generation', async () => {
    const device = await forgeDevice();
    const active = await device.repository.readActiveGenerationId();
    expect(active).toBe(device.generationId);
    const snapshot = await device.repository.readRecords(device.generationId);
    expect(snapshot.records.subjects.length).toBe(3);
    expect(snapshot.records.progression.length).toBe(2);
    expect(snapshot.records.sessions.length).toBe(3);
    expect(snapshot.records.assistance.length).toBe(2);
    expect(snapshot.records.migrationReceipts.length).toBe(1);
    expect(snapshot.records.preferences.length).toBe(2);
    expect(snapshot.records.shortcuts.length).toBe(1);
    expect(snapshot.records.customSprites.length).toBe(1);
    expect(snapshot.records.recovery.length).toBe(1);
    // Two attachment records share one content hash, which is the shared-bytes
    // case the replace blast-radius attack depends on.
    const hashes = new Set(
      snapshot.records.attachmentMetadata.map((e) => e.value.contentHash).filter((h) => h !== null),
    );
    expect(hashes.size).toBe(1);
    // ...and two distinct blob records carry those same bytes.
    expect(snapshot.records.attachmentBlobs.length).toBe(2);
  });

  it('the fingerprint is stable across two reads of an untouched device', async () => {
    const device = await forgeDevice();
    const first = await fingerprintDevice(device.repository, device.databaseName);
    const second = await fingerprintDevice(device.repository, device.databaseName);
    expect(second.digest).toBe(first.digest);
  });

  it('the fingerprint moves on a SINGLE FLIPPED BYTE inside a stored value', async () => {
    // The non-vacuity control for every isolation claim in this directory. One bit
    // changed in one attachment byte must change the digest and produce a diff.
    const device = await forgeDevice();
    const before = await fingerprintDevice(device.repository, device.databaseName);

    const snapshot = await device.repository.readRecords(device.generationId);
    const blobs = snapshot.records.attachmentBlobs.map((entry) => entry.value);
    const target = blobs[0] as { attachmentId: string; bytes: ArrayBuffer; contentHash: string; byteLength: number; storedAt: string };
    const bytes = new Uint8Array(target.bytes.slice(0));
    bytes[0] = bytes[0] ^ 0x01;
    const flipped = { ...target, bytes: bytes.buffer as ArrayBuffer };

    // Written through the repository's own API, in place, so the only difference
    // between the two fingerprints is the one bit.
    await device.repository.putRecords(device.generationId, {
      attachmentBlobs: [flipped],
    });

    const after = await fingerprintDevice(device.repository, device.databaseName);
    const diff = diffFingerprints(before, after);
    expect(diff.digestChanged).toBe(true);
    expect(diff.lines.length).toBeGreaterThan(0);
    // ...and the diff names the record rather than dumping a value.
    expect(diff.lines.join('\n')).toContain('attachmentBlobs');
  });

  it('the fingerprint moves when a single legacy localStorage character changes', async () => {
    const device = await forgeDevice();
    const before = await fingerprintDevice(device.repository, device.databaseName);
    globalThis.localStorage.setItem('knowledge-dungeon:locale', 'en-US');
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).not.toBe(before.digest);
    expect(diffFingerprints(before, after).lines.join('\n')).toContain('legacy knowledge-dungeon:locale');
  });

  it('the fingerprint covers attachment BYTES, not only attachment metadata', async () => {
    const device = await forgeDevice();
    const snapshot = await device.repository.readRecords(device.generationId);
    const blob = snapshot.records.attachmentBlobs[0]!.value as { attachmentId: string; bytes: ArrayBuffer };
    const bytes = new Uint8Array(blob.bytes);
    const alpha = snapshot.records.subjects.find((entry) => entry.value.subjectId === ALPHA);
    expect(alpha).toBeDefined();
    const fingerprint = await fingerprintDevice(device.repository, device.databaseName);
    // The blob's own bytes appear verbatim in a record line, so a byte-level change
    // anywhere in the device is a change in the digest.
    expect(fingerprint.records.some((line) => line.includes(Buffer.from(bytes).toString('base64')))).toBe(true);
  });
});

describe('Phase 6 verifier harness: the suite accounts for itself', () => {
  it('this directory contains no it.fails, so a defect cannot be re-registered as expected', () => {
    // `tests/data/suiteIntegrity.test.ts` holds the implementers' equivalent
    // accounting for `tests/data/`. That file's closed lists do **not** reach
    // `tests/phase6/`, so the equivalent check is made here rather than by extending
    // someone else's closed list: the rule is that a live reproduction is asserted as
    // a failure, never declared in advance to be one.
    const offenders: string[] = [];
    for (const file of filesUnder(join(REPO_ROOT, 'tests/phase6'))) {
      const source = code(readFileSync(file, 'utf8'));
      if (/\b(?:it|test|describe)\.fails\s*\(/.test(source)) {
        offenders.push(file.replace(`${REPO_ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every gate file here states its phase, so a reader can tell what it is', () => {
    const withoutMarker: string[] = [];
    for (const file of filesUnder(join(REPO_ROOT, 'tests/phase6')).filter(
      (name) => name.endsWith('.test.ts'),
    )) {
      const source = readFileSync(file, 'utf8');
      if (!/Phase 6 verifier/.test(source)) {
        withoutMarker.push(file.replace(`${REPO_ROOT}/`, ''));
      }
    }
    expect(withoutMarker).toEqual([]);
  });

  it('no gate here shares a fixture module with the implementers\' suite', () => {
    // The independence claim, asserted: nothing under `tests/phase6/` imports
    // `tests/data/support/`, so no gate here can pass on the implementers'
    // assumptions.
    const offenders: string[] = [];
    for (const file of filesUnder(join(REPO_ROOT, 'tests/phase6'))) {
      // An actual module specifier, not a mention of one.
      const specifiers = [...code(readFileSync(file, 'utf8')).matchAll(/from\s*['"]([^'"]+)['"]/g)].map(
        (match) => match[1] as string,
      );
      if (specifiers.some((specifier) => /data\/support|\.\.\/data\//.test(specifier))) {
        offenders.push(file.replace(`${REPO_ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
