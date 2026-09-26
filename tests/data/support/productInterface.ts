/**
 * The Phase 5 `.kdbak` product contract these gates hold the product to.
 *
 * The archive *layout* is fixed by the plan (section 7.3) and is not this
 * suite's to redesign:
 *
 * ```text
 * manifest.json
 * state.json
 * attachments/<sha256>
 * custom-sprites/*
 * recovery/*
 * ```
 *
 * What this module pins is the part the plan leaves to the phase:
 *
 * 1. **Where the product lives.** The two module paths are the plan's Phase 5
 *    "Expected files", and the entry points are named here - once - so a
 *    registered reproduction and the maintainer's implementation agree on a
 *    single list to align.
 * 2. **The manifest's exact key set**, including the three version fields the
 *    plan keeps separate.
 * 3. **The member-path rules** a member name must satisfy on write and on read.
 * 4. **The fifteen corruption cases** and the typed code each must fail with.
 *
 * Everything a registered reproduction could be said to "invent" lives here, in
 * data, so it can be read, reviewed, and changed in one place.
 *
 * Privacy: this module contains no learner data. Every identifier in it is
 * synthetic and code-shaped, and the only host named anywhere in the suite is
 * the reserved `example.invalid`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  DATA_PRODUCT_FORMAT_VERSIONS,
  type DataProductKind,
} from '@/core/validation/persistence/types';
import { STORAGE_V2_GENERATION_FORMAT_VERSION, STORAGE_V2_STORE_NAMES } from '@/services/persistence/v2/schema';
import type { StorageV2ErrorCode } from '@/services/persistence/v2/schema';

// ── Where the product lives ────────────────────────────────────────────────

/** The plan's Phase 5 product module. Alias-resolved, so `@/` is the path. */
export const FULL_DEVICE_BACKUP_MODULE = '@/services/persistence/products/fullDeviceBackup';

/** The plan's Phase 5 archive-validation module. */
export const ARCHIVE_VALIDATION_MODULE = '@/services/persistence/products/archiveValidation';

/** The build-time flag that owns Phase 5. Defaults to `false`. */
export const PHASE_5_FLAG_ENV_KEY = 'VITE_DATA_PRODUCTS_V2';

/**
 * Accepted export names for each capability.
 *
 * A verification rail has to name something, and a single invented name would
 * leave every registered reproduction red forever if the implementer chose a
 * different one. So each capability lists the names this suite will accept, and
 * the list is part of the pinned contract: a maintainer implementing the product
 * either exports one of these names or updates this list in the same change.
 *
 * A missing module *or* a missing export raises the same
 * {@link RegisteredReproduction}, naming the module and every accepted name, so
 * a registered test's failure message says exactly what it is waiting for.
 */
export const EXPORT_ENTRY_POINTS = {
  /** Produces the `.kdbak` bytes plus the manifest it declares. */
  exportArchive: ['exportFullDeviceBackup', 'createFullDeviceBackup', 'exportBackup'],
  /** Validates and reads an archive without touching stored data. */
  readArchive: ['readFullDeviceArchive', 'validateFullDeviceArchive', 'inspectFullDeviceArchive'],
  /** Stages and activates a new generation from an archive. */
  importArchive: ['importFullDeviceBackup', 'restoreFullDeviceBackup', 'importBackup'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * Raised when a gate needs the Phase 5 product and it is not implemented yet.
 *
 * The message is the whole point of the class: a registered reproduction's
 * failure has to be readable as *"waiting for this interface"*, never as
 * *"something went wrong"*. It is a plain `Error` so a suite that does not catch
 * it still fails loudly rather than passing quietly.
 */
export class RegisteredReproduction extends Error {
  readonly interfaceName: string;
  readonly modulePath: string;
  readonly acceptedExportNames: readonly string[];

  constructor(input: {
    readonly interfaceName: string;
    readonly modulePath: string;
    readonly acceptedExportNames: readonly string[];
  }) {
    super(
      `REGISTERED REPRODUCTION - waiting for the Phase 5 product interface ` +
        `${input.interfaceName}, exported by ${input.modulePath} ` +
        `(accepted names: ${input.acceptedExportNames.join(', ')}).`,
    );
    this.name = 'RegisteredReproduction';
    this.interfaceName = input.interfaceName;
    this.modulePath = input.modulePath;
    this.acceptedExportNames = input.acceptedExportNames;
  }
}

/** Loads a first-party module by alias, or raises a registered reproduction. */
export async function loadProductModule(modulePath: string): Promise<Record<string, unknown>> {
  // A variable specifier on purpose: a *literal* specifier for a module that does
  // not exist yet fails at transform time, which would stop this suite from being
  // collected at all. Resolution then happens at call time, inside the test body,
  // which is what lets `it.fails` see the failure.
  const specifier = modulePath;
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ specifier);
  } catch {
    throw new RegisteredReproduction({
      interfaceName: 'the module itself',
      modulePath,
      acceptedExportNames: EXPORT_CAPABILITY_NAMES,
    });
  }
  if (typeof loaded !== 'object' || loaded === null) {
    throw new RegisteredReproduction({
      interfaceName: 'a module namespace object',
      modulePath,
      acceptedExportNames: EXPORT_CAPABILITY_NAMES,
    });
  }
  return loaded as Record<string, unknown>;
}

/** Every accepted export name, flattened, for failure messages. */
export const EXPORT_CAPABILITY_NAMES: readonly string[] = Object.values(EXPORT_ENTRY_POINTS)
  .flat()
  .sort();

/** Resolves one capability to its live export, or raises a registered reproduction. */
export async function resolveProductExport(
  modulePath: string,
  capability: keyof typeof EXPORT_ENTRY_POINTS,
): Promise<(...args: readonly unknown[]) => unknown> {
  const module = await loadProductModule(modulePath);
  for (const name of EXPORT_ENTRY_POINTS[capability]) {
    const candidate = module[name];
    if (typeof candidate === 'function') {
      return candidate as (...args: readonly unknown[]) => unknown;
    }
  }
  throw new RegisteredReproduction({
    interfaceName: capability,
    modulePath,
    acceptedExportNames: EXPORT_ENTRY_POINTS[capability],
  });
}

// ── Manifest contract ──────────────────────────────────────────────────────

/** The product this manifest declares. Fixed by the plan's `.kdbak` section. */
export const FULL_DEVICE_PRODUCT: DataProductKind = 'kdbak';

/** The two member names the plan fixes by name. */
export const FIXED_MEMBER_NAMES = ['manifest.json', 'state.json'] as const;

/** Member-name prefixes the plan's layout allows. */
export const MEMBER_PREFIXES = ['attachments/', 'custom-sprites/', 'recovery/'] as const;

/**
 * The manifest's exact, complete key set.
 *
 * Three things are deliberate here:
 *
 * 1. **The three version fields are three separate keys.** The plan (section 12,
 *    rule 4) keeps the data product format version, the storage generation
 *    format version, and the subject schema version as separate contracts, and
 *    a product that collapses them into one `version` field fails this gate by
 *    name. See `manifestVersionSeparation.test.ts` for the positive control that
 *    proves the gate bites.
 * 2. **No key can hold learner content.** There is no `subjects`, no `rooms`,
 *    no `attachments[].fileName`; per-member identity is a path plus a length
 *    plus a digest.
 * 3. **Counts are per store, not a single total.** A `recordCounts` keyed by the
 *    storage-v2 store list is what lets an importer compare a declared count with
 *    what it actually read, per store.
 *
 * One counting rule, stated once because it is the only place the two member
 * counts can diverge: **`memberCount` is the number of entries in `members[]`**,
 * and `members[]` describes every member *except* `manifest.json` itself. A
 * member cannot contain its own digest, so the manifest is not self-describing;
 * an archive's total member count is therefore `memberCount + 1`. A reader that
 * compares `memberCount` with `members.length` must therefore get equality, and
 * a reader that compares it with the archive's member count must subtract one.
 * Getting this wrong is a real interoperability hazard, so the gate pins the
 * invariant rather than leaving it to interpretation.
 */
export const REQUIRED_MANIFEST_KEYS: readonly string[] = [
  'product',
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
  'createdAt',
  'memberCount',
  'totalBytes',
  'contentChecksum',
  'recordCounts',
  'attachmentBytes',
  'externalOnlyAttachments',
  'members',
];

/** The `members[]` entry key set: a path, a length, and a digest. Nothing else. */
export const REQUIRED_MANIFEST_MEMBER_KEYS: readonly string[] = ['path', 'byteLength', 'sha256'];

/** The `attachmentBytes` sub-document key set. */
export const REQUIRED_ATTACHMENT_BYTES_KEYS: readonly string[] = ['memberCount', 'byteLength'];

/** The `externalOnlyAttachments` sub-document key set. */
export const REQUIRED_EXTERNAL_ONLY_KEYS: readonly string[] = ['count', 'reasons'];

/**
 * The three version values, read from the real production constants.
 *
 * `formatVersion` and `storageGenerationFormatVersion` are both `1` today. That
 * coincidence is exactly why the gate does **not** rely on value inequality to
 * catch a conflation - it relies on the key set (three keys, not one) and on
 * the type difference (`subjectSchemaVersion` is a semver string; the other two
 * are integers). `manifestVersionSeparation.test.ts` proves that.
 */
export const EXPECTED_VERSION_VALUES = {
  formatVersion: DATA_PRODUCT_FORMAT_VERSIONS[FULL_DEVICE_PRODUCT],
  storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
  subjectSchemaVersion: CURRENT_SCHEMA_VERSION,
} as const;

/** The store names a `recordCounts` histogram must cover, in store order. */
export const REQUIRED_RECORD_COUNT_KEYS: readonly string[] = [...STORAGE_V2_STORE_NAMES].sort();

/**
 * A member path is acceptable when it is one of the two fixed names, or when it
 * is a content-addressed or opaque-index name under one of the three allowed
 * prefixes.
 *
 * The "acceptable" test is deliberately narrow. A member name that carries a
 * subject id, a room id, a topic, a note, or a filename is not a member name;
 * it is learner content that escaped into the filesystem-shaped part of the
 * archive.
 */
export type MemberPathVerdict =
  | { readonly kind: 'fixed-name' }
  | { readonly kind: 'content-addressed'; readonly contentHash: string }
  | { readonly kind: 'opaque-index'; readonly extension: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Lowercase 64-hex: the content-addressed member-name shape. */
const CONTENT_HASH_NAME = /^[0-9a-f]{64}$/;

/** A short, opaque, non-descriptive index segment. */
const OPAQUE_INDEX_SEGMENT = /^[a-z0-9]{6,24}$/;

/** Classifies one member path against the plan's layout. */
export function classifyMemberPath(path: string): MemberPathVerdict {
  if ((FIXED_MEMBER_NAMES as readonly string[]).includes(path)) {
    return { kind: 'fixed-name' };
  }
  if (typeof path !== 'string' || path.length === 0) {
    return { kind: 'rejected', reason: 'empty-path' };
  }
  if (path.includes('\\')) return { kind: 'rejected', reason: 'backslash-separator' };
  if (path.startsWith('/')) return { kind: 'rejected', reason: 'absolute-path' };
  if (/^[a-zA-Z]:/.test(path)) return { kind: 'rejected', reason: 'drive-letter' };
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    return { kind: 'rejected', reason: 'parent-traversal' };
  }
  if (segments.some((segment) => segment.length === 0)) {
    return { kind: 'rejected', reason: 'empty-segment' };
  }
  if (segments.length !== 2) {
    return { kind: 'rejected', reason: 'nested-too-deep' };
  }
  const [prefix, name] = segments as [string, string];
  // The plan writes the layout with a trailing slash (`attachments/<sha256>`);
  // the split above yields the bare directory, so the comparison strips it.
  if (!MEMBER_PREFIXES.some((allowed) => allowed.replace(/\/$/, '') === prefix)) {
    return { kind: 'rejected', reason: 'unknown-prefix' };
  }
  if (CONTENT_HASH_NAME.test(name)) return { kind: 'content-addressed', contentHash: name };
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const stem = name.slice(0, dot);
    const extension = name.slice(dot + 1);
    if (OPAQUE_INDEX_SEGMENT.test(stem) && /^[a-z0-9]{1,12}$/.test(extension)) {
      return { kind: 'opaque-index', extension };
    }
  }
  return { kind: 'rejected', reason: 'descriptive-member-name' };
}

// ── Corruption contract ────────────────────────────────────────────────────

/**
 * The fifteen corruption cases.
 *
 * The Phase 5 brief enumerates fourteen; the fifteenth,
 * `unsupported-subject-schema-version`, is added here because refusing an
 * archive whose subject schema version this build cannot read is the one case
 * that would otherwise let a *newer* backup be silently restored into an older
 * build and lose data. The count the brief asks for is 15 and the count here is
 * 15.
 */
export const CORRUPTION_CASE_IDS = [
  'truncated-archive',
  'missing-central-directory',
  'member-checksum-mismatch',
  'state-not-json',
  'state-wrong-shape',
  'manifest-not-json',
  'manifest-missing-field',
  'manifest-counts-disagree',
  'zip-slip-member-name',
  'directory-entry-member',
  'symlink-style-member',
  'unexpected-extra-member',
  'empty-archive',
  'random-bytes',
  'unsupported-subject-schema-version',
] as const;

export type CorruptionCaseId = (typeof CORRUPTION_CASE_IDS)[number];

/** Why the audited ZIP codec alone cannot catch a case today. */
export type CodecCoverage = 'codec-rejects' | 'requires-product-validation';

export interface CorruptionCaseSpec {
  readonly id: CorruptionCaseId;
  /** Human label, used in evidence and failure messages. Carries no payload. */
  readonly label: string;
  /** The contract rule the case violates, in words. */
  readonly rule: string;
  /** The typed code the import must fail with. */
  readonly expectedCode: StorageV2ErrorCode;
  /**
   * The sanitized reason the import's error must carry.
   *
   * Distinct from what the ZIP codec reports today: the codec reasons about ZIP
   * structure, and several of these are contract violations it cannot see.
   */
  readonly contractReason: string;
  readonly codecCoverage: CodecCoverage;
  /**
   * The code the audited ZIP codec produces today, when it can see the case at
   * all; `null` for the cases only `archiveValidation.ts` can catch.
   *
   * Pinned as a *measurement* rather than as a requirement, and asserted against
   * a real read of the real codec. It is kept separate from `expectedCode`
   * because the two legitimately differ: an empty archive, for instance, is
   * reported by the codec as `ARCHIVE_MEMBER_MISSING` (the member it went looking
   * for is absent) while the product contract reports `ARCHIVE_MALFORMED` with
   * reason `no-members`. A gate that conflated the two would be asserting a
   * behaviour the codec does not have.
   */
  readonly codecObservedCode: StorageV2ErrorCode | null;
  /** The sanitized reason the codec produces today, or `null`. */
  readonly codecObservedReason: string | null;
}

export const CORRUPTION_CASES: readonly CorruptionCaseSpec[] = [
  {
    id: 'truncated-archive',
    label: 'archive truncated below its end-of-central-directory record',
    rule: 'An archive whose bytes stop early is not a readable archive.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'truncated-archive',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_MALFORMED',
    codecObservedReason: 'unzip-failed',
  },
  {
    id: 'missing-central-directory',
    label: 'ZIP with local file headers but no central directory',
    rule: 'A member index is mandatory: without it no member can be addressed safely.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'missing-central-directory',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_MALFORMED',
    codecObservedReason: 'unzip-failed',
  },
  {
    id: 'member-checksum-mismatch',
    label: 'member whose SHA-256 does not match the manifest',
    rule: 'Every member is content-addressed; a member that does not hash to its name is corrupt.',
    expectedCode: 'CHECKSUM_MISMATCH',
    contractReason: 'member-checksum-mismatch',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
  {
    id: 'state-not-json',
    label: 'state.json that is not JSON',
    rule: 'state.json is JSON; anything else is unreadable state.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'member-not-json',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_MALFORMED',
    codecObservedReason: 'member-not-json',
  },
  {
    id: 'state-wrong-shape',
    label: 'state.json that is valid JSON of the wrong shape',
    rule: 'Parseable is not the same as valid: the state document has a required shape.',
    expectedCode: 'VALIDATION_FAILED',
    contractReason: 'state-wrong-shape',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
  {
    id: 'manifest-not-json',
    label: 'manifest.json that is not JSON',
    rule: 'manifest.json is JSON; anything else is unreadable metadata.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'member-not-json',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_MALFORMED',
    codecObservedReason: 'member-not-json',
  },
  {
    id: 'manifest-missing-field',
    label: 'manifest missing a required field',
    rule: 'A manifest missing a counts, versions, or checksums field cannot be trusted.',
    expectedCode: 'VALIDATION_FAILED',
    contractReason: 'manifest-missing-field',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
  {
    id: 'manifest-counts-disagree',
    label: 'manifest whose declared counts disagree with its members',
    rule: 'Declared counts are a claim about the members; a disagreement means the archive is inconsistent.',
    expectedCode: 'COUNT_MISMATCH',
    contractReason: 'manifest-counts-disagree',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
  {
    id: 'zip-slip-member-name',
    label: 'member named outside the extraction root',
    rule: 'A member name may never escape the archive root.',
    expectedCode: 'ARCHIVE_UNSAFE_PATH',
    contractReason: 'parent-traversal',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_UNSAFE_PATH',
    codecObservedReason: 'parent-traversal',
  },
  {
    id: 'directory-entry-member',
    label: 'member that is a directory entry',
    rule: 'A .kdbak member is a file; a directory entry carries no payload and is an entry-confusion vector.',
    expectedCode: 'ARCHIVE_UNSAFE_PATH',
    contractReason: 'directory-entry',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_UNSAFE_PATH',
    codecObservedReason: 'empty-segment',
  },
  {
    id: 'symlink-style-member',
    label: 'member marked as a symbolic link by its external attributes',
    rule: 'A backup member is data. A member that would be materialised as a link is refused.',
    expectedCode: 'ARCHIVE_UNSAFE_PATH',
    contractReason: 'symlink-member',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
  {
    id: 'unexpected-extra-member',
    label: 'archive carrying a member the layout does not define',
    rule: 'The layout is closed: an unrecognised member is an archive this build must not import.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'unexpected-member',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
  {
    id: 'empty-archive',
    label: 'well-formed archive with no members',
    rule: 'An archive with no manifest is not a backup.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'no-members',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_MEMBER_MISSING',
    codecObservedReason: null,
  },
  {
    id: 'random-bytes',
    label: 'bytes that are not a ZIP at all',
    rule: 'A file that is not a readable archive is refused before it is interpreted.',
    expectedCode: 'ARCHIVE_MALFORMED',
    contractReason: 'not-an-archive',
    codecCoverage: 'codec-rejects',
    codecObservedCode: 'ARCHIVE_MALFORMED',
    codecObservedReason: 'unzip-failed',
  },
  {
    id: 'unsupported-subject-schema-version',
    label: 'state.json declaring a subject schema version this build cannot read',
    rule: 'A newer subject schema must be refused, not partially restored.',
    expectedCode: 'VALIDATION_FAILED',
    contractReason: 'unsupported-subject-schema-version',
    codecCoverage: 'requires-product-validation',
    codecObservedCode: null,
    codecObservedReason: null,
  },
];

/** The case specs keyed by id, for lookup in a failure message. */
export const CORRUPTION_CASE_BY_ID: ReadonlyMap<CorruptionCaseId, CorruptionCaseSpec> = new Map(
  CORRUPTION_CASES.map((spec) => [spec.id, spec]),
);

/** How many cases the audited ZIP codec rejects without any product code. */
export const CODEC_REJECTED_CASE_COUNT = CORRUPTION_CASES.filter(
  (spec) => spec.codecCoverage === 'codec-rejects',
).length;

/**
 * The disclosure reason an external-only attachment gets, by source type.
 *
 * Taken from the real `ExternalOnlyAttachmentReport.reason` union in
 * `src/services/persistence/v2/schema.ts`, so a manifest that disclosed an
 * invented reason would not typecheck against this gate.
 */
export const EXTERNAL_ONLY_REASON_BY_SOURCE: Readonly<Record<string, string>> = {
  external: 'historical-external-url',
  local: 'bytes-not-recoverable',
};

// ── The real error vocabulary ──────────────────────────────────────────────

const SCHEMA_MODULE_PATH = 'src/services/persistence/v2/schema.ts';

/**
 * The `StorageV2ErrorCode` union, read out of the real source declaration.
 *
 * Every code this gate pins has to be a code the application can actually throw.
 * Parsing the declaration rather than importing the type keeps the check a
 * *runtime* one: a pinned code that stopped being part of the vocabulary fails
 * here, with the name of the code, instead of failing to compile in a way that
 * would be easy to mistake for a typo.
 */
export function readStorageV2ErrorCodes(): readonly string[] {
  const absolute = join(process.cwd(), SCHEMA_MODULE_PATH);
  const source = readFileSync(absolute, 'utf8');
  const declaration = /export type StorageV2ErrorCode =([\s\S]*?);/.exec(source);
  if (declaration === null) {
    throw new Error(`${SCHEMA_MODULE_PATH} does not declare StorageV2ErrorCode.`);
  }
  return [...(declaration[1] as string).matchAll(/'([A-Z0-9_]+)'/g)]
    .map((match) => match[1] as string)
    .sort();
}

/** The real source file the error vocabulary is declared in. */
export const ERROR_VOCABULARY_SOURCE = SCHEMA_MODULE_PATH;

// ── Manifest key-set check ─────────────────────────────────────────────────

/** One manifest key-set problem. Names the key, never a value. */
export interface ManifestKeyProblem {
  readonly key: string;
  readonly problem: 'missing' | 'unexpected' | 'wrong-type';
  readonly expected: string;
}

/**
 * Compare a manifest's key set against the pinned contract.
 *
 * Written as a function rather than inlined into a test so the *same* check can
 * be run against a deliberately conflated manifest: that positive control is what
 * makes the three-separate-version-fields requirement falsifiable rather than
 * aspirational.
 */
export function checkManifestKeys(manifest: unknown): ManifestKeyProblem[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return [{ key: '*', problem: 'wrong-type', expected: 'object' }];
  }
  const record = manifest as Record<string, unknown>;
  const problems: ManifestKeyProblem[] = [];

  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!(key in record)) problems.push({ key, problem: 'missing', expected: 'present' });
  }
  for (const key of Object.keys(record).sort()) {
    if (!REQUIRED_MANIFEST_KEYS.includes(key)) {
      problems.push({ key, problem: 'unexpected', expected: 'absent' });
    }
  }

  // Type expectations that a key set alone cannot express. `subjectSchemaVersion`
  // is a semver string and the other two version fields are integers, which is
  // precisely why one field cannot stand in for all three.
  const integerKeys = ['formatVersion', 'storageGenerationFormatVersion', 'memberCount', 'totalBytes'] as const;
  for (const key of integerKeys) {
    if (key in record && !Number.isInteger(record[key])) {
      problems.push({ key, problem: 'wrong-type', expected: 'integer' });
    }
  }
  if (
    'subjectSchemaVersion' in record &&
    (typeof record.subjectSchemaVersion !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(String(record.subjectSchemaVersion)))
  ) {
    problems.push({ key: 'subjectSchemaVersion', problem: 'wrong-type', expected: 'semver-string' });
  }
  if ('contentChecksum' in record && !/^[0-9a-f]{64}$/.test(String(record.contentChecksum))) {
    problems.push({ key: 'contentChecksum', problem: 'wrong-type', expected: 'sha256-hex' });
  }
  for (const key of ['createdAt', 'product'] as const) {
    if (key in record && typeof record[key] !== 'string') {
      problems.push({ key, problem: 'wrong-type', expected: 'string' });
    }
  }
  for (const key of ['recordCounts', 'attachmentBytes', 'externalOnlyAttachments'] as const) {
    if (key in record && (typeof record[key] !== 'object' || record[key] === null || Array.isArray(record[key]))) {
      problems.push({ key, problem: 'wrong-type', expected: 'object' });
    }
  }
  if (!Array.isArray(record.members)) {
    problems.push({ key: 'members', problem: 'wrong-type', expected: 'array' });
  }

  return problems;
}

/** Compact, leak-free rendering of manifest key problems. */
export function describeManifestKeyProblems(problems: readonly ManifestKeyProblem[]): string {
  if (problems.length === 0) return 'no problems';
  return problems
    .slice(0, 12)
    .map((problem) => `${problem.key} ${problem.problem} (${problem.expected})`)
    .join('; ');
}
