/**
 * Phase 6 data-product gate 7: no learner data on any sanitized surface.
 *
 * Plan section 12, rule 6: "Do not log or place learner data in URLs, filenames,
 * feature flags, or error reports." Plan section 2.3 requires external-only
 * attachments to be disclosed honestly. This gate holds both for the `.kdsubject`
 * product, on every surface the product produces.
 *
 * Why a marker and not a forbidden-word list: a word list is satisfied by a surface
 * that carries no data at all, which is exactly the vacuous case. So one distinctive
 * token is planted, in one go, in every field a learner can author - a subject name, a
 * room topic, a note body, an artifact, an attachment filename, and an attachment's
 * alt text - and every sanitized surface is then required to be free of it. Each
 * surface is additionally required to be **non-empty and to genuinely contain the
 * marker before the absence was checked**, so "the marker is absent" cannot be
 * explained by "the marker was never there".
 *
 * The surfaces, in the order a learner meets them:
 *
 * - the **manifest** as written into the archive;
 * - the **member names** in the archive;
 * - the **offered file name**;
 * - the **preview** a screen shows before the learner commits;
 * - the **import result**, including its disclosures, its warnings, its counts, and
 *   its identifier mapping;
 * - every **typed error** a corrupt or hostile archive produces, detail by detail;
 * - the **disclosure report** for an attachment whose bytes are unavailable.
 *
 * Privacy: this file reads configuration and record values and reports file paths,
 * member names, counts, and rule ids. A failure message names the surface and the
 * forbidden *constant*, never a sample of the surface it is complaining about.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { isSanitizedDetailText, StorageV2Error } from '@/services/persistence/v2/schema';
import {
  exportSubjectBackup,
  inspectSubjectArchive,
  importSubjectBackup,
  readSubjectArchive,
  SUBJECT_BACKUP_FILE_NAME,
} from '@/services/persistence/products/subjectBackup';
import { readArchive } from '@/services/persistence/v2/archive';
import { readStorageV2ErrorCodes } from './support/productInterface';
import { buildSubjectCorruptionCases, readShape } from './support/subjectArchive';
import {
  describeForbiddenFragments,
  FORBIDDEN_FRAGMENTS,
  forbiddenFragmentsIn,
  isFreeOfLearnerContent,
  MARKER_TOKEN,
} from './support/marker';
import {
  NASTY_ATTACHMENT_IDS,
  NASTY_DEVICE_NOW,
  NASTY_GENERATION_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  type NastyDevice,
} from './support/nastySubject';

const NOW = '2026-10-04T00:00:00.000Z';

let device: NastyDevice;
let archive: Uint8Array;
/** The manifest, as the product wrote it. */
let manifestText: string;

beforeAll(async () => {
  device = await createNastySubjectDevice('kd-data-gate-privacy');
  const result = await exportSubjectBackup({
    repository: device.repository,
    generationId: NASTY_GENERATION_ID,
    subjectId: NASTY_SUBJECT_ID,
    now: NASTY_DEVICE_NOW,
    payloadBytes: device.payloadBytes,
  });
  archive = result.bytes;
  const manifestMember = readArchive(archive).find(
    (file) => file.path === 'manifest.json',
  );
  manifestText = new TextDecoder().decode(manifestMember?.bytes as Uint8Array);
});

describe('Phase 6 gate 7: the marker really is in the data being exported', () => {
  it('the subject carries the marker in a name, a topic, a note, a filename, and an alt text', () => {
    // Non-vacuity, stated first. If this failed, every absence assertion below would
    // be measuring an archive with no learner content in it, and the gate would be
    // decorative.
    const text = new TextDecoder().decode(
      readArchive(archive).find((file) => file.path === 'subject.json')?.bytes as Uint8Array,
    );
    const found = forbiddenFragmentsIn(text);
    expect(found.length, describeForbiddenFragments(found)).toBeGreaterThan(0);
    expect(text).toContain(MARKER_TOKEN);
    // ...and the bytes really did cross the archive boundary, not just the object.
    expect(new TextDecoder().decode(archive.slice(0, archive.byteLength))).not.toBe('');
    const allText = readArchive(archive)
      .filter((file) => file.path.endsWith('.json'))
      .map((file) => new TextDecoder().decode(file.bytes))
      .join('\n');
    expect(allText).toContain(MARKER_TOKEN);
  });
});

describe('Phase 6 gate 7: the manifest carries counts, versions, and digests, and nothing else', () => {
  it('the manifest is free of every forbidden fragment', () => {
    const found = forbiddenFragmentsIn(manifestText);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    expect(isFreeOfLearnerContent(manifestText)).toBe(true);
    // Its exact key set, and every value is a count, a version, a digest, or a fixed
    // member name. No identifier of any kind - not even the subject's.
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual([
      'attachmentBytes',
      'contentChecksum',
      'createdAt',
      'externalOnlyAttachments',
      'formatVersion',
      'memberCount',
      'members',
      'product',
      'recordCounts',
      'roomCount',
      'storageGenerationFormatVersion',
      'subjectSchemaVersion',
      'totalBytes',
    ]);
    expect(manifest.product).toBe('kdsubject');
    expect(manifestText).not.toContain(NASTY_SUBJECT_ID);
    expect(manifestText).not.toContain(NASTY_ATTACHMENT_IDS.stored);
    for (const member of manifest.members as Array<Record<string, unknown>>) {
      expect(Object.keys(member).sort()).toEqual(['byteLength', 'path', 'sha256']);
    }
  });

  it('the member names are a fixed name or a content digest, and carry nothing else', () => {
    const names = readArchive(archive).map((file) => file.path);
    expect(names).toContain('manifest.json');
    for (const name of names) {
      const found = forbiddenFragmentsIn(name);
      expect(found, `${name}: ${describeForbiddenFragments(found)}`).toEqual([]);
      expect(
        name === 'manifest.json' ||
          name === 'subject.json' ||
          name === 'progression.json' ||
          name === 'sessions.json' ||
          name === 'assistance.json' ||
          /^attachments\/[0-9a-f]{64}$/.test(name),
        name,
      ).toBe(true);
    }
  });

  it('the offered file name carries nothing, and is a plain constant', () => {
    const found = forbiddenFragmentsIn(SUBJECT_BACKUP_FILE_NAME);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    expect(SUBJECT_BACKUP_FILE_NAME).toBe('knowledge-dungeon-subject-backup.kdsubject');
  });
});

describe('Phase 6 gate 7: the preview, the result, and the disclosures are free of learner data', () => {
  it('the preview a screen shows before the learner commits is free of it', () => {
    const preview = readSubjectArchive(archive);
    // Serialized whole, so a nested field cannot hide.
    const text = JSON.stringify(preview);
    const found = forbiddenFragmentsIn(text);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    // The preview has no top-level subject key at all: nothing in it names *which*
    // subject the archive holds, so a preview cannot put a subject on a learner's
    // screen before they have decided anything. A preview that named the subject
    // would also mean a *rejected* archive's subject id reached a report.
    expect(Object.keys(preview)).not.toContain('subjectId');
    expect(Object.keys(preview)).not.toContain('subjectName');
    // The one place an identifier does appear is the disclosure set, and it is
    // **opaque**: a minted subject id and room id, alongside the attachment id, so a
    // screen can tell a learner which of their images will not arrive. That is the
    // same shape Phase 5's `ExternalOnlyAttachmentReport` established, and an opaque
    // identifier is not learner data - what is forbidden is a value the learner
    // authored.
    expect(text).toContain(NASTY_SUBJECT_ID);
    expect(preview.externalOnlyAttachments[0]?.subjectId).toBe(NASTY_SUBJECT_ID);
    // No authored field appears anywhere in the preview's own shape.
    for (const key of ['subjectName', 'topic', 'noteText', 'artifactMarkdown', 'fileName', 'altText', 'externalUrl']) {
      expect(Object.keys(preview), key).not.toContain(key);
    }
    // The counts and versions a preview is for are all present and real.
    expect(preview.roomCount).toBeGreaterThan(0);
    expect(preview.recordCounts.subjects).toBe(1);
    expect(preview.subjectSchemaVersion).toBe('1.1.0');
    expect(preview.blockingPolicy).toBe('error-blocks-warning-discloses');
  });

  it('the import result is free of it, and reports only opaque ids and counts', async () => {
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: archive,
      now: NOW,
    });
    const text = JSON.stringify(result);
    const found = forbiddenFragmentsIn(text);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    // The result's own report shape: counts, codes, and opaque identifiers. The
    // identifier mapping is a list of {kind, from, to} triples, and `from` is a source
    // id - an opaque identifier, not learner content.
    expect(result.idMapping.every((entry) => Object.keys(entry).sort().join(',') === 'from,kind,to')).toBe(true);
    expect(result.disclosedWarnings.every((problem) => Object.keys(problem).sort().join(',') === 'code,count,scope,severity')).toBe(true);
    expect(result.preview.roomCount).toBeGreaterThan(0);
  });

  it('an external-only attachment is disclosed with a null hash and no filename', async () => {
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: archive,
      now: NOW,
    });
    expect(result.externalOnlyAttachments.length).toBe(1);
    const disclosure = result.externalOnlyAttachments[0];
    expect(disclosure?.attachmentId).toBe(NASTY_ATTACHMENT_IDS.external);
    // No fabricated hash, no fabricated length, and no filename or URL - the report
    // type has no field for either, and the assertion below is over the whole object.
    expect(disclosure?.contentHash).toBeNull();
    expect(disclosure?.byteLength).toBeNull();
    expect(disclosure?.reason).toBe('historical-external-url');
    const text = JSON.stringify(disclosure);
    const found = forbiddenFragmentsIn(text);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    expect(Object.keys(disclosure as object).sort()).toEqual([
      'attachmentId',
      'byteLength',
      'contentHash',
      'reason',
      'roomId',
      'sourceType',
      'subjectId',
    ]);
  });
});

describe('Phase 6 gate 7: no error a corrupt archive produces can carry learner data', () => {
  it('every corruption case produces a typed, sanitized, marker-free report', () => {
    const vocabulary = new Set(readStorageV2ErrorCodes());
    const cases = buildSubjectCorruptionCases({ good: archive, shape: readShape(archive) });
    expect(cases.length).toBeGreaterThanOrEqual(30);
    let checked = 0;
    for (const entry of cases) {
      const inspection = inspectSubjectArchive(entry.bytes);
      expect(inspection.ok, `${entry.id} was accepted`).toBe(false);
      if (inspection.ok) continue;
      const report = inspection.error;
      expect(vocabulary.has(report.code), `${entry.id}: ${report.code}`).toBe(true);
      // Every string detail satisfies the rule the `StorageV2Error` constructor itself
      // enforces, so a filename, a path, or a URL cannot be hiding in a report even
      // by accident.
      for (const [key, value] of Object.entries(report.details)) {
        if (typeof value !== 'string') continue;
        expect(isSanitizedDetailText(value), `${entry.id} detail ${key}`).toBe(true);
      }
      // ...and the serialized report carries no forbidden fragment.
      const text = JSON.stringify(report);
      const found = forbiddenFragmentsIn(text);
      expect(found, `${entry.id}: ${describeForbiddenFragments(found)}`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it('the import path throws the same sanitized errors the inspection path reports', async () => {
    // The two paths must agree: a screen previews with `inspectSubjectArchive` and
    // commits with `importSubjectBackup`, and a refusal that only the second path
    // produced would be a different refusal from the one the learner was shown.
    const cases = buildSubjectCorruptionCases({ good: archive, shape: readShape(archive) });
    for (const entry of cases.slice(0, 10)) {
      const inspection = inspectSubjectArchive(entry.bytes);
      let thrown: unknown = null;
      try {
        await importSubjectBackup({ repository: device.repository, bytes: entry.bytes, now: NOW });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.id).toBeInstanceOf(StorageV2Error);
      const failure = thrown as StorageV2Error;
      expect(inspection.ok).toBe(false);
      if (inspection.ok) continue;
      expect(failure.code, entry.id).toBe(inspection.error.code);
      expect(canonicalize(failure.toReport().details), entry.id).toBe(
        canonicalize(inspection.error.details),
      );
    }
  });

  it('the forbidden-fragment list is what this gate claims it is', () => {
    // The predicate is only meaningful if the list is real, and the marker is the
    // load-bearing entry.
    expect(FORBIDDEN_FRAGMENTS).toContain(MARKER_TOKEN);
    expect(MARKER_TOKEN.length).toBeGreaterThan(8);
    expect(new Set(FORBIDDEN_FRAGMENTS).size).toBe(FORBIDDEN_FRAGMENTS.length);
    expect(forbiddenFragmentsIn(`a ${MARKER_TOKEN} b`)).toEqual([MARKER_TOKEN]);
    expect(forbiddenFragmentsIn('nothing here')).toEqual([]);
  });
});

/** Two detail bags compared as sorted entries, so key order is not what is asserted. */
function canonicalize(details: Readonly<Record<string, string | number | boolean>>): string {
  return JSON.stringify(
    Object.entries(details)
      .map(([key, value]) => [key, value] as const)
      .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
  );
}
