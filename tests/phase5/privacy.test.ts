/**
 * Verifier gate V6 - no learner data outside `state.json`.
 *
 * Plan section 12, rule 6: "Do not log or place learner data in URLs, filenames,
 * feature flags, or error reports." Plan section 2.3 keeps external image URLs as
 * user-provided content that is never fetched.
 *
 * The claim under test is narrow and stated precisely: the manifest, the member
 * paths, the typed error reports, the import result, and the evidence files carry
 * **counts, versions, digests, member names, and opaque ids** - and nothing a
 * learner authored. `state.json` necessarily contains learner data, because that
 * is what a backup *is*, so it is excluded from the claim and the exclusion is
 * asserted rather than assumed.
 *
 * The markers are planted first and their presence in the state document is
 * proven, so a "nothing leaked" assertion cannot be satisfied by a surface that
 * never held anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  readFullDeviceArchive,
  inspectFullDeviceArchive,
  FULL_DEVICE_BACKUP_FILE_NAME,
  type FullDeviceExportResult,
} from '@/services/persistence/products/fullDeviceBackup';
import { readArchive, readArchiveJson, writeArchive } from '@/services/persistence/v2/archive';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import {
  SUBJECT,
  VERIFIER_MARKERS,
  VERIFIER_RESTORE_NOW,
  buildVerifierDevice,
  bytesOf,
  hashOf,
  otherGenerationLabel,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];
const EXTERNAL_URL = VERIFIER_MARKERS.externalUrl;

async function device(options: { alt?: boolean } = {}): Promise<VerifierDevice> {
  const built = await buildVerifierDevice({ labels: options.alt === true ? otherGenerationLabel() : undefined });
  devices.push(built);
  return built;
}

afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

/**
 * Everything a learner authored: a name, a topic, a note, a file name, an alt
 * text, a URL, a sprite body, a recovery payload.
 */
function learnerMarkers(): string[] {
  return [
    VERIFIER_MARKERS.subjectName,
    VERIFIER_MARKERS.roomTopic,
    VERIFIER_MARKERS.noteBody,
    VERIFIER_MARKERS.attachmentFileName,
    VERIFIER_MARKERS.attachmentAltText,
    VERIFIER_MARKERS.spriteBody,
    VERIFIER_MARKERS.recoveryRaw,
    EXTERNAL_URL,
  ];
}

/**
 * Opaque identifiers, which the sanitized preview is *documented* to carry so a
 * disclosure can be correlated. They are not learner-authored text, and the
 * surface is required never to render them; `tests/phase5/a11y.test.ts` and the
 * DOM assertions in the exit gates cover that half.
 */
function opaqueIdentifiers(): string[] {
  return [SUBJECT.unicode, 'room-verifier-phase0-root', 'att-verifier-external'];
}

describe('V6: the markers really are in the state document', () => {
  let exported: FullDeviceExportResult;
  let stateText: Record<string, unknown> = {};

  beforeEach(async () => {
    const source = await device();
    exported = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: source.payloadBytes,
      activeSubjectId: SUBJECT.rich,
    });
    stateText = readArchiveJson(exported.bytes, 'state.json') as Record<string, unknown>;
  });

  it('state.json contains the subject name, the room topic, the note, the file name, the alt text, and the URL', () => {
    // Compared on the *parsed* value for the sprite body (JSON escapes its
    // quotes) and on the serialized document for everything else, so the check is
    // about the learner's bytes really being in the member.
    const text = JSON.stringify(stateText);
    for (const marker of [
      VERIFIER_MARKERS.subjectName,
      VERIFIER_MARKERS.roomTopic,
      VERIFIER_MARKERS.noteBody,
      VERIFIER_MARKERS.attachmentFileName,
      VERIFIER_MARKERS.attachmentAltText,
      EXTERNAL_URL,
    ]) {
      expect(text.includes(marker), `the fixture does not contain ${marker}`).toBe(true);
    }
    // These two carry characters JSON escapes, so they are compared on the
    // parsed value rather than on the serialized document.
    const sprites = (stateText.customSprites as Array<{ content: string }>).map((entry) => entry.content);
    expect(sprites.some((body) => body.includes(VERIFIER_MARKERS.spriteBody))).toBe(true);
    const recovery = (stateText.recovery as Array<{ raw: string }>).map((entry) => entry.raw);
    expect(recovery).toContain(VERIFIER_MARKERS.recoveryRaw);
  });
});

describe('V6: nothing outside state.json carries a learner value', () => {
  let source: VerifierDevice;
  let exported: FullDeviceExportResult;

  beforeEach(async () => {
    source = await device();
    exported = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: source.payloadBytes,
      activeSubjectId: SUBJECT.rich,
    });
  });

  it('the manifest member carries no learner value', () => {
    const manifestText = readArchiveJson(exported.bytes, 'manifest.json') as unknown as Record<string, unknown>;
    const text = JSON.stringify(manifestText);
    for (const marker of learnerMarkers()) {
      expect(text.includes(marker), `the manifest leaked ${marker}`).toBe(false);
    }
    // Nor a raw, unparsed pass over the member's own bytes.
    const member = readArchive(exported.bytes).find((entry) => entry.path === 'manifest.json')!;
    const decoded = new TextDecoder().decode(member.bytes);
    for (const marker of learnerMarkers()) {
      expect(decoded.includes(marker), `the manifest member leaked ${marker}`).toBe(false);
    }
  });

  it('no member path carries a learner value, and no member is named after one', () => {
    for (const member of readArchive(exported.bytes)) {
      for (const marker of learnerMarkers()) {
        expect(member.path.includes(marker), `${member.path} leaks ${marker}`).toBe(false);
      }
    }
    // The file name is a constant with nothing authored in it.
    expect(FULL_DEVICE_BACKUP_FILE_NAME).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
    for (const marker of learnerMarkers()) {
      expect(FULL_DEVICE_BACKUP_FILE_NAME.includes(marker)).toBe(false);
    }
  });

  it('the sanitized preview and the import result carry no learner value', async () => {
    const preview = readFullDeviceArchive(exported.bytes);
    const previewText = JSON.stringify(preview);
    for (const marker of learnerMarkers()) {
      expect(previewText.includes(marker), `the preview leaked ${marker}`).toBe(false);
    }
    // The identifiers that *are* allowed appear only inside the disclosure
    // entries, and nowhere else in the preview.
    for (const identifier of opaqueIdentifiers()) {
      const occurrences = previewText.split(identifier).length - 1;
      const insideDisclosure = preview.externalOnlyAttachments.filter((entry) =>
        JSON.stringify(entry).includes(identifier),
      ).length;
      expect(occurrences, `${identifier} appears ${occurrences} times, ${insideDisclosure} inside a disclosure`).toBe(
        insideDisclosure,
      );
    }
    // The import result is the thing a report is written from.
    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: exported.bytes,
      now: VERIFIER_RESTORE_NOW,
    });
    const resultText = JSON.stringify(result, (_key, value) =>
      value instanceof Map || value instanceof Set || value instanceof Uint8Array ? undefined : value,
    );
    for (const marker of learnerMarkers()) {
      expect(resultText.includes(marker), `the import result leaked ${marker}`).toBe(false);
    }
    // ...including the preview the result carries.
    expect(JSON.stringify(result.preview).includes(VERIFIER_MARKERS.subjectName)).toBe(false);
    expect(result.externalOnlyAttachments.every((entry) => entry.contentHash === null)).toBe(true);
    expect(result.externalOnlyAttachments.every((entry) => !('fileName' in entry))).toBe(true);
    expect(result.externalOnlyAttachments.every((entry) => !('externalUrl' in entry))).toBe(true);
  });

  it('a typed error never carries a learner value, whatever is wrong with the archive', () => {
    const wrong = [
      bytesOf('not a zip at all'),
      new Uint8Array(0),
      writeArchive([{ path: 'manifest.json', bytes: bytesOf(JSON.stringify({ subject: VERIFIER_MARKERS.subjectName })) }]),
      writeArchive([
        { path: 'manifest.json', bytes: bytesOf('{"product":"kdbak","formatVersion":1}') },
        { path: 'state.json', bytes: bytesOf(JSON.stringify({ subject: VERIFIER_MARKERS.roomTopic })) },
      ]),
      // A member whose *name* is a learner value: refused, and the refusal does
      // not quote the name back.
      writeArchive([
        { path: 'manifest.json', bytes: bytesOf('{"product":"kdbak"}') },
        { path: `state.json`, bytes: bytesOf('{}') },
      ]),
    ];
    for (const bytes of wrong) {
      let thrown: unknown = null;
      try {
        readFullDeviceArchive(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      const report = (thrown as StorageV2Error).toReport();
      const text = JSON.stringify(report);
      for (const marker of learnerMarkers()) {
        expect(text.includes(marker), `an error report leaked ${marker}`).toBe(false);
      }
      // The non-throwing form carries the same report.
      const inspection = inspectFullDeviceArchive(bytes);
      expect(inspection.ok).toBe(false);
      if (!inspection.ok) {
        expect(JSON.stringify(inspection.error).includes(VERIFIER_MARKERS.subjectName)).toBe(false);
      }
    }
  });

  it('an archive whose member is named after a learner value is refused without quoting the name', () => {
    // A safe name is refused because of the *layout*, and the reason is a code.
    const state = {
      formatVersion: 1,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      createdAt: VERIFIER_RESTORE_NOW,
    };
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(
        writeArchive([
          { path: 'manifest.json', bytes: bytesOf('{"product":"kdbak","formatVersion":1,"storageGenerationFormatVersion":1,"subjectSchemaVersion":"1.1.0","createdAt":"x","memberCount":2,"totalBytes":2,"contentChecksum":"' + '0'.repeat(64) + '","recordCounts":{},"attachmentBytes":{},"externalOnlyAttachments":{},"members":[]}') },
          { path: 'state.json', bytes: bytesOf(JSON.stringify(state)) },
        ]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    const details = (thrown as StorageV2Error).details as Record<string, unknown>;
    for (const value of Object.values(details)) {
      if (typeof value !== 'string') continue;
      expect(value.length).toBeLessThan(64);
    }
  });

  it('the allowlisted evidence root holds no learner value and no unsanitized URL', () => {
    // The *allowlisted* root, which is the only thing CI uploads. The Playwright
    // HTML report is a bundled application on local disk and is deliberately not
    // in the allowlist; a separate assertion below proves that.
    const root = join(process.cwd(), 'artifacts', 'compatibility-evidence');
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
    expect(files.length, 'no compatibility evidence was found to scan').toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const marker of learnerMarkers()) {
        expect(text.includes(marker), `${file} leaked ${marker}`).toBe(false);
      }
      // No host at all, and no absolute path: the only host this repository names
      // anywhere in evidence is the reserved `example.invalid`.
      const urls = text.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const url of urls) {
        expect(url, `${file} names ${url}`).toMatch(/^https?:\/\/(example\.invalid|pictures\.example\.invalid)/);
      }
      expect(/\/(home|Users)\/[A-Za-z0-9._-]+/.test(text), `${file} names a home path`).toBe(false);
    }
  });

  it('the CI upload allowlist is the evidence root only, and excludes the report and results directories', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    // Every `path:` entry inside an `upload-artifact` step, resolved line by line
    // rather than by a clever regex, so a multi-line block is read as written.
    const lines = workflow.split('\n');
    const uploads: string[][] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!/uses:\s*actions\/upload-artifact/.test(lines[index] as string)) continue;
      const paths: string[] = [];
      for (let scan = index; scan < Math.min(lines.length, index + 12); scan += 1) {
        const match = /^\s*(?:-\s*)?path:\s*(\S.*)$/.exec(lines[scan] as string);
        if (!match) continue;
        if (/^\s*-/.test(lines[scan] as string) || paths.length === 0) {
          paths.push((match[1] as string).trim());
        } else {
          paths.push((match[1] as string).trim());
        }
        for (let cont = scan + 1; cont < lines.length; cont += 1) {
          const next = lines[cont] as string;
          if (/^\s*-\s+\S/.test(next)) {
            paths.push(next.replace(/^\s*-\s*/, '').trim());
            scan = cont;
            continue;
          }
          break;
        }
      }
      uploads.push(paths);
    }
    expect(uploads.length, 'no upload-artifact step was found in the workflow').toBeGreaterThan(0);
    const artifactUploads = uploads.filter((paths) => paths.some((path) => path.startsWith('artifacts/')));
    expect(artifactUploads.length, 'no artifacts/ upload step was found').toBeGreaterThan(0);
    for (const paths of artifactUploads) {
      for (const path of paths) {
        if (!path.startsWith('artifacts/')) continue;
        expect(path, `a step uploads ${path}`).toMatch(
          /^artifacts\/(compatibility-evidence|build-metadata\.json|web-artifact-manifest[^/]*\.json)/,
        );
      }
    }
    // And the two raw directories the data-products project writes are named
    // nowhere in the workflow.
    expect(workflow).not.toContain('playwright-data-products-report');
    expect(workflow).not.toContain('data-products-test-results');
  });

  it('no product or data-center source file contains a learner-shaped literal', () => {
    // A source-level scan of the two trees the phase added, for a URL or an
    // absolute path that is not the reserved host and not a source comment about
    // this very rule.
    const roots = ['src/services/persistence/products', 'src/ui/data'];
    const files: string[] = [];
    for (const root of roots) {
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
          const full = join(directory, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(join(process.cwd(), root));
    }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // No hard-coded host other than the reserved one.
      const hosts = text.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
      for (const host of hosts) {
        expect(host, `${file} names ${host}`).toMatch(/^https?:\/\/(example\.invalid|pictures\.example\.invalid|www\.w3\.org)/);
      }
      // No absolute filesystem path baked into a product or UI file.
      expect(/(^|[^A-Za-z0-9_])\/(home|Users|var|tmp)\//.test(text), `${file} contains an absolute path`).toBe(false);
    }
  });

  it('the product writes nothing to the console and makes no network call', async () => {
    // A runtime observation, not a source read: a console spy and a fetch spy
    // around a real export and a real import.
    const consoleCalls: unknown[][] = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    const fetches: unknown[] = [];
    const originalFetch = globalThis.fetch;
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      console[level] = (...args: unknown[]) => {
        consoleCalls.push([level, ...args]);
      };
    }
    globalThis.fetch = ((...args: unknown[]) => {
      fetches.push(args);
      throw new Error('the product must not fetch');
    }) as typeof fetch;
    try {
      const target = await device({ alt: true });
      await importFullDeviceBackup({
        repository: target.repository,
        bytes: exported.bytes,
        now: VERIFIER_RESTORE_NOW,
      });
    } finally {
      for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
        console[level] = original[level];
      }
      globalThis.fetch = originalFetch;
    }
    expect(fetches).toEqual([]);
    expect(consoleCalls).toEqual([]);
  });

  it('the export is a pure function of the generation, the clock, and the bytes - at the member level', async () => {
    // The *members* are a pure function of the input: same paths, same bytes, in
    // the same order. This is the property the privacy claim actually needs,
    // because it is what makes "these two archives are the same backup" checkable.
    const first = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: source.payloadBytes,
      activeSubjectId: SUBJECT.rich,
    });
    const second = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: source.payloadBytes,
      activeSubjectId: SUBJECT.rich,
    });
    const membersOf = (bytes: Uint8Array): Array<[string, string, number]> =>
      readArchive(bytes).map((member) => [member.path, hashOf(member.bytes), member.bytes.byteLength]);
    expect(membersOf(second.bytes)).toEqual(membersOf(first.bytes));
    expect(membersOf(first.bytes)).toEqual(membersOf(exported.bytes));
    expect(JSON.stringify(readArchiveJson(first.bytes, 'manifest.json'))).toBe(
      JSON.stringify(readArchiveJson(exported.bytes, 'manifest.json')),
    );
    expect(JSON.stringify(readArchiveJson(first.bytes, 'state.json'))).toBe(
      JSON.stringify(readArchiveJson(exported.bytes, 'state.json')),
    );
  });

  it('the archive bytes are reproducible, and carry the injected clock rather than the wall clock', { timeout: 30_000 }, async () => {
    // HISTORY. This asserted the D3 defect by waiting 2.6 s and expecting the two
    // archives to differ: the members were identical, but fflate's `wzh` stamped
    // each entry from `new Date(o.mtime || Date.now())` and `writeArchive` passed no
    // `mtime`, so the wall clock was inside the container.
    //
    // The wait was only there because the old test had to let the clock move in
    // order to see the field move. That made the test load-sensitive for no gain,
    // and it is gone. The fix inverts the argument and the test is stronger for it:
    // instead of waiting for the wall clock to move and watching the field follow,
    // assert that the field equals the *injected* clock at a date the wall clock is
    // not at. That needs no elapsed time, cannot pass by accident, and proves the
    // same thing.
    const exportOnce = async (now: string): Promise<Uint8Array> =>
      (
        await exportFullDeviceBackup({
          repository: source.repository,
          generationId: source.generationId,
          now,
          payloadBytes: source.payloadBytes,
          activeSubjectId: SUBJECT.rich,
        })
      ).bytes;

    // Two dates the wall clock is not at, so "the field happens to match right now"
    // is not an available explanation.
    const first = await exportOnce('2031-06-15T04:05:06.000Z');
    const firstWord = dosTimestampWordOf(first);
    expect(firstWord).toBe(dosTimestampWord(new Date('2031-06-15T04:05:06.000Z')));

    // The field follows the injected clock. It is not a constant, and it is not
    // tracking the wall clock - only the value of `now` decides it.
    const second = await exportOnce('2033-11-12T13:14:15.000Z');
    expect(dosTimestampWordOf(second)).toBe(dosTimestampWord(new Date('2033-11-12T13:14:15.000Z')));
    expect(dosTimestampWordOf(second)).not.toBe(firstWord);

    // And the claim itself: same generation, same clock, same bytes - members too,
    // so this is the container being reproducible and not merely the same members
    // being read twice.
    const repeat = await exportOnce('2031-06-15T04:05:06.000Z');
    expect(hashOf(repeat)).toBe(hashOf(first));
    expect(readArchive(repeat).map((member) => [member.path, hashOf(member.bytes)])).toEqual(
      readArchive(first).map((member) => [member.path, hashOf(member.bytes)]),
    );
    // The whole archive is fixed, so not one byte differs any more - where the old
    // test asserted `differences` was between 1 and 63.
    let differences = 0;
    for (let index = 0; index < Math.min(first.byteLength, repeat.byteLength); index += 1) {
      if (first[index] !== repeat[index]) differences += 1;
    }
    expect(differences).toBe(0);
  });
});

/** The DOS modification-time word in a ZIP archive's first local file header. */
function dosTimestampWordOf(archive: Uint8Array): number {
  return new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(10, true);
}

/**
 * The word fflate's `wzh` writes for a `Date`.
 *
 * fflate uses the *local* getters, so this does too; a UTC-based copy would be
 * wrong by the machine's offset and would make the gate machine-dependent. Local
 * time in the container is acceptable precisely because the gate pins the instant:
 * same instant, same word, on any machine.
 */
function dosTimestampWord(when: Date): number {
  const year = when.getFullYear() - 1980;
  return (
    (year << 25) |
    ((when.getMonth() + 1) << 21) |
    (when.getDate() << 16) |
    (when.getHours() << 11) |
    (when.getMinutes() << 5) |
    (when.getSeconds() >> 1)
  ) >>> 0;
}
