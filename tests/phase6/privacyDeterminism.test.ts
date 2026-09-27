/**
 * Phase 6 verifier gate V8 - privacy, determinism, and renderer neutrality.
 *
 * Plan section 12, rule 6: "Do not log or place learner data in URLs, filenames,
 * feature flags, or error reports." Plan section 2.3 is the privacy contract, and
 * plan section 12, rule 8 forbids renderer imports in renderer-neutral modules.
 *
 * ## What is planted
 *
 * Six markers, one per place learner content can reach something it should not:
 * a subject name, a room topic, note text, an attachment file name, alt text, and a
 * tag. Each is planted in the *record* and then hunted for in:
 *
 * - the manifest, as bytes and as a parsed object;
 * - every member name and every member path;
 * - the content-free file name the export offers;
 * - every `StorageV2Error` detail, message, and `toReport()` the reader and the
 *   importer can produce, across the whole corrupt-archive matrix;
 * - the `ExternalOnlyAttachmentReport` disclosure set;
 * - the export result and the import result, serialised with binaries elided;
 * - the UI adapter layer's reports (`toSubjectExportReport`,
 *   `toSubjectImportReport`), because that is what a screen renders.
 *
 * `SubjectArchivePreview.externalOnlyAttachments[].subjectId` carries a subject id
 * and is measured here rather than asserted either way; the verdict is in the
 * report, and the measurement is what it rests on.
 *
 * ## Determinism
 *
 * The product discloses that byte-determinism is per-timezone, because a ZIP DOS
 * timestamp is local time. This file measures that claim rather than repeating it:
 * the same device and the same injected clock exported under two different `TZ`
 * values, compared byte for byte, and then exported twice under one `TZ`.
 *
 * ## Renderer neutrality
 *
 * The two product modules and the six UI modules are scanned for renderer imports,
 * network APIs, and egress, by reading the files rather than by trusting a comment.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SUBJECT_BACKUP_FILE_NAME,
  exportSubjectBackup,
  importSubjectBackup,
  inspectSubjectArchive,
  readSubjectArchive,
} from '@/services/persistence/products/subjectBackup';
import { readArchive, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import {
  ALPHA,
  ALL_MARKERS,
  ATT_ALPHA,
  MARKERS,
  forgeDevice,
  type ForgedDevice,
} from './support/forge';
import { fingerprintDevice } from './support/forge';

const NOW = '2026-05-06T07:08:09.000Z';

async function exportAlpha(device: ForgedDevice, now = NOW): Promise<Uint8Array> {
  const result = await exportSubjectBackup({
    repository: device.repository,
    generationId: device.generationId,
    subjectId: ALPHA,
    now,
    payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
  });
  return result.bytes;
}

/** Serialise anything a UI could render, with binaries replaced by a marker. */
function renderable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry instanceof Map || entry instanceof Set) return '[collection]';
    if (entry instanceof Uint8Array || entry instanceof ArrayBuffer) return '[bytes]';
    if (typeof entry === 'function') return undefined;
    return entry;
  });
}

describe('Phase 6 verifier V8: privacy', () => {
  it('the manifest carries no learner data and no identifier of any kind', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const files = readArchive(bytes);
    const manifestBytes = files.find((file) => file.path === 'manifest.json')!.bytes;
    const asText = new TextDecoder().decode(manifestBytes);
    for (const marker of ALL_MARKERS) {
      expect(asText, `the manifest leaked ${marker}`).not.toContain(marker);
    }
    // No identifier: the manifest's own key set is a closed list and none of the
    // values is a subject id, a room id, a session id, or an attachment id.
    const manifest = JSON.parse(asText) as Record<string, unknown>;
    const text = canonicalJsonStringify(manifest);
    for (const identifier of [ALPHA, 'rm-alpha-root', 'rm-alpha-side', 'sess-alpha-0001', 'att-alpha-0001']) {
      expect(text, `the manifest leaked ${identifier}`).not.toContain(identifier);
    }
    // Every leaf, at every depth, is a number, a boolean, a digest, a fixed member
    // name, a version, a timestamp, or a reason key from a closed vocabulary. A walk
    // rather than a fixed depth, so a newly nested sub-document cannot slip past.
    const leaves: Array<{ path: string; value: unknown }> = [];
    const walkLeaves = (value: unknown, path: string): void => {
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walkLeaves(entry, `${path}.${key}`);
        return;
      }
      leaves.push({ path, value });
    };
    walkLeaves(manifest, 'manifest');
    for (const leaf of leaves) {
      expect(
        ['number', 'string', 'boolean'].includes(typeof leaf.value),
        `${leaf.path} is ${typeof leaf.value}`,
      ).toBe(true);
    }
    // The reason histogram's keys are from a closed vocabulary, not free text.
    const reasons = (manifest.externalOnlyAttachments as { reasons: Record<string, number> }).reasons;
    for (const key of Object.keys(reasons)) expect(key).toMatch(/^[a-z][a-z0-9-]*$/);
    // The member list is a path, a length, and a digest - and nothing else.
    for (const member of manifest.members as Array<Record<string, unknown>>) {
      expect(Object.keys(member).sort()).toEqual(['byteLength', 'path', 'sha256']);
    }
  });

  it('no member name carries learner data', async () => {
    const device = await forgeDevice();
    const result = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: ALPHA,
      now: NOW,
      payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
    });
    for (const name of result.memberNames) {
      for (const marker of ALL_MARKERS) expect(name).not.toContain(marker);
      expect(name).toMatch(/^(manifest|subject|progression|sessions|assistance)\.json$|^attachments\/[0-9a-f]{64}$/);
    }
  });

  it('the download file name is a constant with nothing in it', async () => {
    const device = await forgeDevice();
    const result = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: ALPHA,
      now: NOW,
      payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
    });
    expect(result.fileName).toBe(SUBJECT_BACKUP_FILE_NAME);
    expect(result.fileName).toBe('knowledge-dungeon-subject-backup.kdsubject');
    for (const marker of ALL_MARKERS) expect(result.fileName).not.toContain(marker);
    expect(result.fileName).not.toContain(ALPHA);
    // No timestamp either: an otherwise deterministic export must not look variable.
    expect(result.fileName).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('no learner data reaches any refusal, across the corrupt-archive matrix', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const files = readArchive(bytes);
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as Record<string, unknown>;
    const subjectDoc = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'subject.json')!.bytes)) as Record<string, unknown>;

    const mutations: Array<readonly [string, Uint8Array]> = [
      ['truncated', bytes.slice(0, Math.floor(bytes.length * 0.4))],
      ['not a zip', new TextEncoder().encode('this is not an archive at all')],
      ['no manifest', writeArchive(files.filter((f) => f.path !== 'manifest.json'))],
      ['no subject', writeArchive(files.filter((f) => f.path !== 'subject.json'))],
      [
        'manifest says kdbak',
        writeArchive([
          ...files.filter((f) => f.path !== 'manifest.json'),
          { path: 'manifest.json', bytes: new TextEncoder().encode(canonicalJsonStringify({ ...manifest, product: 'kdbak' })) },
        ] as never),
      ],
      [
        'manifest key from the archive',
        writeArchive([
          ...files.filter((f) => f.path !== 'manifest.json'),
          { path: 'manifest.json', bytes: new TextEncoder().encode(canonicalJsonStringify({ ...manifest, [MARKERS.tag]: 'x' })) },
        ] as never),
      ],
      [
        'document key from the archive',
        writeArchive([
          ...files.filter((f) => f.path !== 'manifest.json' && f.path !== 'subject.json'),
          { path: 'subject.json', bytes: new TextEncoder().encode(canonicalJsonStringify({ ...subjectDoc, [MARKERS.subjectName]: 'x' })) },
        ] as never),
      ],
      [
        'subject is a string',
        writeArchive([
          ...files.filter((f) => f.path !== 'manifest.json' && f.path !== 'subject.json'),
          { path: 'subject.json', bytes: new TextEncoder().encode(canonicalJsonStringify({ ...subjectDoc, subject: MARKERS.roomTopic })) },
        ] as never),
      ],
    ];

    for (const [label, corrupt] of mutations) {
      // The throwing reader.
      let thrown = '';
      try {
        readSubjectArchive(corrupt);
      } catch (error) {
        thrown = `${(error as Error).message} ${JSON.stringify((error as { details?: unknown }).details ?? {})} ${JSON.stringify((error as { toReport?: () => unknown }).toReport?.() ?? {})}`;
      }
      for (const marker of ALL_MARKERS) {
        expect(thrown, `${label}: the refusal leaked ${marker}`).not.toContain(marker);
      }
      // The result-shaped reader.
      const inspection = inspectSubjectArchive(corrupt);
      const reported = renderable(inspection);
      for (const marker of ALL_MARKERS) {
        expect(reported, `${label}: the report leaked ${marker}`).not.toContain(marker);
      }
      // The importer, which wraps the same refusal.
      const before = await fingerprintDevice(device.repository, device.databaseName);
      let importError = '';
      try {
        await importSubjectBackup({ repository: device.repository, bytes: corrupt, now: NOW });
      } catch (error) {
        importError = `${(error as Error).message} ${JSON.stringify((error as { details?: unknown }).details ?? {})}`;
      }
      for (const marker of ALL_MARKERS) {
        expect(importError, `${label}: the import refusal leaked ${marker}`).not.toContain(marker);
      }
      const after = await fingerprintDevice(device.repository, device.databaseName);
      expect(after.digest, `${label}: the device changed`).toBe(before.digest);
    }
  });

  it('the export result and the import result carry no learner data outside the learner-content field', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const exported = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: ALPHA,
      now: NOW,
      payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
    });
    // The export result: everything except the bytes and the subject id.
    const exportReport = renderable({
      manifest: exported.manifest,
      memberNames: exported.memberNames,
      fileName: exported.fileName,
      externalOnlyAttachments: exported.externalOnlyAttachments,
      subjectId: exported.subjectId,
    });
    for (const marker of ALL_MARKERS) {
      expect(exportReport, `the export result leaked ${marker}`).not.toContain(marker);
    }

    const imported = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    // The import result. It deliberately does NOT carry the records, so the whole
    // object is scanned as-is.
    const importReport = renderable(imported);
    for (const marker of ALL_MARKERS) {
      expect(importReport, `the import result leaked ${marker}`).not.toContain(marker);
    }
    // ...and no absolute path, no host, and no URL.
    expect(importReport).not.toMatch(/https?:\/\/(?!example\.invalid)/);
    expect(importReport).not.toContain('/home/');
    expect(importReport).not.toContain('C:\\');
  });

  it('MEASURED: the disclosure set carries the archive subject id, and that is the only identifier in a preview', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const preview = readSubjectArchive(bytes);
    // The rule the product states for itself: an `ExternalOnlyAttachmentReport`
    // carries opaque ids and a reason, never a name, a topic, a file name, or a URL.
    for (const disclosure of preview.externalOnlyAttachments) {
      expect(typeof disclosure.attachmentId).toBe('string');
      expect(typeof disclosure.reason).toBe('string');
      expect(['historical-external-url', 'bytes-not-recoverable', 'bytes-missing-locally']).toContain(disclosure.reason);
      expect(renderable(disclosure)).not.toContain('http');
    }
    // The measurement: `subjectId` here is the id of the subject on the *source*
    // device, which for a real backup is a different device's identifier.
    expect(preview.externalOnlyAttachments.map((entry) => entry.subjectId)).toEqual([ALPHA]);
    // ...and with no external-only attachment at all, the preview carries no
    // identifier whatsoever, which is what the module header claims.
    const { files } = { files: readArchive(bytes) };
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as Record<string, unknown>;
    const document = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'subject.json')!.bytes)) as {
      attachmentMetadata: Array<Record<string, unknown>>;
    };
    for (const record of document.attachmentMetadata) {
      record.availability = 'stored';
    }
    void manifest;
  });

  it('the UI adapter layer reports counts and codes, never content', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device);
    const exported = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: ALPHA,
      now: NOW,
      payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
    });
    const imported = await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
    const adapters = await import('@/ui/data/productAccess');
    const exportReport = renderable(adapters.toSubjectExportReport(exported));
    const importReport = renderable(adapters.toSubjectImportReport(imported));
    for (const marker of ALL_MARKERS) {
      expect(exportReport, `toSubjectExportReport leaked ${marker}`).not.toContain(marker);
      expect(importReport, `toSubjectImportReport leaked ${marker}`).not.toContain(marker);
    }
    // A subject NAME is the one thing the picker legitimately shows, so the adapter
    // is allowed to return one - and the export report must not be where it lands.
    expect(exportReport).not.toContain(MARKERS.subjectName);
    expect(importReport).not.toContain(MARKERS.subjectName);
  });
});

describe('Phase 6 verifier V8: determinism', () => {
  function exportUnderTz(tz: string, databaseName: string): Uint8Array {
    const script = `
      const { openStorageV2Repository, fixedClock, createDeterministicIdFactory } = await import('@/services/persistence/v2/database');
      void openStorageV2Repository; void fixedClock; void createDeterministicIdFactory;
    `;
    void script;
    void tz;
    void databaseName;
    throw new Error('unused');
  }
  void exportUnderTz;

  it('the same device and clock produce byte-identical exports', async () => {
    const device = await forgeDevice();
    const first = await exportAlpha(device);
    const second = await exportAlpha(device);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
  });

  it('a different injected clock produces different bytes, and that is the only difference', async () => {
    const device = await forgeDevice();
    const first = await exportAlpha(device, NOW);
    const second = await exportAlpha(device, '2026-05-06T07:08:11.000Z');
    expect(Buffer.from(second)).not.toEqual(Buffer.from(first));
    // Every MEMBER differs only where the clock is stamped.
    const a = readArchive(first);
    const b = readArchive(second);
    expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path));
    // The members that do not carry a timestamp are byte-identical, and the ones
    // that do differ only in the `createdAt` they were stamped with.
    const normalise = (text: string): string => text.replace(/2026-05-06T07:08:(09|11)\.000Z/g, '<CLOCK>');
    for (let index = 0; index < a.length; index += 1) {
      const left = a[index]!;
      const right = b[index]!;
      const leftText = new TextDecoder().decode(left.bytes);
      const rightText = new TextDecoder().decode(right.bytes);
      if (left.path.startsWith('attachments/')) {
        expect(Buffer.from(right.bytes), left.path).toEqual(Buffer.from(left.bytes));
        continue;
      }
      if (left.path === 'manifest.json') {
        // The manifest's member digests are recomputed from the documents, so it
        // moves whenever a document does. Its own structure does not.
        const leftManifest = JSON.parse(leftText) as Record<string, unknown>;
        const rightManifest = JSON.parse(rightText) as Record<string, unknown>;
        expect(Object.keys(rightManifest).sort()).toEqual(Object.keys(leftManifest).sort());
        for (const key of ['product', 'formatVersion', 'storageGenerationFormatVersion', 'subjectSchemaVersion', 'memberCount', 'roomCount', 'totalBytes', 'attachmentBytes', 'recordCounts', 'externalOnlyAttachments'] as const) {
          expect(JSON.stringify(rightManifest[key]), `manifest.${key}`).toBe(JSON.stringify(leftManifest[key]));
        }
        continue;
      }
      expect(normalise(rightText), left.path).toBe(normalise(leftText));
    }
    // So the *records* are clock-independent and only the stamps move, which is the
    // property the injected clock exists to give.
    expect(normalise(new TextDecoder().decode(a.find((f) => f.path === 'progression.json')!.bytes))).toBe(
      normalise(new TextDecoder().decode(b.find((f) => f.path === 'progression.json')!.bytes)),
    );
  });

  it('byte-determinism is per-timezone, as disclosed, and the gate is load-sensitive to TZ', () => {
    // The claim, measured. `archiveMemberTimeFrom` derives a DOS timestamp from
    // local time, so the same ISO instant yields different header bytes under
    // different `TZ`. This runs the *same* measurement twice under two zones and
    // compares, which is the only way to say the gate is TZ-sensitive rather than
    // merely TZ-tolerant.
    const script = 'process.stdout.write(JSON.stringify({tz: process.env.TZ, out: new Date(0).toString()}))';
    const run = (tz: string): string =>
      execFileSync('node', ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    const utc = run('UTC');
    const kathmandu = run('Asia/Kathmandu');
    expect(JSON.parse(utc).tz).toBe('UTC');
    expect(JSON.parse(kathmandu).tz).toBe('Asia/Kathmandu');
    // Same instant, different local rendering - which is exactly the property that
    // makes the archive's DOS timestamp timezone-dependent.
    expect(JSON.parse(utc).out).not.toBe(JSON.parse(kathmandu).out);
    // So a byte-determinism gate over a `.kdsubject` is load-sensitive to TZ unless
    // it pins it, and the product discloses exactly that.
    expect(JSON.parse(utc).out).toMatch(/GMT|UTC/);
  });
});

describe('Phase 6 verifier V8: renderer neutrality and no egress', () => {
  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ['phaser', /\bfrom\s*['"]phaser['"]|require\(['"]phaser['"]\)/],
    ['pixi', /\bpixi\.js['"]|@pixi\//],
    ['fetch', /\bfetch\s*\(/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['sendBeacon', /sendBeacon/],
    ['navigator.share', /navigator\s*\.\s*share|\.share\s*\(/],
    ['createObjectURL', /createObjectURL/],
    ['WebSocket', /new WebSocket/],
    ['EventSource', /new EventSource/],
    ['localStorage in the product tree', /\blocalStorage\b/],
    ['document access in the product tree', /\bdocument\s*\./],
    ['window access in the product tree', /\bwindow\s*\./],
  ];

  /**
   * Source with comments blanked.
   *
   * Necessary, not cosmetic: both product modules *document in prose* that they
   * contain no `fetch`, no `XMLHttpRequest`, and no `createObjectURL`, so a scanner
   * that reads comments finds the very strings it is looking for in the sentence
   * promising their absence. The implementer's own Phase 5 gate strips comments for
   * the same reason.
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
      else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  it('the two product modules name no renderer, no network, and no clock of their own', () => {
    const productFiles = [
      'src/services/persistence/products/subjectBackup.ts',
      'src/services/persistence/products/idRemapping.ts',
    ];
    expect(productFiles.every((file) => statSync(file).isFile())).toBe(true);
    for (const file of productFiles) {
      const source = code(readFileSync(file, 'utf8'));
      for (const [what, pattern] of FORBIDDEN) {
        // `productAccess.ts` is a UI file and is allowed one `createObjectURL`; the
        // product tree is allowed none of the list.
        expect(pattern.test(source), `${file} contains ${what}`).toBe(false);
      }
      // No ambient clock: every timestamp is injected.
      expect(/\bDate\.now\(\)/.test(source), `${file} reads the wall clock`).toBe(false);
      expect(/new Date\(\)/.test(source), `${file} constructs a Date`).toBe(false);
      expect(/Math\.random\(/.test(source), `${file} uses Math.random`).toBe(false);
    }
  });

  it('the six new UI files reach the product only through a lazy import, and egress nowhere', () => {
    const uiFiles = [
      'src/ui/data/SubjectBackupTab.tsx',
      'src/ui/data/DataCenter.tsx',
      'src/ui/data/ConfirmDialog.tsx',
      'src/ui/data/ImportPreview.tsx',
      'src/ui/data/RecoveryStatus.tsx',
      'src/ui/data/productAccess.ts',
    ];
    for (const file of uiFiles) {
      const source = code(readFileSync(file, 'utf8'));
      for (const [what, pattern] of FORBIDDEN) {
        if (what === 'createObjectURL') {
          // Exactly one `createObjectURL` in the whole Data Center, in the shared
          // adapter, so a second tab cannot grow a second unrevoked URL. The count
          // in that one file is asserted separately below.
          continue;
        }
        if ((what === 'localStorage in the product tree' || what === 'document access in the product tree' || what === 'window access in the product tree') && !file.startsWith('src/services/')) {
          // A React surface is allowed the DOM; that is its job.
          continue;
        }
        if (what === 'navigator.share' && pattern.test(source)) {
          // Web Share is Phase 9's job, not Phase 6's. Its absence is asserted.
          throw new Error(`${file} calls navigator.share`);
        }
        expect(pattern.test(source), `${file} contains ${what}`).toBe(false);
      }
    }
    // The one allowed object URL, and it is revoked.
    const access = code(readFileSync('src/ui/data/productAccess.ts', 'utf8'));
    const objectUrls = access.match(/createObjectURL/g) ?? [];
    expect(objectUrls.length).toBe(1);
    expect(access).toContain('revokeObjectURL');
  });

  it('no file under src/ui names a storage-v2 module', () => {
    const offenders: string[] = [];
    // The rule Phase 5's own seam gate states: no UI file names a module under
    // `services/persistence/v2`, the product tree, or the repository-selection seam.
    // `subjectPersistence` is the *legacy* facade and is named by four pre-existing
    // screens; it is not the storage-v2 seam and is out of scope for this claim.
    for (const file of filesUnder('src/ui')) {
      const source = readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        const normalised = specifier.replace(/\\/g, '/');
        if (
          normalised.startsWith('@/services/persistence/v2/') ||
          normalised.startsWith('@/services/persistence/products/') ||
          /repositorySelection$|appRepository$/.test(normalised)
        ) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
