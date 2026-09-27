/**
 * Hostile and corrupt `.kdsubject` fixtures for the Phase 6 gates.
 *
 * Every fixture is derived from one good archive the **product itself** wrote, so
 * "these two archives differ only in this one respect" is a fact rather than a
 * hope, and so the corruption cases attack the same kind of archive a learner would
 * actually open. That is the discipline `hostileZip.ts` established for the `.kdbak`
 * and it is followed here rather than reinvented.
 *
 * Two kinds of archive are built, and the difference matters:
 *
 * - **Well-formed variants are written through the audited production codec**
 *   (`writeArchive`) or through `fflate` directly where the production writer's own
 *   path validation is the behaviour under test. The product hand-rolls no ZIP and
 *   neither does this module; the only hand-assembled archives are the three shapes
 *   no well-behaved writer emits, and they are built from `rawZip` in
 *   `./hostileZip`, which is the same primitive the `.kdbak` gates use.
 * - **Consistently corrupt variants are recomputed.** A corruption that only breaks
 *   one checksum is caught by the checksum sweep and proves nothing about the rules
 *   behind it. So `reseal` rebuilds the manifest, the roll-up digest, and every
 *   per-member digest so the archive is *internally consistent* and structurally
 *   perfect, and the only thing wrong with it is the one property a case is named
 *   for. Those are the interesting cases: a manifest that lies about its own records
 *   while agreeing with its own digests is a forgery the product must catch on a
 *   semantic rule, not on a hash.
 *
 * Privacy: every payload is synthetic. No fixture introduces a subject name, a
 * topic, a note, a filename, or a URL; the only host named anywhere in this suite
 * is the reserved `example.invalid`, and it comes from the good archive, not from a
 * corruption.
 */

import { readArchive, writeArchive, type ArchiveFile } from '@/services/persistence/v2/archive';
import { sha256Hex } from '@/services/persistence/v2/checksum';
import { deterministicNoise, rawFflateZip, rawZip, zipCrc32 } from './hostileZip';
import { utf8 } from './hashes';
import {
  SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
  SUBJECT_ARCHIVE_MANIFEST_MEMBER,
  SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
  SUBJECT_ARCHIVE_SESSIONS_MEMBER,
  SUBJECT_ARCHIVE_SUBJECT_MEMBER,
} from '@/services/persistence/products/subjectBackup';

const decoder = new TextDecoder('utf-8', { fatal: false });

/** A long, safe, code-shaped name: legal in a ZIP, refused by the layout. */
export const OVERSIZED_MEMBER_NAME = `attachments/${'a'.repeat(4096)}`;

/**
 * A member name that is itself an `Object.prototype` own key, at the archive root.
 *
 * `constructor` rather than `__proto__` because fflate *can* represent this one -
 * the unrepresentable name gets its own case - and because a bare word would
 * otherwise be refused as "not under a member prefix", so using it proves the
 * prototype rule is the one that fired.
 */
export const PROTOTYPE_MEMBER_NAME = 'constructor';

/** An `Object.prototype` key in the position a content digest belongs. */
export const DECLARED_PROTOTYPE_MEMBER_NAME = 'attachments/constructor';

/** A member name that merely *contains* a prototype key, under a valid prefix. */
export const NESTED_PROTOTYPE_SEGMENT = 'attachments/__proto__';

/**
 * The one member name the ZIP codec cannot represent at all, so it is built by hand.
 *
 * `__proto__` at the archive root: fflate normalises member names into a plain object
 * internally, so this name changes that object's prototype, the member vanishes in
 * inflation, and the archive that comes out is not the archive that went in. Nothing
 * at the call site can report it, which is why the reader compares the archive's own
 * central directory against the members that came back.
 */
export const UNREPRESENTABLE_MEMBER_NAME = '__proto__';

export interface SubjectArchiveShape {
  readonly manifest: Record<string, unknown>;
  readonly subjectDocument: Record<string, unknown>;
  readonly progressionDocument: Record<string, unknown>;
  readonly sessionsDocument: Record<string, unknown>;
  readonly assistanceDocument: Record<string, unknown>;
  /** Attachment member path to its bytes, in write order. */
  readonly attachmentMembers: ReadonlyMap<string, Uint8Array>;
  /** Member paths in write order, manifest first. */
  readonly memberNames: readonly string[];
  readonly bytes: Uint8Array;
}

/** Every member of a good archive, keyed by path, manifest included. */
export function membersOf(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  // Read through the audited codec so the fixture's own view of the archive is the
  // production view. A fixture that read the archive any other way could disagree
  // with the product about what is in it - and that disagreement would look like a
  // product defect in a failure message.
  for (const file of readArchive(bytes)) out.set(file.path, file.bytes);
  return out;
}

function jsonOf(members: ReadonlyMap<string, Uint8Array>, path: string): Record<string, unknown> {
  return JSON.parse(decoder.decode(members.get(path) as Uint8Array)) as Record<string, unknown>;
}

/** Read a good archive back into its parts, so a variant can change exactly one. */
export function readShape(bytes: Uint8Array): SubjectArchiveShape {
  const members = membersOf(bytes);
  return {
    manifest: jsonOf(members, SUBJECT_ARCHIVE_MANIFEST_MEMBER),
    subjectDocument: jsonOf(members, SUBJECT_ARCHIVE_SUBJECT_MEMBER),
    progressionDocument: jsonOf(members, SUBJECT_ARCHIVE_PROGRESSION_MEMBER),
    sessionsDocument: jsonOf(members, SUBJECT_ARCHIVE_SESSIONS_MEMBER),
    assistanceDocument: jsonOf(members, SUBJECT_ARCHIVE_ASSISTANCE_MEMBER),
    attachmentMembers: new Map(
      [...members.entries()].filter(([path]) => path.startsWith('attachments/')),
    ),
    memberNames: [...members.keys()],
    bytes,
  };
}

/** Recompute a manifest from the members it is about, so only the named flaw remains. */
export function reseal(
  manifest: Record<string, unknown>,
  members: ReadonlyMap<string, Uint8Array>,
  overrides: { readonly declaredMemberCount?: number } = {},
): Record<string, unknown> {
  const payload = new Map(members);
  payload.delete(SUBJECT_ARCHIVE_MANIFEST_MEMBER);
  const entries = [...payload.entries()].map(([path, memberBytes]) => ({
    path,
    byteLength: memberBytes.byteLength,
    sha256: sha256Hex(memberBytes),
  }));
  const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
  const next: Record<string, unknown> = {
    ...manifest,
    memberCount: overrides.declaredMemberCount ?? entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(utf8(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    members: entries,
  };
  return next;
}

export interface RebuildInput {
  readonly manifest?: Record<string, unknown>;
  readonly subjectDocument?: Record<string, unknown>;
  readonly progressionDocument?: Record<string, unknown>;
  readonly sessionsDocument?: Record<string, unknown>;
  readonly assistanceDocument?: Record<string, unknown>;
  /** Replace or remove an attachment member. */
  readonly attachmentMembers?: ReadonlyMap<string, Uint8Array>;
  /** Extra members, appended after the fixed ones. */
  readonly extraMembers?: readonly ArchiveFile[];
  /** Drop a member entirely. */
  readonly omitMembers?: readonly string[];
  /** Re-seal the manifest against the members actually present. */
  readonly reseal?: boolean;
  /** Force a declared member-count disagreement after re-sealing. */
  readonly declaredMemberCountOverride?: number;
  /** Write one member as raw bytes instead of as canonical JSON. */
  readonly rawMembers?: ReadonlyMap<string, Uint8Array>;
}

/**
 * Rebuild a `.kdsubject` from parts.
 *
 * Every input is optional and defaults to the good archive's own value, so a case
 * that wants to change one thing changes exactly one thing. `reseal` is the switch
 * that decides whether the manifest is left as it was - which is how a
 * *consistently* corrupt archive is built - or recomputed against the members
 * actually present, which is how a "one byte differs" case is built.
 */
export function rebuild(good: SubjectArchiveShape, input: RebuildInput = {}): Uint8Array {
  const manifest = input.manifest ?? good.manifest;
  const documents: ArchiveFile[] = [
    { path: SUBJECT_ARCHIVE_SUBJECT_MEMBER, bytes: utf8(JSON.stringify(input.subjectDocument ?? good.subjectDocument)) },
    { path: SUBJECT_ARCHIVE_PROGRESSION_MEMBER, bytes: utf8(JSON.stringify(input.progressionDocument ?? good.progressionDocument)) },
    { path: SUBJECT_ARCHIVE_SESSIONS_MEMBER, bytes: utf8(JSON.stringify(input.sessionsDocument ?? good.sessionsDocument)) },
    { path: SUBJECT_ARCHIVE_ASSISTANCE_MEMBER, bytes: utf8(JSON.stringify(input.assistanceDocument ?? good.assistanceDocument)) },
  ];
  const attachments = input.attachmentMembers ?? good.attachmentMembers;
  const files: ArchiveFile[] = [...documents];
  for (const [path, memberBytes] of attachments) files.push({ path, bytes: memberBytes });
  for (const extra of input.extraMembers ?? []) files.push(extra);
  for (const omitted of input.omitMembers ?? []) {
    const index = files.findIndex((file) => file.path === omitted);
    if (index >= 0) files.splice(index, 1);
  }
  for (const [path, raw] of input.rawMembers ?? []) {
    const index = files.findIndex((file) => file.path === path);
    if (index >= 0) files.splice(index, 1, { path, bytes: raw });
  }

  const present = new Map<string, Uint8Array>();
  present.set(SUBJECT_ARCHIVE_MANIFEST_MEMBER, new Uint8Array(0));
  for (const file of files) present.set(file.path, file.bytes);

  const manifestBytes = input.reseal === true
    ? utf8(
        JSON.stringify(
          reseal(manifest, present, {
            ...(input.declaredMemberCountOverride === undefined
              ? {}
              : { declaredMemberCount: input.declaredMemberCountOverride }),
          }),
        ),
      )
    : input.rawMembers?.get(SUBJECT_ARCHIVE_MANIFEST_MEMBER) ?? utf8(JSON.stringify(manifest));

  return writeArchive([
    { path: SUBJECT_ARCHIVE_MANIFEST_MEMBER, bytes: manifestBytes },
    ...files,
  ]);
}

// ── The corruption cases ───────────────────────────────────────────────────

/** The typed code each case must fail with, and the sanitized reason. */
export interface SubjectCorruptionCase {
  readonly id: string;
  /** The contract rule the case violates, in words. Carries no payload. */
  readonly rule: string;
  readonly code: string;
  readonly reason: string;
  /** True when every recomputable checksum was recomputed, so only the rule is wrong. */
  readonly consistent: boolean;
  readonly bytes: Uint8Array;
}

export interface SubjectCorruptionCaseInput {
  readonly good: Uint8Array;
  readonly shape: SubjectArchiveShape;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function memberFilesOf(shape: SubjectArchiveShape): ArchiveFile[] {
  const members = membersOf(shape.bytes);
  return [...members.entries()].map(([path, bytes]) => ({ path, bytes }));
}

/**
 * Every corruption case, built from one good archive.
 *
 * The `consistent` flag is the important column: a case marked `true` has had its
 * manifest, its roll-up digest, and every per-member digest recomputed, so it is
 * structurally perfect and internally consistent, and the only thing wrong with it
 * is the property the case is named for. Those are the cases that prove the product
 * validates semantics rather than hashes.
 */
export function buildSubjectCorruptionCases(input: SubjectCorruptionCaseInput): SubjectCorruptionCase[] {
  const { good, shape } = input;
  const cases: SubjectCorruptionCase[] = [];
  const push = (
    id: string,
    rule: string,
    code: string,
    reason: string,
    consistent: boolean,
    bytes: Uint8Array,
  ): void => {
    cases.push({ id, rule, code, reason, consistent, bytes });
  };

  // 1. Not a ZIP at all.
  push(
    'random-bytes',
    'Bytes that are not a ZIP are refused before anything in them is interpreted.',
    'ARCHIVE_MALFORMED',
    'not-an-archive',
    false,
    deterministicNoise(4096),
  );

  // 2. Truncated below its end-of-central-directory record.
  push(
    'truncated-archive',
    'An archive whose bytes stop early is not a readable archive.',
    'ARCHIVE_MALFORMED',
    'truncated-archive',
    false,
    good.slice(0, Math.floor(good.byteLength * 0.875)),
  );

  // 3. Local file headers only, no member index.
  push(
    'missing-central-directory',
    'A member index is mandatory: without it no member can be addressed safely.',
    'ARCHIVE_MALFORMED',
    'missing-central-directory',
    false,
    (() => {
      const out: Uint8Array[] = [];
      let start = 0;
      // Take everything up to the first central-directory header, found by its magic.
      for (let index = 0; index + 4 <= good.byteLength; index += 1) {
        if (
          good[index] === 0x50 &&
          good[index + 1] === 0x4b &&
          good[index + 2] === 0x01 &&
          good[index + 3] === 0x02
        ) {
          start = index;
          break;
        }
      }
      out.push(good.slice(0, start));
      return out[0] as Uint8Array;
    })(),
  );

  // 4. `manifest.json` that is not JSON.
  push(
    'manifest-not-json',
    'The manifest is JSON; anything else is unreadable metadata.',
    'ARCHIVE_MALFORMED',
    'member-not-json',
    false,
    rebuild(shape, { rawMembers: new Map([[SUBJECT_ARCHIVE_MANIFEST_MEMBER, utf8('not json at all')]]) }),
  );

  // 5. `subject.json` that is not JSON.
  push(
    'subject-not-json',
    'The subject document is JSON; anything else is an unreadable subject.',
    'ARCHIVE_MALFORMED',
    'member-not-json',
    false,
    rebuild(shape, { rawMembers: new Map([[SUBJECT_ARCHIVE_SUBJECT_MEMBER, utf8('{"subject": not json')]]) }),
  );

  // 6. A document whose shape is wrong: the subject payload is an array.
  push(
    'subject-wrong-shape',
    'Parseable is not the same as valid: the subject document has a required shape.',
    'VALIDATION_FAILED',
    'document-wrong-shape',
    false,
    rebuild(shape, { subjectDocument: cloneJson({ ...shape.subjectDocument, subject: [] }) }),
  );

  // 7. The manifest claims a count its records do not meet, with **every digest
  //    recomputed**. The only thing wrong is the lie.
  push(
    'manifest-counts-disagree',
    'A manifest that lies about its own records, while agreeing with its own digests, is a forgery.',
    'COUNT_MISMATCH',
    'manifest-counts-disagree',
    true,
    rebuild(shape, {
      manifest: { ...cloneJson(shape.manifest), recordCounts: { ...(shape.manifest.recordCounts as object), sessions: 99 } },
      reseal: true,
    }),
  );

  // 8. The room count is wrong, consistently re-sealed.
  push(
    'manifest-room-count-disagrees',
    'The declared room count is a claim about the subject, and re-sealing does not make it true.',
    'COUNT_MISMATCH',
    'manifest-counts-disagree',
    true,
    rebuild(shape, {
      manifest: { ...cloneJson(shape.manifest), roomCount: 4242 },
      reseal: true,
    }),
  );

  // 9. A member's bytes no longer hash to what the manifest declared, with the
  //    manifest re-sealed: content addressing is broken, not the bookkeeping.
  push(
    'attachment-not-content-addressed',
    'An `attachments/<sha256>` member whose bytes do not hash to its own name is corrupt.',
    'CHECKSUM_MISMATCH',
    'member-checksum-mismatch',
    true,
    (() => {
      const members = new Map(shape.attachmentMembers);
      const [first] = [...members.keys()];
      if (first === undefined) throw new Error('The good archive carries no attachment member.');
      members.set(first, utf8('synthetic tampered attachment payload'));
      return rebuild(shape, { attachmentMembers: members, reseal: true });
    })(),
  );

  // 10. A declared member that is not in the archive. An **attachment** member, so
  //     the case is distinct from the fixed-member one below: this is the manifest
  //     lying about a member it describes, not a product-shaped file missing a
  //     member the plan requires.
  push(
    'missing-declared-member',
    'A member the manifest declares must be present.',
    'ARCHIVE_MEMBER_MISSING',
    'missing-declared-member',
    false,
    (() => {
      const [first] = [...shape.attachmentMembers.keys()];
      if (first === undefined) throw new Error('The good archive carries no attachment member.');
      return rebuild(shape, { omitMembers: [first] });
    })(),
  );

  // 11. A fixed member the plan requires, removed.
  push(
    'missing-assistance-member',
    'Every fixed member the plan names must be present; a `.kdsubject` without one is a different product.',
    'ARCHIVE_MEMBER_MISSING',
    'missing-fixed-member',
    false,
    rebuild(shape, { omitMembers: [SUBJECT_ARCHIVE_ASSISTANCE_MEMBER] }),
  );

  // 12. An extra member the closed layout does not define.
  push(
    'unexpected-extra-member',
    'The layout is closed: an unrecognised member is an archive this build must not import.',
    'ARCHIVE_MALFORMED',
    'unexpected-member',
    false,
    rebuild(shape, { extraMembers: [{ path: 'recovery/000001.json', bytes: utf8('{"unexpected":true}') }] }),
  );

  // 13. A member under a prefix the layout does not have.
  push(
    'unknown-prefix-member',
    'A `.kdsubject` has no `custom-sprites/` and no `recovery/`: those belong to the device.',
    'ARCHIVE_MALFORMED',
    'member-name-not-in-layout',
    true,
    rebuild(shape, {
      extraMembers: [{ path: 'custom-sprites/000001.svg', bytes: utf8('<svg/>') }],
      reseal: true,
    }),
  );

  // 14. A descriptive attachment member name: learner content in a path.
  push(
    'descriptive-attachment-member',
    'A member name that carries a filename is learner content that escaped into the filesystem-shaped part of the archive.',
    'ARCHIVE_MALFORMED',
    'member-name-not-in-layout',
    true,
    rebuild(shape, {
      attachmentMembers: new Map([['attachments/subject.json', utf8('{}')]]),
      reseal: true,
    }),
  );

  // 15. A member that escapes the extraction root, written by a writer that does not
  //     validate, so the *product's* safety rules are the ones under test.
  push(
    'zip-slip-member-name',
    'A member name may never escape the archive root.',
    'ARCHIVE_UNSAFE_PATH',
    'parent-traversal',
    false,
    rawFflateZip([...memberFilesOf(shape), { path: '../escape.json', bytes: utf8('{"escaped":true}') }]),
  );

  // 16. An absolute path.
  push(
    'absolute-path-member',
    'An absolute member name is a path, not a member of an archive.',
    'ARCHIVE_UNSAFE_PATH',
    'absolute-path',
    false,
    rawFflateZip([...memberFilesOf(shape), { path: '/etc/data-gate.json', bytes: utf8('{}') }]),
  );

  // 17. A Windows drive letter.
  push(
    'drive-letter-member',
    'A drive letter is a path, not a member of an archive.',
    'ARCHIVE_UNSAFE_PATH',
    'drive-letter',
    false,
    rawFflateZip([...memberFilesOf(shape), { path: 'C:/data-gate.json', bytes: utf8('{}') }]),
  );

  // 18. A 4096-character member name. Long enough that a buffer-bound bug appears.
  push(
    'oversized-member-name',
    'A member name of 4096 characters is refused on length, not on content.',
    'ARCHIVE_UNSAFE_PATH',
    'path-too-long',
    false,
    rawFflateZip([...memberFilesOf(shape), { path: OVERSIZED_MEMBER_NAME, bytes: utf8('{}') }]),
  );

  // 19. A member whose **name is** an `Object.prototype` key at the archive root,
  //     which fflate can represent. The unsafe-path rules would call a bare word
  //     "not under a member prefix", but the prototype check runs first, and it has
  //     to: an object-keyed index would treat this name as already present and the
  //     member would be lost.
  push(
    'prototype-member-name',
    'A prototype key is refused rather than indexed: an object-keyed index would lose it.',
    'ARCHIVE_UNSAFE_PATH',
    'prototype-member-name',
    false,
    rawFflateZip([...memberFilesOf(shape), { path: PROTOTYPE_MEMBER_NAME, bytes: utf8('{}') }]),
  );

  // 19a. The same key used as a *content-addressed* member name, declared and
  //      re-sealed, so the layout check is the one that refuses it. A distinct case
  //      from 19 for a distinct reason: the name is safe as a path and impossible as
  //      a digest, so the rule that catches it is the layout's, not the safety
  //      sweep's.
  push(
    'declared-prototype-member-name',
    'An `attachments/<sha256>` member name that is not a digest is not a member name, whatever it is called.',
    'ARCHIVE_MALFORMED',
    'member-name-not-in-layout',
    true,
    rebuild(shape, {
      extraMembers: [{ path: DECLARED_PROTOTYPE_MEMBER_NAME, bytes: utf8('{}') }],
      reseal: true,
    }),
  );

  // 20. A member name that merely *contains* a prototype key, under a valid prefix.
  //     The name itself is an ordinary string, so the member survives inflation and
  //     is caught by the closed-layout comparison - a different rule from 19, and
  //     both are asserted.
  push(
    'nested-prototype-segment-member',
    'A member name that contains a prototype key is a member name, and an undeclared member name is refused.',
    'ARCHIVE_MALFORMED',
    'unexpected-member',
    false,
    rawFflateZip([...memberFilesOf(shape), { path: NESTED_PROTOTYPE_SEGMENT, bytes: utf8('{}') }]),
  );

  // 20a. The one name the codec cannot represent, assembled by hand because no
  //      writer emits it. Inflation drops the member silently, and the reader's
  //      dropped-member check is the only thing that notices. This is the strongest
  //      of the safety cases: an archive that read "successfully" here would be one
  //      member short, and nothing else would say so.
  push(
    'unrepresentable-member-name',
    'A member the codec cannot represent is data loss, so the loss is caught rather than tolerated.',
    'ARCHIVE_UNSAFE_PATH',
    'prototype-member-name',
    false,
    (() => {
      const files = memberFilesOf(shape);
      return rawZip([
        ...files.map((file) => ({ name: file.path, bytes: file.bytes })),
        { name: UNREPRESENTABLE_MEMBER_NAME, bytes: utf8('{}') },
      ]);
    })(),
  );

  // 21. A directory entry, assembled by hand with a real directory mode.
  push(
    'directory-entry-member',
    'A member is data; an entry that declares itself a directory is a claim and is refused.',
    'ARCHIVE_UNSAFE_PATH',
    'directory-entry',
    false,
    (() => {
      const files = memberFilesOf(shape);
      return rawZip([
        ...files.map((file) => ({ name: file.path, bytes: file.bytes })),
        { name: 'attachments', directory: true, unixMode: 0o040755, bytes: new Uint8Array(0) },
      ]);
    })(),
  );

  // 22. A symlink-style member, assembled by hand.
  push(
    'symlink-style-member',
    'A member that would be materialised as a link is refused, whatever it is called.',
    'ARCHIVE_UNSAFE_PATH',
    'symlink-member',
    false,
    (() => {
      const files = memberFilesOf(shape);
      return rawZip([
        ...files.map((file) => ({ name: file.path, bytes: file.bytes })),
        { name: 'attachments/000001.lnk', unixMode: 0o120777, bytes: utf8('/etc/hostname') },
      ]);
    })(),
  );

  // 23. A forged product format version, in the manifest and in every document, with
  //     every digest recomputed.
  push(
    'forged-format-version',
    'A `.kdbak` must not be accepted as a `.kdsubject`, and a future layout version must be refused.',
    'VALIDATION_FAILED',
    'unsupported-product-format-version',
    true,
    rebuild(shape, {
      manifest: { ...cloneJson(shape.manifest), formatVersion: 99 },
      subjectDocument: { ...cloneJson(shape.subjectDocument), formatVersion: 99 },
      progressionDocument: { ...cloneJson(shape.progressionDocument), formatVersion: 99 },
      sessionsDocument: { ...cloneJson(shape.sessionsDocument), formatVersion: 99 },
      assistanceDocument: { ...cloneJson(shape.assistanceDocument), formatVersion: 99 },
      reseal: true,
    }),
  );

  // 24. A forged storage generation format version.
  push(
    'forged-storage-generation-version',
    'The storage-v2 generation record shape is its own contract, refused on its own.',
    'VALIDATION_FAILED',
    'unsupported-storage-format-version',
    true,
    rebuild(shape, {
      manifest: { ...cloneJson(shape.manifest), storageGenerationFormatVersion: 99 },
      subjectDocument: { ...cloneJson(shape.subjectDocument), storageGenerationFormatVersion: 99 },
      progressionDocument: { ...cloneJson(shape.progressionDocument), storageGenerationFormatVersion: 99 },
      sessionsDocument: { ...cloneJson(shape.sessionsDocument), storageGenerationFormatVersion: 99 },
      assistanceDocument: { ...cloneJson(shape.assistanceDocument), storageGenerationFormatVersion: 99 },
      reseal: true,
    }),
  );

  // 25. A forged subject schema version, in the manifest only: the documents still
  //     carry the real one, and the disagreement is itself the finding.
  push(
    'forged-subject-schema-version',
    'A newer subject schema must be refused, not partially restored, and a member may not claim a different contract from the manifest.',
    'VALIDATION_FAILED',
    'unsupported-subject-schema-version',
    true,
    rebuild(shape, {
      manifest: { ...cloneJson(shape.manifest), subjectSchemaVersion: '99.0.0' },
      reseal: true,
    }),
  );

  // 26. A manifest that claims this product but is really a device backup shape: a
  //     document the layout does not define, re-sealed so only the layout is wrong.
  push(
    'full-device-members-relabelled',
    'A `.kdbak` relabelled as a `.kdsubject` is refused: the layout is closed and the member set proves it.',
    'ARCHIVE_MEMBER_MISSING',
    'missing-fixed-member',
    true,
    (() => {
      const files = memberFilesOf(shape);
      const stateMember = files.find((file) => file.path === 'state.json');
      const stateBytes =
        stateMember?.bytes ??
        utf8(
          JSON.stringify({
            formatVersion: 1,
            storageGenerationFormatVersion: 1,
            subjectSchemaVersion: '1.1.0',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceGenerationId: 'gen-synthetic',
            activeSubjectId: null,
            locale: null,
            questState: null,
            subjects: [],
            progression: [],
            sessions: [],
            preferences: [],
            shortcuts: [],
            assistance: [],
            attachmentMetadata: [],
            customSprites: [],
            recovery: [],
            migrationReceipts: [],
          }),
        );
      // The `.kdbak`'s `state.json` takes the place of `subject.json`, and the three
      // list documents are dropped - so what is left is a device backup's member set
      // with this product's manifest on top. The manifest member itself is excluded
      // here and written once at the front, so the archive is structurally perfect
      // and the *only* thing wrong with it is which members it has.
      const renamed = files.map((file) =>
        file.path === SUBJECT_ARCHIVE_SUBJECT_MEMBER ? { path: 'state.json', bytes: stateBytes } : file,
      );
      const withoutFixed = renamed.filter(
        (file) => ![
          SUBJECT_ARCHIVE_MANIFEST_MEMBER,
          SUBJECT_ARCHIVE_SUBJECT_MEMBER,
          SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
          SUBJECT_ARCHIVE_SESSIONS_MEMBER,
          SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
        ].includes(file.path),
      );
      const present = new Map<string, Uint8Array>();
      for (const file of withoutFixed) present.set(file.path, file.bytes);
      return writeArchive([
        {
          path: SUBJECT_ARCHIVE_MANIFEST_MEMBER,
          bytes: utf8(JSON.stringify(reseal(shape.manifest, present))),
        },
        ...withoutFixed,
      ]);
    })(),
  );

  // 27. Two subjects' records in one archive: the documents disagree about which
  //     subject they belong to, and everything is re-sealed.
  push(
    'documents-name-different-subjects',
    'A `.kdsubject` carries one subject; documents that name different ones are not that product.',
    'VALIDATION_FAILED',
    'document-subject-disagrees',
    true,
    rebuild(shape, {
      sessionsDocument: {
        ...cloneJson(shape.sessionsDocument),
        subjectId: `${String(shape.subjectDocument.subjectId)}-other`,
      },
      reseal: true,
    }),
  );

  // 28. A subject record that is not a subject: `subjectId` is a number.
  push(
    'subject-id-not-a-string',
    'A subject record whose id is not a string cannot be keyed, so it is refused.',
    'VALIDATION_FAILED',
    'document-wrong-shape',
    false,
    rebuild(shape, {
      subjectDocument: {
        ...cloneJson(shape.subjectDocument),
        subject: { ...(shape.subjectDocument.subject as Record<string, unknown>), subjectId: 42 },
      },
    }),
  );

  // 29. A manifest with an extra key, so a future field would arrive unnoticed. The
  //     manifest's own digests are untouched and still agree with its members, so
  //     this is a *key-set* violation and nothing else - which is what a closed key
  //     set is for.
  push(
    'manifest-unexpected-field',
    'A closed key set is how a version conflation or an undeclared field is caught.',
    'VALIDATION_FAILED',
    'manifest-unexpected-field',
    true,
    rebuild(shape, { manifest: { ...cloneJson(shape.manifest), subjectName: 'synthetic' } }),
  );

  // 30. A manifest missing a required key.
  push(
    'manifest-missing-field',
    'A manifest missing a counts, versions, or checksums field cannot be trusted.',
    'VALIDATION_FAILED',
    'manifest-missing-field',
    false,
    (() => {
      const manifest = cloneJson(shape.manifest);
      delete manifest.contentChecksum;
      return rebuild(shape, { manifest });
    })(),
  );

  // 31. A lying member **length**, with every other field - the roll-up digest, the
  //     total, and the member's own SHA-256 - left consistent. The roll-up digest is
  //     computed over `sha256 path` and does not include the length, so this archive
  //     passes every digest check and is caught only by the length comparison. A gate
  //     that checked digests alone would import it.
  push(
    'manifest-member-length-disagrees',
    'A declared length that disagrees with the member is caught even when every digest agrees.',
    'CHECKSUM_MISMATCH',
    'member-checksum-mismatch',
    true,
    (() => {
      const present = new Map<string, Uint8Array>(membersOf(shape.bytes));
      present.delete(SUBJECT_ARCHIVE_MANIFEST_MEMBER);
      const sealed = reseal(shape.manifest, present);
      const members = (sealed.members as Array<Record<string, unknown>>).map((entry, index) =>
        index === 0 ? { ...entry, byteLength: (entry.byteLength as number) + 1 } : entry,
      );
      return rebuild(shape, {
        manifest: {
          ...sealed,
          members,
          totalBytes: (sealed.totalBytes as number) + 1,
        },
      });
    })(),
  );

  // 32. Empty: a structurally perfect archive with no members at all.
  push('empty-archive', 'An archive with no manifest is not a subject backup.', 'ARCHIVE_MALFORMED', 'no-members', false, rawZip([]));

  // 33. An external-only histogram that disagrees with the records, re-sealed.
  push(
    'external-only-histogram-disagrees',
    'A disclosure histogram that does not match the records is a count disagreement, not a warning.',
    'COUNT_MISMATCH',
    'manifest-counts-disagree',
    true,
    rebuild(shape, {
      manifest: {
        ...cloneJson(shape.manifest),
        externalOnlyAttachments: { count: 0, reasons: {} },
      },
      reseal: true,
    }),
  );

  return cases;
}

/** The CRC-32 of bytes, re-exported so a gate can prove a raw entry is well formed. */
export { zipCrc32 };
