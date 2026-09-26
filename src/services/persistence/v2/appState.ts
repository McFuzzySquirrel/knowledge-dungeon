/**
 * One app-shaped view of persisted state, whichever repository holds it.
 *
 * The bootstrap hydrates five stores - subject, progression, preferences,
 * shortcuts, sessions - and it must hydrate them the *same way* in both
 * repository modes, otherwise "the default `legacy` repository produces the exact
 * same in-memory state" would be a claim nothing enforces. So this module
 * defines the single shape both readers produce:
 *
 * - {@link readAppStateFromLegacy} is the literal current behaviour: the same
 *   keys, the same parsing, the same defaults, read synchronously from
 *   `localStorage`. It is the reference the storage-v2 reader is measured
 *   against.
 * - {@link readAppStateFromStorageV2} reconstructs the same shape from the
 *   active generation.
 *
 * Neither reader writes, and neither reads a clock or a random source, so both
 * are pure functions of what is already on the device.
 *
 * Renderer-neutral: it imports the repository, the schema, and the canonical
 * progression normalizer, and nothing else. It deliberately does not import a
 * store: the stores consume this shape, not the other way round.
 */

import type { SubjectSnapshot } from '@/core/validation/persistence';
import { CANONICAL_PROGRESSION_VERSION } from '@/core/progression/canonicalProgression';
import type { StorageV2Repository } from './repository';
import type {
  PreferenceRecordValue,
  ProgressionRecordValue,
  SessionRecordValue,
  ShortcutRecordValue,
  SubjectRecordValue,
} from './schema';

// ── The shared shape ──────────────────────────────────────────────────────

/** The persisted preferences payload, exactly as the legacy key stores it. */
export interface PersistedPreferencesValue {
  graphicsMode?: string;
  colorTheme?: string;
  activeSpritePack?: string | null;
}

/** A persisted keyboard shortcut binding, as the legacy key stores it. */
export interface PersistedShortcutBinding {
  label: string;
  labelKey: string;
  defaultKey: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** A persisted study session, as the legacy key stores it. */
export interface PersistedSessionRecord {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  subjectId: string;
  subjectName: string;
  roomsVisited: string[];
  notesSubmitted: number;
  reviewsCompleted: number;
  xpEarned: number;
}

export interface AppPersistedState {
  /** Parsed subject snapshots, in the order their records are stored. */
  readonly subjects: readonly { readonly id: string; readonly snapshot: SubjectSnapshot }[];
  /** The v3 progression envelope, or `null` when nothing is stored. */
  readonly progression: unknown | null;
  readonly preferences: PersistedPreferencesValue | null;
  readonly shortcuts: readonly PersistedShortcutBinding[] | null;
  readonly sessions: readonly PersistedSessionRecord[] | null;
  /**
   * The active-subject pointer.
   *
   * It stays a legacy key in **both** repository modes: it is app-owned session
   * state rather than generation data, it has to be readable synchronously while
   * the stores hydrate, and a rollback build reads it from the same key.
   */
  readonly activeSubjectId: string | null;
}

/**
 * The deterministic generation ids a device receives.
 *
 * They live here rather than in `appRepository.ts` because this module's imports
 * are all type-only, so naming a generation costs the default build nothing: the
 * storage-v2 implementation itself is loaded lazily and only when the flag says
 * to.
 *
 * They are named for what they are, so a generation id in a report or an evidence
 * record says which of the two happened without reading the descriptor.
 */
export const INITIAL_GENERATION_ID = 'gen-initial-0001';
export const MIGRATION_GENERATION_ID = 'gen-migration-0001';

/** An empty device: what a browser profile with no data hydrates to. */
export const EMPTY_APP_PERSISTED_STATE: AppPersistedState = Object.freeze({
  subjects: [],
  progression: null,
  preferences: null,
  shortcuts: null,
  sessions: null,
  activeSubjectId: null,
});

// ── Legacy reader: the reference behaviour ────────────────────────────────

const LEGACY_KEYS = {
  subjectIndex: 'knowledge-dungeon:v1:subjects',
  subjectPrefix: 'knowledge-dungeon:v1:subject:',
  activeSubjectId: 'knowledge-dungeon:v1:activeSubjectId',
  progression: 'knowledge-dungeon:v1:progression',
  preferences: 'knowledge-dungeon:session:preferences',
  shortcuts: 'knowledge-dungeon:session:shortcuts',
  sessions: 'knowledge-dungeon:v1:sessions',
} as const;

function legacyGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function legacyParse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The subject ids this build can open, in the order the index declares.
 *
 * The index is the application's subject list, and it is the only authority that
 * keeps both repositories honest: `listSubjectIds`, the welcome screen, and
 * `deleteSubject` all read the index, so a payload the index does not name is not
 * a subject on this device. A rollback build must keep behaving exactly as it
 * does today, so the migration is the side that has to change - it now carries a
 * payload the index does not name as a preserved recovery record instead of a
 * `subjects` record, which is what keeps the flagged build's subject set equal
 * to this build's.
 *
 * The result is sorted by id, because the storage-v2 reader's order is the
 * generation's record-id order and the two must hydrate the same state.
 */
function legacySubjectIds(): string[] {
  const parsed = legacyParse(legacyGet(LEGACY_KEYS.subjectIndex));
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort(
    (left, right) => (left < right ? -1 : 1),
  );
}

/**
 * Read the app's persisted state the way the pre-cutover build did.
 *
 * Every read is wrapped so a quota-blocked or corrupt `localStorage` yields the
 * same empty state the current module-load hydration yields, rather than
 * throwing halfway through the bootstrap.
 */
export function readAppStateFromLegacy(): AppPersistedState {
  const subjects: { id: string; snapshot: SubjectSnapshot }[] = [];
  for (const id of legacySubjectIds()) {
    const parsed = legacyParse(legacyGet(`${LEGACY_KEYS.subjectPrefix}${id}`));
    // A payload that is not an object is exactly the case the current
    // `loadSubjectSnapshot` returns `null` for, so it is skipped here too and
    // reported by the store's own read when the learner opens that subject.
    if (!isRecord(parsed)) continue;
    subjects.push({ id, snapshot: parsed as unknown as SubjectSnapshot });
  }

  const preferences = legacyParse(legacyGet(LEGACY_KEYS.preferences));
  const shortcuts = legacyParse(legacyGet(LEGACY_KEYS.shortcuts));
  const sessions = legacyParse(legacyGet(LEGACY_KEYS.sessions));

  return {
    subjects,
    progression: legacyParse(legacyGet(LEGACY_KEYS.progression)),
    preferences: isRecord(preferences) ? (preferences as PersistedPreferencesValue) : null,
    shortcuts: Array.isArray(shortcuts)
      ? (shortcuts as PersistedShortcutBinding[])
      : null,
    sessions: Array.isArray(sessions) ? (sessions as PersistedSessionRecord[]) : null,
    activeSubjectId: legacyGet(LEGACY_KEYS.activeSubjectId),
  };
}

// ── Storage-v2 reader ─────────────────────────────────────────────────────

/**
 * Stage and activate the first generation, for a device with no data to migrate.
 *
 * Deterministic id and injected clock, so a fresh device produces one generation
 * with a stable identity. Idempotent: if a generation is already active this is a
 * no-op.
 */
export async function ensureInitialGeneration(
  repository: StorageV2Repository,
  options: { generationId: string; now: string },
): Promise<string> {
  const active = await repository.readActiveGenerationId();
  if (active !== null) return active;
  const existing = await repository.readGeneration(options.generationId);
  if (existing === null) {
    await repository.stageGeneration({
      generationId: options.generationId,
      source: 'initial',
      records: {},
    });
  }
  await repository.activateGeneration(options.generationId);
  return options.generationId;
}

/** Subject snapshots from the active generation, in record-id order. */
function subjectsFrom(records: readonly SubjectRecordValue[]): AppPersistedState['subjects'] {
  return [...records]
    .sort((left, right) => (left.subjectId < right.subjectId ? -1 : 1))
    .map((record) => ({ id: record.subjectId, snapshot: record.snapshot }));
}

/**
 * Reassemble the v3 progression envelope from the canonical per-subject records.
 *
 * Storage-v2 stores one record per subject, each carrying that subject's
 * progression and the cross-subject achievement list. The store's hydration path
 * takes a single envelope, so this rebuilds one; a store that already speaks the
 * canonical form would read the records directly instead.
 *
 * The `version` marker is **load-bearing, not decoration**.
 * `normalizeProgressionRecord` decides between "a map of per-subject records" and
 * "one flat record for the active subject" by reading `envelope.version`, and it
 * keeps `crossSubjectAchievements` only for version 3. An envelope without the
 * marker is therefore read as a v1 flat payload: one empty record for the active
 * subject, the real per-subject map buried in `extraFields` where no reader looks,
 * and every achievement dropped. That is silent, learner-visible loss on every
 * flagged-build reload - and the next ordinary write mirrors the loss into the
 * legacy key too, so a rollback build cannot recover it either.
 *
 * The version therefore comes from the shared canonical constant rather than a
 * literal, so there is one number to change when the envelope shape changes, and
 * `tests/migrations/repositoryRouting.test.ts` pins both the marker and the round
 * trip being a fixed point.
 */
export function progressionEnvelopeFrom(
  records: readonly ProgressionRecordValue[],
): {
  version: number;
  bySubject: Record<string, unknown>;
  crossSubjectAchievements: string[];
} {
  const bySubject: Record<string, unknown> = {};
  const achievements = new Set<string>();
  for (const record of [...records].sort((left, right) => (left.subjectId < right.subjectId ? -1 : 1))) {
    for (const [subjectId, value] of Object.entries(record.bySubject)) {
      bySubject[subjectId] = value;
    }
    for (const achievement of record.crossSubjectAchievements) achievements.add(achievement);
  }
  return {
    version: CANONICAL_PROGRESSION_VERSION,
    bySubject,
    crossSubjectAchievements: [...achievements].sort(),
  };
}

/** The preferences payload from the `graphics` preference record. */
function preferencesFrom(records: readonly PreferenceRecordValue[]): PersistedPreferencesValue | null {
  const graphics = records.find((record) => record.preferenceId === 'graphics');
  if (graphics === undefined) return null;
  // An unparsable legacy payload is preserved as `{ rawText }`; it is not a
  // preferences object and must hydrate to the defaults.
  if (!isRecord(graphics.value) || 'rawText' in graphics.value) return null;
  return graphics.value as PersistedPreferencesValue;
}

/** Known binding labels, so a hydrated binding keeps its human-readable label. */
const KNOWN_SHORTCUT_LABELS: Readonly<Record<string, { label: string; defaultKey: string }>> = {
  'shortcuts.toggleHelp': { label: 'Toggle Help', defaultKey: '/' },
  'shortcuts.toggleMap': { label: 'Toggle Map', defaultKey: 'm' },
  'shortcuts.toggleInfoPanel': { label: 'Toggle Info Panel', defaultKey: 'i' },
};

/**
 * Shortcut bindings from the shortcut records.
 *
 * A storage-v2 shortcut record carries the stable identity of a binding
 * (`labelKey`) and its current key. The display label is not storage data - it
 * is the i18n fallback - so it is resolved from the known set, which is what
 * keeps the rendered label identical to the legacy hydration.
 */
export function shortcutsFrom(records: readonly ShortcutRecordValue[]): PersistedShortcutBinding[] {
  // The order is deliberately *not* decided here. The generation stores shortcuts
  // as an unordered set of records, so any order this function invented would be a
  // second, disagreeing source of truth; the store applies the one canonical order
  // both repositories share (`canonicalShortcutBindings`).
  return [...records]
    .map((record) => {
      const known = KNOWN_SHORTCUT_LABELS[record.labelKey];
      return {
        label: known?.label ?? record.labelKey,
        labelKey: record.labelKey,
        defaultKey: known?.defaultKey ?? record.key,
        key: record.key,
        ctrlKey: record.ctrlKey,
        shiftKey: record.shiftKey,
      };
    });
}

/**
 * Session records from the session store, with the subject name resolved from
 * the subject records.
 *
 * The session record itself stores no subject name - it is derived data, and
 * duplicating it would be a second copy to keep in step. The name is looked up
 * from the same generation's subject records, so the rendered statistics are
 * identical to the legacy hydration's.
 */
export function sessionsFrom(
  records: readonly SessionRecordValue[],
  subjects: readonly SubjectRecordValue[],
): PersistedSessionRecord[] {
  const names = new Map(subjects.map((record) => [record.subjectId, record.snapshot.dungeon.subjectName]));
  return [...records]
    .sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1))
    .map((record) => ({
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      subjectId: record.subjectId,
      // A subject that has no record - the migration could not carry it, or the
      // learner deleted it - falls back to the name the session stored, so the
      // two repositories hydrate the same name the legacy key holds.
      subjectName: names.get(record.subjectId) ?? record.subjectName ?? '',
      roomsVisited: [...record.roomsVisited],
      notesSubmitted: record.notesSubmitted,
      reviewsCompleted: record.reviewsCompleted,
      xpEarned: record.xpEarned,
    }));
}

/**
 * Read the app's persisted state from the active storage-v2 generation.
 *
 * A device with no active generation - never migrated, never written - reads as
 * the same empty state a new browser profile produces, so a first run in the
 * flagged build hydrates exactly like a first run in the default build.
 */
export async function readAppStateFromStorageV2(
  repository: StorageV2Repository,
  options: { activeSubjectId: string | null },
): Promise<AppPersistedState> {
  const active = await repository.readActiveGenerationId();
  if (active === null) {
    return { ...EMPTY_APP_PERSISTED_STATE, activeSubjectId: options.activeSubjectId };
  }
  const records = (await repository.readRecords(active)).records;
  const subjectRecords = records.subjects.map((envelope) => envelope.value as SubjectRecordValue);
  return {
    subjects: subjectsFrom(subjectRecords),
    progression: progressionEnvelopeFrom(
      records.progression.map((envelope) => envelope.value as ProgressionRecordValue),
    ),
    preferences: preferencesFrom(
      records.preferences.map((envelope) => envelope.value as PreferenceRecordValue),
    ),
    shortcuts: records.shortcuts.length > 0
      ? shortcutsFrom(records.shortcuts.map((envelope) => envelope.value as ShortcutRecordValue))
      : null,
    sessions: records.sessions.length > 0
      ? sessionsFrom(
        records.sessions.map((envelope) => envelope.value as SessionRecordValue),
        subjectRecords,
      )
      : null,
    activeSubjectId: options.activeSubjectId,
  };
}
