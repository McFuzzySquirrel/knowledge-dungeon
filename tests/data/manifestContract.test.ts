/**
 * Phase 5 data-product gate 5: the manifest's shape, and what it must never carry.
 *
 * The manifest is the one member a learner might reasonably be tempted to read,
 * attach to a bug report, or paste into an issue, and the plan's section 12 rule 6
 * forbids putting learner data in a report. So the manifest is held to two
 * standards at once:
 *
 * 1. **Exact shape.** The pinned key set, the pinned per-member key set, the
 *    pinned sub-document key sets, and the pinned types. A manifest that grows a
 *    key fails by name; a manifest that drops one fails by name.
 * 2. **No learner content, and no path.** No subject name, no room topic, no note
 *    content, no attachment filename, no absolute path, and no host - checked
 *    against the manifest's serialized bytes *and* against every member path,
 *    because a member path is a filename in all but name.
 *
 * And one standard that is easy to state and easy to get wrong: the manifest must
 * record the **storage generation format version**, the **subject schema version**,
 * and the **data product format version** as three separate fields. Plan section
 * 12 rule 4 keeps those three concepts apart, and a product that collapses them
 * into one `version` field loses the ability to refuse an archive it cannot read.
 *
 * That last requirement gets a **positive control**, because the two numeric
 * version fields happen to share the value `1` today and value comparison
 * therefore cannot detect a conflation. The control builds a manifest with one
 * merged `version` key and requires the pinned check to reject it by name. Without
 * that control this file's strongest claim would be unfalsifiable.
 *
 * The registered half is the product's own manifest, which must satisfy the same
 * check and must be refused when a version field has been conflated.
 *
 * Privacy: the marker is planted in the device, the absence assertions run over
 * real serialized bytes, and the presence of the marker is asserted first so an
 * absent marker cannot be explained by an absent record.
 */

import { readArchive } from '@/services/persistence/v2/archive';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import { DATA_PRODUCT_FORMAT_VERSIONS } from '@/core/validation/persistence/types';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
} from '@/services/persistence/v2/schema';
import { manifestMember, produceArchive } from './support/backupAdapter';
import { platformSha256 } from './support/hashes';
import {
  FORBIDDEN_FRAGMENTS,
  describeForbiddenFragments,
  forbiddenFragmentsIn,
  isFreeOfLearnerContent,
  MARKER_ATTACHMENT_FILE_NAME,
  MARKER_NOTE_BODY,
  MARKER_ROOM_TOPIC,
  MARKER_SUBJECT_NAME,
  MARKER_TOKEN,
} from './support/marker';
import {
  ATTACHMENT_IDS,
  DEVICE_NOW,
  POPULATED_GENERATION_ID,
  ROOM_IDS,
  SUBJECT_IDS,
  createPopulatedDevice,
  resetLegacyStorage,
  type PopulatedDevice,
} from './support/populatedDevice';
import { referenceArchiveForDevice } from './support/referenceArchive';
import {
  REQUIRED_ATTACHMENT_BYTES_KEYS,
  REQUIRED_EXTERNAL_ONLY_KEYS,
  REQUIRED_MANIFEST_KEYS,
  REQUIRED_MANIFEST_MEMBER_KEYS,
  REQUIRED_RECORD_COUNT_KEYS,
  checkManifestKeys,
  classifyMemberPath,
  describeManifestKeyProblems,
} from './support/productInterface';

let device: PopulatedDevice;
let archive: ReturnType<typeof referenceArchiveForDevice>;
let manifestText: string;

beforeAll(async () => {
  resetLegacyStorage();
  device = await createPopulatedDevice('kd-data-gate-manifest');
  const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
  archive = referenceArchiveForDevice(device, snapshot);
  manifestText = new TextDecoder().decode(
    readArchive(archive.bytes).find((member) => member.path === 'manifest.json')?.bytes as Uint8Array,
  );
});

describe('Phase 5 gate 5: the absence assertions are not vacuous', () => {
  it('the marker really is in the device, in every field the gate names', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const stateJson = JSON.stringify(
      (snapshot.records as unknown as Record<string, { value: unknown }[]>).subjects.map(
        (envelope) => envelope.value,
      ),
    );
    // Four distinct learner-authored fields, all present on this device.
    expect(stateJson).toContain(MARKER_SUBJECT_NAME);
    expect(stateJson).toContain(MARKER_ROOM_TOPIC);
    // The note body is multi-line, and JSON escaping turns its newlines into
    // `\n`, so the *first line* is what can be matched literally. The full body
    // is checked separately, through the decoded value.
    const firstNoteLine = (MARKER_NOTE_BODY.split('\n')[0] as string).trim();
    expect(stateJson).toContain(firstNoteLine);
    const decoded = JSON.parse(stateJson) as Record<string, Record<string, unknown>>[];
    const alphaSnapshot = decoded[0]?.snapshot as unknown as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(alphaSnapshot.rooms['room-data-gate-alpha-root']?.noteText).toBe(MARKER_NOTE_BODY);
    expect(stateJson).toContain(MARKER_ATTACHMENT_FILE_NAME);
    expect(stateJson).toContain(MARKER_TOKEN);
    // And the marker is distinctive: nothing else in the fixture contains it.
    for (const value of [SUBJECT_IDS.alpha, ROOM_IDS.alphaRoot, ATTACHMENT_IDS.storedOne]) {
      expect(value).not.toContain(MARKER_TOKEN);
    }
    // The forbidden-fragment list is a real list, and the predicate really does
    // find the marker when it is there. A predicate that never fires would make
    // every absence assertion in this file meaningless.
    expect(forbiddenFragmentsIn(`prefix ${MARKER_TOKEN} suffix`)).toEqual([MARKER_TOKEN]);
    expect(isFreeOfLearnerContent(`prefix ${MARKER_TOKEN} suffix`)).toBe(false);
    expect(isFreeOfLearnerContent('nothing sensitive here')).toBe(true);
    expect(FORBIDDEN_FRAGMENTS.length).toBeGreaterThanOrEqual(8);
    expect(describeForbiddenFragments([])).toBe('no forbidden fragments');
  });
});

describe('Phase 5 gate 5: the manifest key set', () => {
  it('the pinned key set is twelve distinct keys, and the manifest has exactly those', () => {
    expect(REQUIRED_MANIFEST_KEYS).toHaveLength(12);
    expect(new Set(REQUIRED_MANIFEST_KEYS).size).toBe(12);
    // The check is run against the real serialized manifest, not a copy.
    expect(checkManifestKeys(JSON.parse(manifestText) as unknown)).toEqual([]);
    expect(Object.keys(archive.manifest).sort()).toEqual([...REQUIRED_MANIFEST_KEYS].sort());
  });

  it('the nested key sets are pinned too', () => {
    const members = archive.manifest.members as Record<string, unknown>[];
    expect(members.length).toBeGreaterThanOrEqual(4);
    for (const member of members) {
      expect(Object.keys(member).sort(), String(member.path)).toEqual(
        [...REQUIRED_MANIFEST_MEMBER_KEYS].sort(),
      );
    }
    expect(Object.keys(archive.manifest.attachmentBytes as object).sort()).toEqual(
      [...REQUIRED_ATTACHMENT_BYTES_KEYS].sort(),
    );
    expect(Object.keys(archive.manifest.externalOnlyAttachments as object).sort()).toEqual(
      [...REQUIRED_EXTERNAL_ONLY_KEYS].sort(),
    );
    // `recordCounts` covers every storage-v2 store, in the plan's own list.
    expect(Object.keys(archive.manifest.recordCounts as object).sort()).toEqual(
      [...REQUIRED_RECORD_COUNT_KEYS].sort(),
    );
  });

  it('POSITIVE CONTROL: a manifest with the three versions conflated is rejected by name', () => {
    // The control. `formatVersion` and `storageGenerationFormatVersion` are both
    // `1` in this build, so comparing values cannot detect a conflation - only
    // the key set can. So the key set is checked against a manifest that really
    // has collapsed them, and the check has to notice.
    const conflated = { ...archive.manifest } as Record<string, unknown>;
    delete conflated.formatVersion;
    delete conflated.storageGenerationFormatVersion;
    delete conflated.subjectSchemaVersion;
    conflated.version = DATA_PRODUCT_FORMAT_VERSIONS.kdbak;

    const problems = checkManifestKeys(conflated);
    const reported = problems.map((problem) => `${problem.key}:${problem.problem}`).sort();
    expect(reported).toEqual([
      'formatVersion:missing',
      'storageGenerationFormatVersion:missing',
      'subjectSchemaVersion:missing',
      'version:unexpected',
    ]);
    expect(describeManifestKeyProblems(problems)).toContain('storageGenerationFormatVersion missing');

    // The same for a manifest that keeps two of the three and merges the third.
    const partly = { ...archive.manifest } as Record<string, unknown>;
    delete partly.storageGenerationFormatVersion;
    partly.formatVersion = {
      product: DATA_PRODUCT_FORMAT_VERSIONS.kdbak,
      storage: STORAGE_V2_GENERATION_FORMAT_VERSION,
    };
    const partialProblems = checkManifestKeys(partly).map((problem) => `${problem.key}:${problem.problem}`);
    expect(partialProblems).toContain('storageGenerationFormatVersion:missing');
    expect(partialProblems).toContain('formatVersion:wrong-type');

    // ...and a manifest that puts the subject schema version in a number is caught
    // by the type check, which is the second line of defence behind the key set.
    const numericSubjectVersion = { ...archive.manifest } as Record<string, unknown>;
    numericSubjectVersion.subjectSchemaVersion = 1.1;
    expect(
      checkManifestKeys(numericSubjectVersion).map((problem) => `${problem.key}:${problem.problem}`),
    ).toContain('subjectSchemaVersion:wrong-type');
  });

  it('the three version fields carry the three real values, in three fields of two types', () => {
    expect(archive.manifest.formatVersion).toBe(DATA_PRODUCT_FORMAT_VERSIONS.kdbak);
    expect(archive.manifest.storageGenerationFormatVersion).toBe(
      STORAGE_V2_GENERATION_FORMAT_VERSION,
    );
    expect(archive.manifest.subjectSchemaVersion).toBe(CANONICAL_SUBJECT_SCHEMA_VERSION);
    // Two integers and one semver string: a single field cannot hold all three
    // without losing information, which is the structural reason the conflation
    // is a defect and not a style choice.
    expect(typeof archive.manifest.formatVersion).toBe('number');
    expect(typeof archive.manifest.storageGenerationFormatVersion).toBe('number');
    expect(typeof archive.manifest.subjectSchemaVersion).toBe('string');
    // The subject schema version really is the plan's, and the product format
    // version really is the one declared for `.kdbak` - read from the real
    // constants, not restated.
    expect(archive.manifest.subjectSchemaVersion).toBe('1.1.0');
    expect(archive.manifest.formatVersion).toBe(1);
  });
});

describe('Phase 5 gate 5: the manifest carries no learner content and no path', () => {
  it('the serialized manifest is free of every forbidden fragment', () => {
    const found = forbiddenFragmentsIn(manifestText);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    expect(isFreeOfLearnerContent(manifestText)).toBe(true);
    // The manifest really does carry content - counts, versions, digests - so the
    // absence above is not the absence of a document.
    expect(manifestText.length).toBeGreaterThan(200);
    expect(manifestText).toContain('"contentChecksum"');
    expect(manifestText).toContain('"recordCounts"');
  });

  it('every member path is a fixed name, a content address, or an opaque index', () => {
    const verdicts = archive.memberNames.map((path) => ({ path, verdict: classifyMemberPath(path) }));
    for (const { path, verdict } of verdicts) {
      expect(verdict.kind, `${path} -> ${JSON.stringify(verdict)}`).not.toBe('rejected');
    }
    expect(verdicts.filter((entry) => entry.verdict.kind === 'fixed-name').map((e) => e.path).sort()).toEqual([
      'manifest.json',
      'state.json',
    ]);
    const addressed = verdicts.filter((entry) => entry.verdict.kind === 'content-addressed');
    expect(addressed).toHaveLength(2);
    for (const entry of addressed) {
      const verdict = entry.verdict as { kind: 'content-addressed'; contentHash: string };
      // The content address really is the digest of the member's bytes, so the
      // name is verifiable rather than decorative.
      const bytes = archive.members.get(entry.path) as Uint8Array;
      expect(platformSha256(bytes), entry.path).toBe(verdict.contentHash);
    }
    const opaque = verdicts.filter((entry) => entry.verdict.kind === 'opaque-index');
    expect(opaque).toHaveLength(5);
  });

  it('no member path is absolute, contains a traversal, or names a host', () => {
    for (const path of archive.memberNames) {
      expect(path.startsWith('/'), path).toBe(false);
      expect(path.includes('..'), path).toBe(false);
      expect(path.includes('\\'), path).toBe(false);
      expect(path, path).not.toMatch(/^[a-zA-Z]:/);
      expect(path.includes('://'), path).toBe(false);
      expect(path.includes('@'), path).toBe(false);
      expect(forbiddenFragmentsIn(path), path).toEqual([]);
    }
    // And the classifier agrees, on the hostile shapes, so the accept-list above
    // is not just "the classifier said yes about everything".
    expect(classifyMemberPath('../escape.json')).toEqual({
      kind: 'rejected',
      reason: 'parent-traversal',
    });
    expect(classifyMemberPath('/etc/passwd')).toEqual({ kind: 'rejected', reason: 'absolute-path' });
    expect(classifyMemberPath('attachments/')).toEqual({ kind: 'rejected', reason: 'empty-segment' });
    expect(classifyMemberPath('C:/windows/system32')).toEqual({
      kind: 'rejected',
      reason: 'drive-letter',
    });
    expect(classifyMemberPath('custom-sprites\\000001.svg').kind).toBe('rejected');
    expect(classifyMemberPath('subjects/some-subject-name.json')).toEqual({
      kind: 'rejected',
      reason: 'unknown-prefix',
    });
    // A descriptive name under an *allowed* prefix is rejected for being
    // descriptive, which is the reason that actually protects the layout.
    expect(classifyMemberPath('attachments/some-subject-name.json')).toEqual({
      kind: 'rejected',
      reason: 'descriptive-member-name',
    });
    expect(classifyMemberPath('custom-sprites/warden-override.json')).toEqual({
      kind: 'rejected',
      reason: 'descriptive-member-name',
    });
    expect(classifyMemberPath('attachments/not-a-hash.png')).toEqual({
      kind: 'rejected',
      reason: 'descriptive-member-name',
    });
    expect(classifyMemberPath('unknown-prefix/000001.json')).toEqual({
      kind: 'rejected',
      reason: 'unknown-prefix',
    });
    expect(classifyMemberPath('attachments/a/b/c').kind).toBe('rejected');
  });
});

describe('Phase 5 gate 5: REGISTERED - the product manifest', () => {
  it("the product's exported manifest has exactly the pinned key set and no learner content", async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `exportFullDeviceBackup` in
    // `src/services/persistence/products/fullDeviceBackup.ts`, called with the
    // request object declared in `./support/backupAdapter`. The product
    // implements it, so this is now a live assertion.
    const bytes = await produceArchive({
      repository: device.repository,
      generationId: POPULATED_GENERATION_ID,
      now: DEVICE_NOW,
      payloadBytes: device.payloadBytes,
    });
    // The manifest is read out of the archive with the audited codec, so this
    // also proves the manifest is genuinely a member of the product's archive.
    const manifest = manifestMember(bytes);
    expect(checkManifestKeys(manifest), describeManifestKeyProblems(checkManifestKeys(manifest))).toEqual(
      [],
    );
    const text = new TextDecoder().decode(
      readArchive(bytes).find((member) => member.path === 'manifest.json')?.bytes as Uint8Array,
    );
    const found = forbiddenFragmentsIn(text);
    expect(found, describeForbiddenFragments(found)).toEqual([]);
    // Every member the manifest declares exists in the archive, and every member
    // path is acceptable.
    const declared = (manifest.members as { path: string }[]).map((entry) => entry.path);
    const actual = readArchive(bytes).map((member) => member.path);
    expect([...declared].sort()).toEqual(
      actual.filter((name) => name !== 'manifest.json').sort(),
    );
    for (const path of declared) {
      expect(classifyMemberPath(path).kind, path).not.toBe('rejected');
    }
    expect(manifest.memberCount).toBe(declared.length);
  });

  it('a manifest whose three version fields are conflated is refused on import', async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
    // `importFullDeviceBackup` in
    // `src/services/persistence/products/fullDeviceBackup.ts`. The archive below
    // is the reference archive with its manifest rewritten to collapse the three
    // version concepts into one, which is the defect this control exists to catch.
    // The product implements the import, so this is now a live assertion - and the
    // refusal it requires is the *key set* being closed, not a value comparison,
    // because the two numeric version fields happen to share the value 1.
    const { buildReferenceArchive } = await import('./support/hostileZip');
    const { referenceArchiveInput } = await import('./support/referenceArchive');
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const conflated = buildReferenceArchive({
      ...referenceArchiveInput(device, snapshot),
      manifestRawBytes: (() => {
        const merged = { ...archive.manifest } as Record<string, unknown>;
        delete merged.formatVersion;
        delete merged.storageGenerationFormatVersion;
        delete merged.subjectSchemaVersion;
        merged.version = DATA_PRODUCT_FORMAT_VERSIONS.kdbak;
        return new TextEncoder().encode(JSON.stringify(merged));
      })(),
    });
    const { consumeArchive } = await import('./support/backupAdapter');
    // The *right* refusal is observed, not merely "it threw": three required keys
    // are missing and one unexpected key is present, and a product that only
    // compared version values would have accepted this archive.
    let thrown: unknown = null;
    try {
      await consumeArchive(
        {
          repository: device.repository,
          generationId: POPULATED_GENERATION_ID,
          now: DEVICE_NOW,
          payloadBytes: device.payloadBytes,
        },
        conflated.bytes,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    const failure = thrown as StorageV2Error;
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.details.reason).toBe('manifest-missing-field');
    // The refusal names the missing key, which is a code-shaped field name, and
    // never a value.
    expect(failure.details.field).toBe('formatVersion');
  });
});
