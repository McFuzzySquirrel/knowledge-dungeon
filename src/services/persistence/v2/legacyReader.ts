/**
 * Read-only reader for the current `localStorage` app state.
 *
 * The allowlist below is **explicit and closed**. This module never enumerates
 * "whatever starts with `knowledge-dungeon:`" for reading purposes: it reads
 * only the keys a production reader or writer actually owns, as enumerated in
 * `tests/contracts/phase-0-baseline.md` section 3. That keeps the migration
 * from absorbing an unrelated key, a third-party script's key, or a key a
 * future feature adds before the migration contract is revisited.
 *
 * Two hard rules:
 *
 * 1. **Read only.** Nothing in this module calls `setItem`, `removeItem`, or
 *    `clear`. Legacy keys are never written and never deleted (plan section 12,
 *    rule 11; Phase 3 non-goal "No deletion of legacy keys").
 * 2. **Sanitized reporting.** A per-key report carries a status, a reason code,
 *    and a byte length. It never carries a value, a subject name, a topic, a
 *    note, or an attachment filename.
 */

import type { RoomAttachment } from '@/core/validation/persistence';
import type { StorageV2StoreName } from './schema';

// ── Allowlist ─────────────────────────────────────────────────────────────

/** Which legacy key family a key belongs to. Drives the storage-v2 target. */
export type LegacyKeyKind =
  | 'subject-index'
  | 'subject'
  | 'active-subject'
  | 'progression'
  | 'session-declared'
  | 'sessions'
  | 'recovery-backup'
  | 'recovery-corrupt'
  | 'quest'
  | 'navigation'
  | 'ui-marker'
  | 'preferences'
  | 'shortcuts'
  | 'locale'
  | 'custom-sprite-override'
  | 'custom-sprite-anim'
  | 'custom-sprite-original'
  | 'custom-sprite-packs';

/** How a legacy value is interpreted. `raw-string` values are never parsed. */
export type LegacyValueShape = 'json' | 'raw-string' | 'plain-string';

export interface LegacyKeySpec {
  /** Stable, non-learner identifier for this allowlist entry. */
  keyId: string;
  kind: LegacyKeyKind;
  /** Exact key, or a prefix for a dynamic key family. */
  key?: string;
  keyPrefix?: string;
  shape: LegacyValueShape;
  /** Storage-v2 store this family migrates into. */
  targetStore: StorageV2StoreName;
}

/**
 * Every app-owned legacy key the migration is allowed to read.
 *
 * Judgment calls, each recorded next to its entry:
 *
 * 1. `knowledge-dungeon:v1:session` is **read but never synthesized**. The
 *    baseline records it as a declared constant with no production writer. It is
 *    read as a raw string so a value written by a build that did write it is not
 *    silently dropped, and a missing key is reported `absent`, which is correct.
 * 2. `kd-subject-index` and `kd-subject:<subjectId>` are **excluded**. The
 *    baseline attributes them to `scripts/capture-screenshots.mjs`, a
 *    screenshot tool, not to production source. Importing them would migrate
 *    fixture data into a learner's device.
 * 3. `knowledge-dungeon:subjects:index` is **excluded on purpose**. It appears
 *    only as a test input in `tests/unit/preferencesStore.test.ts`; no
 *    production reader or writer declares it. The baseline explicitly leaves the
 *    import policy to this decision: importing a key the application never wrote
 *    would be inventing data, so it is treated as not app-owned.
 * 4. UI markers (`knowledge-dungeon:ui:*`) are **read but reported, not
 *    migrated** into a data store. They are one-time UI state, not learner
 *    content, and the storage-v2 generation has no store for them yet. Reading
 *    them keeps the report honest about what exists.
 * 5. `perfMonitor` and `errorRecovery` count `knowledge-dungeon:` keys, but that
 *    is an accounting prefix, not a key, so it is not an allowlist entry.
 */
export const LEGACY_STORAGE_KEY_ALLOWLIST: readonly LegacyKeySpec[] = [
  // ── Subject, progression, session, recovery ──
  {
    keyId: 'subject-index',
    kind: 'subject-index',
    key: 'knowledge-dungeon:v1:subjects',
    shape: 'json',
    targetStore: 'subjects',
  },
  {
    keyId: 'subject',
    kind: 'subject',
    keyPrefix: 'knowledge-dungeon:v1:subject:',
    shape: 'json',
    targetStore: 'subjects',
  },
  {
    keyId: 'active-subject',
    kind: 'active-subject',
    key: 'knowledge-dungeon:v1:activeSubjectId',
    shape: 'plain-string',
    targetStore: 'subjects',
  },
  {
    keyId: 'progression',
    kind: 'progression',
    key: 'knowledge-dungeon:v1:progression',
    shape: 'json',
    targetStore: 'progression',
  },
  {
    keyId: 'session-declared',
    kind: 'session-declared',
    key: 'knowledge-dungeon:v1:session',
    shape: 'raw-string',
    targetStore: 'sessions',
  },
  {
    keyId: 'sessions',
    kind: 'sessions',
    key: 'knowledge-dungeon:v1:sessions',
    shape: 'json',
    targetStore: 'sessions',
  },
  {
    keyId: 'recovery-backup',
    kind: 'recovery-backup',
    keyPrefix: 'knowledge-dungeon:backup:',
    shape: 'raw-string',
    targetStore: 'recovery',
  },
  {
    keyId: 'recovery-corrupt',
    kind: 'recovery-corrupt',
    keyPrefix: 'knowledge-dungeon:corrupt:',
    shape: 'raw-string',
    targetStore: 'recovery',
  },

  // ── Quest, navigation, UI markers ──
  { keyId: 'quest-step', kind: 'quest', key: 'kd-quest-step', shape: 'plain-string', targetStore: 'sessions' },
  {
    keyId: 'village-spawn',
    kind: 'navigation',
    key: 'kd-village-spawn',
    shape: 'json',
    targetStore: 'sessions',
  },
  {
    keyId: 'ui-touch-hint',
    kind: 'ui-marker',
    key: 'knowledge-dungeon:ui:touch-hint:v1',
    shape: 'plain-string',
    targetStore: 'preferences',
  },
  {
    keyId: 'ui-fishing-hint',
    kind: 'ui-marker',
    key: 'knowledge-dungeon:ui:fishing-hint:v1',
    shape: 'plain-string',
    targetStore: 'preferences',
  },
  {
    keyId: 'ui-onboarding-gameplay-loop',
    kind: 'ui-marker',
    key: 'knowledge-dungeon:ui:onboarding:gameplay-loop:v1',
    shape: 'plain-string',
    targetStore: 'preferences',
  },
  {
    keyId: 'ui-export-reminder',
    kind: 'ui-marker',
    key: 'knowledge-dungeon:ui:export-reminder:lastNudge',
    shape: 'plain-string',
    targetStore: 'preferences',
  },
  {
    keyId: 'ui-tooltips',
    kind: 'ui-marker',
    key: 'knowledge-dungeon:ui:tooltips:v1',
    shape: 'json',
    targetStore: 'preferences',
  },

  // ── Preferences, shortcuts, locale ──
  {
    keyId: 'preferences',
    kind: 'preferences',
    key: 'knowledge-dungeon:session:preferences',
    shape: 'json',
    targetStore: 'preferences',
  },
  {
    keyId: 'shortcuts',
    kind: 'shortcuts',
    key: 'knowledge-dungeon:session:shortcuts',
    shape: 'json',
    targetStore: 'shortcuts',
  },
  {
    keyId: 'locale',
    kind: 'locale',
    key: 'knowledge-dungeon:locale',
    shape: 'plain-string',
    targetStore: 'preferences',
  },

  // ── Custom sprite state ──
  {
    keyId: 'custom-sprite-override',
    kind: 'custom-sprite-override',
    keyPrefix: 'knowledge-dungeon:custom-sprites:override:',
    shape: 'raw-string',
    targetStore: 'customSprites',
  },
  {
    keyId: 'custom-sprite-anim',
    kind: 'custom-sprite-anim',
    keyPrefix: 'knowledge-dungeon:custom-sprites:anim:',
    shape: 'json',
    targetStore: 'customSprites',
  },
  {
    keyId: 'custom-sprite-original',
    kind: 'custom-sprite-original',
    keyPrefix: 'knowledge-dungeon:custom-sprites:originals:',
    shape: 'raw-string',
    targetStore: 'customSprites',
  },
  {
    keyId: 'custom-sprite-packs',
    kind: 'custom-sprite-packs',
    key: 'knowledge-dungeon:custom-sprites:packs',
    shape: 'json',
    targetStore: 'customSprites',
  },
] as const;

/** Keys the allowlist deliberately excludes, with the reason. */
export const LEGACY_KEY_EXCLUSIONS: readonly { key: string; reason: string }[] = [
  {
    key: 'knowledge-dungeon:subjects:index',
    reason:
      'Test-only legacy spelling. No production reader or writer declares it, so importing it ' +
      'would invent data the application never wrote.',
  },
  {
    key: 'kd-subject-index',
    reason: 'Screenshot-tool injection (scripts/capture-screenshots.mjs), not production source.',
  },
  {
    key: 'kd-subject:<subjectId>',
    reason: 'Screenshot-tool injection (scripts/capture-screenshots.mjs), not production source.',
  },
  {
    key: 'knowledge-dungeon:',
    reason: 'Accounting prefix used by perfMonitor and errorRecovery, not a key of its own.',
  },
];

// ── Read-only storage access ──────────────────────────────────────────────

/** The subset of the Storage API this module is allowed to use. */
export interface ReadOnlyLegacyStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

function resolveStorage(storage?: ReadOnlyLegacyStorage): ReadOnlyLegacyStorage | null {
  if (storage) return storage;
  const candidate = (globalThis as { localStorage?: ReadOnlyLegacyStorage }).localStorage;
  return candidate ?? null;
}

/** Every key currently in storage, in storage order. Read-only. */
export function listStorageKeys(storage?: ReadOnlyLegacyStorage): string[] {
  const resolved = resolveStorage(storage);
  if (!resolved) return [];
  const keys: string[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    const key = resolved.key(index);
    if (typeof key === 'string') keys.push(key);
  }
  return keys;
}

function matchesSpec(key: string, spec: LegacyKeySpec): boolean {
  if (spec.key !== undefined) return key === spec.key;
  if (spec.keyPrefix !== undefined) {
    return key.startsWith(spec.keyPrefix) && key.length > spec.keyPrefix.length;
  }
  return false;
}

/** Every stored key the allowlist covers, with the spec that matched it. */
export function resolveAllowlistedKeys(
  storage?: ReadOnlyLegacyStorage,
): { key: string; spec: LegacyKeySpec }[] {
  const resolved = resolveStorage(storage);
  const present = new Set(listStorageKeys(resolved ?? undefined));
  const matches: { key: string; spec: LegacyKeySpec }[] = [];
  for (const spec of LEGACY_STORAGE_KEY_ALLOWLIST) {
    if (spec.key !== undefined) {
      if (present.has(spec.key)) matches.push({ key: spec.key, spec });
      continue;
    }
    for (const key of present) {
      if (matchesSpec(key, spec)) matches.push({ key, spec });
    }
  }
  // Deterministic order: by allowlist position, then by key.
  return matches.sort((a, b) => {
    const left = LEGACY_STORAGE_KEY_ALLOWLIST.indexOf(a.spec);
    const right = LEGACY_STORAGE_KEY_ALLOWLIST.indexOf(b.spec);
    if (left !== right) return left - right;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// ── Reports ───────────────────────────────────────────────────────────────

export type LegacyKeyStatus = 'present' | 'absent' | 'parse-error' | 'unsupported-shape';

export type LegacyReadReasonCode =
  | 'ok'
  | 'key-absent'
  | 'json-parse-failed'
  | 'unexpected-json-shape'
  | 'stored-outside-allowlist';

export interface LegacyKeyReport {
  /** Allowlist entry id, plus the dynamic suffix for a key family. */
  keyId: string;
  kind: LegacyKeyKind;
  status: LegacyKeyStatus;
  reason: LegacyReadReasonCode | null;
  /** Byte length of the stored value. Metadata only; never the value. */
  byteLength: number;
  /** Element count for a JSON array value, otherwise `null`. */
  itemCount: number | null;
  targetStore: StorageV2StoreName;
}

export interface LegacyAttachmentInventory {
  /** Opaque attachment id. */
  attachmentId: string;
  subjectId: string;
  roomId: string;
  sourceType: 'local' | 'external';
  /** `true` when no bytes are recoverable from the legacy web build. */
  externalOnly: boolean;
  reason:
    | 'historical-external-url'
    | 'bytes-not-recoverable'
    | 'bytes-missing-locally'
    | null;
}

export interface LegacyReadReport {
  keys: LegacyKeyReport[];
  totals: {
    allowlistedKeys: number;
    present: number;
    absent: number;
    parseErrors: number;
    unsupportedShapes: number;
  };
  /** Histogram: subject schema version -> number of subject payloads. */
  subjectSchemaVersions: Record<string, number>;
  /** Histogram: persisted progression version -> 1 when that version was read. */
  progressionVersions: Record<string, number>;
  recovery: { count: number; byteLength: number };
  attachments: { total: number; externalOnly: number };
  /** Stored keys outside the allowlist. Count only, never the keys. */
  keysOutsideAllowlist: number;
}

export interface LegacySubjectPayload {
  subjectId: string;
  /** Raw stored string, preserved verbatim. */
  raw: string;
  /** Parsed payload, or `null` when it did not parse. */
  parsed: unknown;
  schemaVersion: string | null;
}

export interface LegacyRecoveryPayload {
  kind: 'backup' | 'corrupt';
  subjectId: string;
  raw: string;
}

export interface LegacyCustomSpritePayload {
  spritePath: string;
  override: string | null;
  anim: string | null;
  original: string | null;
}

export interface LegacyAppState {
  activeSubjectId: string | null;
  /** Subject ids in the declared order, then any key-only subjects, sorted. */
  subjectIds: string[];
  subjects: LegacySubjectPayload[];
  progressionRaw: string | null;
  sessionsRaw: string | null;
  /** Raw value of the declared-but-unwritten `knowledge-dungeon:v1:session` key. */
  declaredSessionRaw: string | null;
  questStep: string | null;
  villageSpawn: string | null;
  uiMarkers: Record<string, string | null>;
  preferencesRaw: string | null;
  shortcutsRaw: string | null;
  locale: string | null;
  customSprites: LegacyCustomSpritePayload[];
  spritePacksRaw: string | null;
  recovery: LegacyRecoveryPayload[];
  attachments: LegacyAttachmentInventory[];
  report: LegacyReadReport;
}

export interface ReadLegacyAppStateOptions {
  storage?: ReadOnlyLegacyStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Raw string for a fixed allowlist key, or `null` when absent. */
function rawString(raws: Map<string, unknown>, keyId: string): string | null {
  const value = raws.get(keyId);
  return typeof value === 'string' ? value : null;
}

/** Raw strings of a dynamic allowlist family, keyed by the dynamic id. */
function rawFamily(raws: Map<string, unknown>, keyId: string): Record<string, string | null> {
  const value = raws.get(`${keyId}#family`);
  return isRecord(value) ? (value as Record<string, string | null>) : {};
}

/** Parsed values of a dynamic allowlist family, keyed by the dynamic id. */
function parsedFamily(values: Map<string, unknown>, keyId: string): Record<string, unknown> {
  const value = values.get(`${keyId}#family`);
  return isRecord(value) ? value : {};
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function readKey(
  storage: ReadOnlyLegacyStorage,
  key: string,
  spec: LegacyKeySpec,
  keyId: string,
): { report: LegacyKeyReport; raw: string | null; parsed: unknown } {
  const raw = storage.getItem(key);
  if (raw === null) {
    return {
      raw: null,
      parsed: null,
      report: {
        keyId,
        kind: spec.kind,
        status: 'absent',
        reason: 'key-absent',
        byteLength: 0,
        itemCount: null,
        targetStore: spec.targetStore,
      },
    };
  }

  if (spec.shape === 'json') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return {
        raw,
        parsed,
        report: {
          keyId,
          kind: spec.kind,
          status: 'present',
          reason: 'ok',
          byteLength: byteLength(raw),
          itemCount: Array.isArray(parsed) ? parsed.length : null,
          targetStore: spec.targetStore,
        },
      };
    } catch {
      return {
        raw,
        parsed: null,
        report: {
          keyId,
          kind: spec.kind,
          status: 'parse-error',
          reason: 'json-parse-failed',
          byteLength: byteLength(raw),
          itemCount: null,
          targetStore: spec.targetStore,
        },
      };
    }
  }

  return {
    raw,
    parsed: raw,
    report: {
      keyId,
      kind: spec.kind,
      status: 'present',
      reason: 'ok',
      byteLength: byteLength(raw),
      itemCount: null,
      targetStore: spec.targetStore,
    },
  };
}

function dynamicId(spec: LegacyKeySpec, key: string): string {
  return spec.keyPrefix ? key.slice(spec.keyPrefix.length) : key;
}

/** Report line for an allowlist entry with no stored key. */
function absentReport(spec: LegacyKeySpec, keyId: string): LegacyKeyReport {
  return {
    keyId,
    kind: spec.kind,
    status: 'absent',
    reason: 'key-absent',
    byteLength: 0,
    itemCount: null,
    targetStore: spec.targetStore,
  };
}

function collectAttachments(
  subjects: readonly LegacySubjectPayload[],
): LegacyAttachmentInventory[] {
  const inventory: LegacyAttachmentInventory[] = [];
  for (const subject of subjects) {
    if (!isRecord(subject.parsed) || !isRecord(subject.parsed.rooms)) continue;
    for (const [roomId, room] of Object.entries(subject.parsed.rooms as Record<string, unknown>)) {
      if (!isRecord(room) || !Array.isArray(room.attachments)) continue;
      for (const raw of room.attachments as unknown[]) {
        if (!isRecord(raw)) continue;
        const attachment = raw as Partial<RoomAttachment>;
        const attachmentId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
        if (attachmentId.length === 0) continue;
        const sourceType: 'local' | 'external' =
          attachment.sourceType === 'external' ? 'external' : 'local';
        // The legacy web build posted local images to `/api/upload` and kept
        // only a relative path, so its bytes are not recoverable here. A
        // historical external URL is external by definition. Neither is ever
        // fetched: plan section 2.3 forbids silent downloads.
        const externalOnly = sourceType === 'external';
        inventory.push({
          attachmentId,
          subjectId: subject.subjectId,
          roomId,
          sourceType,
          externalOnly,
          reason: externalOnly ? 'historical-external-url' : 'bytes-not-recoverable',
        });
      }
    }
  }
  return inventory;
}

function readSchemaVersionOf(parsed: unknown): string | null {
  if (!isRecord(parsed) || !isRecord(parsed.dungeon)) return null;
  const version = parsed.dungeon.schemaVersion;
  return typeof version === 'string' ? version : null;
}

function detectProgressionVersion(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const version = parsed.version;
    if (version === 3 || version === 2) return String(version);
    if (isRecord(parsed.bySubject)) return String(version ?? 1);
    return '1';
  } catch {
    return null;
  }
}

/**
 * Read the current app state.
 *
 * Purely a read: the function opens nothing, writes nothing, and removes
 * nothing. Pass a stub `storage` to read from a snapshot instead of the live
 * `localStorage`.
 */
export function readLegacyAppState(options: ReadLegacyAppStateOptions = {}): LegacyAppState {
  const storage = resolveStorage(options.storage);
  const reports: LegacyKeyReport[] = [];
  const values = new Map<string, unknown>();
  // Keyed by allowlist `keyId`, except for a dynamic family, whose entry is a
  // `Record<dynamicId, raw>`.
  const raws = new Map<string, unknown>();

  if (storage) {
    const matches = resolveAllowlistedKeys(storage);
    const presentKeys = new Set(matches.map((match) => match.key));
    // Every allowlist entry gets a report line, including the ones that are not
    // in storage: "absent" is a migration-relevant answer, not a gap.
    for (const spec of LEGACY_STORAGE_KEY_ALLOWLIST) {
      if (spec.key !== undefined) {
        if (!presentKeys.has(spec.key)) reports.push(absentReport(spec, spec.keyId));
        continue;
      }
      const prefix = spec.keyPrefix ?? '';
      const hasFamilyMember = matches.some(
        (match) => match.spec === spec && match.key.startsWith(prefix),
      );
      if (!hasFamilyMember) reports.push(absentReport(spec, spec.keyId));
    }

    for (const { key, spec } of matches) {
      const keyId = spec.key === undefined ? `${spec.keyId}:${dynamicId(spec, key)}` : spec.keyId;
      const read = readKey(storage, key, spec, keyId);
      reports.push(read.report);
      if (spec.key !== undefined) {
        // Fixed key: the allowlist id is the storage key's own entry.
        values.set(spec.keyId, read.parsed);
        raws.set(spec.keyId, read.raw);
        continue;
      }
      if (spec.key === undefined) {
        // Dynamic family: keep every member, keyed by the caller-supplied id.
        const family = (values.get(`${spec.keyId}#family`) ?? {}) as Record<string, unknown>;
        family[dynamicId(spec, key)] = read.parsed;
        values.set(`${spec.keyId}#family`, family);
        const familyRaw = (raws.get(`${spec.keyId}#family`) ?? {}) as Record<string, string | null>;
        familyRaw[dynamicId(spec, key)] = read.raw;
        raws.set(`${spec.keyId}#family`, familyRaw);
      }
    }
  } else {
    for (const spec of LEGACY_STORAGE_KEY_ALLOWLIST) {
      reports.push(absentReport(spec, spec.keyId));
    }
  }

  const subjectIndex = values.get('subject-index');
  const subjectFamily = parsedFamily(values, 'subject');
  const subjectFamilyRaw = rawFamily(raws, 'subject');

  const indexIds = Array.isArray(subjectIndex)
    ? subjectIndex.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const declaredSubjectId = rawString(raws, 'active-subject');

  const orderedIds: string[] = [];
  for (const id of indexIds) if (!orderedIds.includes(id)) orderedIds.push(id);
  for (const id of Object.keys(subjectFamily).sort()) if (!orderedIds.includes(id)) orderedIds.push(id);

  const subjects: LegacySubjectPayload[] = orderedIds.map((subjectId) => {
    const raw = subjectFamilyRaw[subjectId] ?? null;
    const parsed = subjectFamily[subjectId] ?? null;
    return { subjectId, raw: raw ?? '', parsed, schemaVersion: readSchemaVersionOf(parsed) };
  });

  const subjectSchemaVersions: Record<string, number> = {};
  for (const subject of subjects) {
    if (subject.schemaVersion === null) continue;
    subjectSchemaVersions[subject.schemaVersion] =
      (subjectSchemaVersions[subject.schemaVersion] ?? 0) + 1;
  }

  const recovery: LegacyRecoveryPayload[] = [];
  let recoveryBytes = 0;
  for (const spec of ['recovery-backup', 'recovery-corrupt'] as const) {
    const family = rawFamily(raws, spec);
    for (const subjectId of Object.keys(family).sort()) {
      const raw = family[subjectId];
      if (typeof raw !== 'string') continue;
      recovery.push({ kind: spec === 'recovery-backup' ? 'backup' : 'corrupt', subjectId, raw });
      recoveryBytes += byteLength(raw);
    }
  }

  const spriteOverrides = rawFamily(raws, 'custom-sprite-override');
  const spriteAnims = rawFamily(raws, 'custom-sprite-anim');
  const spriteOriginals = rawFamily(raws, 'custom-sprite-original');
  const spritePaths = [
    ...new Set([
      ...Object.keys(spriteOverrides),
      ...Object.keys(spriteAnims),
      ...Object.keys(spriteOriginals),
    ]),
  ].sort();
  const customSprites: LegacyCustomSpritePayload[] = spritePaths.map((spritePath) => ({
    spritePath,
    override: spriteOverrides[spritePath] ?? null,
    anim: spriteAnims[spritePath] ?? null,
    original: spriteOriginals[spritePath] ?? null,
  }));

  const attachments = collectAttachments(subjects);
  const progressionRaw = rawString(raws, 'progression');
  const progressionVersion = detectProgressionVersion(progressionRaw);

  const allowlistKeys = new Set(LEGACY_STORAGE_KEY_ALLOWLIST.flatMap((spec) => [spec.key ?? '']));
  const allowlistPrefixes = LEGACY_STORAGE_KEY_ALLOWLIST.map((spec) => spec.keyPrefix).filter(
    (prefix): prefix is string => typeof prefix === 'string',
  );
  const storageKeys = storage ? listStorageKeys(storage) : [];
  const keysOutsideAllowlist = storageKeys.filter((key) => {
    if (allowlistKeys.has(key)) return false;
    return !allowlistPrefixes.some((prefix) => key.startsWith(prefix));
  }).length;

  const present = reports.filter((entry) => entry.status === 'present').length;
  const absent = reports.filter((entry) => entry.status === 'absent').length;
  const parseErrors = reports.filter((entry) => entry.status === 'parse-error').length;
  const unsupportedShapes = reports.filter((entry) => entry.status === 'unsupported-shape').length;

  const uiMarkers: Record<string, string | null> = {};
  for (const spec of LEGACY_STORAGE_KEY_ALLOWLIST) {
    if (spec.kind !== 'ui-marker') continue;
    uiMarkers[spec.keyId] = rawString(raws, spec.keyId);
  }

  return {
    activeSubjectId: declaredSubjectId !== null && declaredSubjectId.length > 0 ? declaredSubjectId : null,
    subjectIds: orderedIds,
    subjects,
    progressionRaw,
    sessionsRaw: rawString(raws, 'sessions'),
    declaredSessionRaw: rawString(raws, 'session-declared'),
    questStep: rawString(raws, 'quest-step'),
    villageSpawn: rawString(raws, 'village-spawn'),
    uiMarkers,
    preferencesRaw: rawString(raws, 'preferences'),
    shortcutsRaw: rawString(raws, 'shortcuts'),
    locale: rawString(raws, 'locale'),
    customSprites,
    spritePacksRaw: rawString(raws, 'custom-sprite-packs'),
    recovery,
    attachments,
    report: {
      keys: reports,
      totals: {
        allowlistedKeys: LEGACY_STORAGE_KEY_ALLOWLIST.length,
        present,
        absent,
        parseErrors,
        unsupportedShapes,
      },
      subjectSchemaVersions,
      progressionVersions: progressionVersion === null ? {} : { [progressionVersion]: 1 },
      recovery: { count: recovery.length, byteLength: recoveryBytes },
      attachments: {
        total: attachments.length,
        externalOnly: attachments.filter((entry) => entry.externalOnly).length,
      },
      keysOutsideAllowlist,
    },
  };
}

/** True when the app state has nothing worth migrating. */
export function isEmptyLegacyAppState(state: LegacyAppState): boolean {
  return (
    state.subjects.length === 0 &&
    state.progressionRaw === null &&
    state.sessionsRaw === null &&
    state.declaredSessionRaw === null &&
    state.preferencesRaw === null &&
    state.shortcutsRaw === null &&
    state.locale === null &&
    state.customSprites.length === 0 &&
    state.recovery.length === 0
  );
}
