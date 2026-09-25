/**
 * Legacy key allowlist, read-only guarantees, subject migration policy, and
 * external-only attachment reporting.
 *
 * Exit criteria covered here: "Legacy keys remain byte-for-byte untouched" and
 * the subject `1.0.0` -> `1.1.0` migration contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importSubjectFromJson } from '@/services/persistence/subjectPersistence';
import {
  migrateSubjectSnapshot,
  needsSubjectSchemaMigration,
} from '@/core/validation/persistence/subjectMigration';
import {
  LEGACY_KEY_EXCLUSIONS,
  LEGACY_STORAGE_KEY_ALLOWLIST,
  isEmptyLegacyAppState,
  readLegacyAppState,
  resolveAllowlistedKeys,
  type LegacyAppState,
} from '@/services/persistence/v2/legacyReader';
import { buildMigratedRecords } from '@/services/persistence/v2/migrations';
import { FIXED_NOW, readSubjectFixture, resetStorageV2Environment, snapshotLocalStorage, toReadOnlyStorage } from './support/storageV2TestSupport';

const MIGRATION_SUBJECT_ID = 'subject-phase0-v100-migration';
const EXTERNAL_SUBJECT_ID = 'subject-phase0-v110-full';

/**
 * A clearly synthetic subject whose only attachment is an external URL.
 *
 * Uses the reserved `example.invalid` host, so nothing in this suite can reach a
 * real network even if a future change tried to fetch it.
 */
function seedSyntheticExternalAttachment(): void {
  const subjectId = 'subject-synthetic-external';
  const roomId = 'room-synthetic-external-root';
  const snapshot = {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: subjectId,
      subjectName: 'Synthetic External Attachment Subject',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: roomId,
      rooms: [{ roomId, topic: 'Synthetic Root Topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: {
      [roomId]: {
        roomId,
        topic: 'Synthetic Root Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        state: 'Created',
        notePath: `rooms/${roomId}/notes.md`,
        artifactPath: `rooms/${roomId}/artifact.md`,
        noteText: '',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 0,
            clarityReadability: 0,
          },
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [
          {
            attachmentId: 'att-synthetic-external-1',
            sourceType: 'external',
            fileName: 'synthetic-external.png',
            mimeType: 'image/png',
            externalUrl: 'https://example.invalid/synthetic-external-image.png',
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    },
  };
  const storage = window.localStorage;
  storage.setItem(`knowledge-dungeon:v1:subject:${subjectId}`, JSON.stringify(snapshot));
  const index = JSON.parse(storage.getItem('knowledge-dungeon:v1:subjects') as string) as string[];
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([...index, subjectId]));
}

/**
 * A clearly synthetic subject whose room carries one external attachment.
 *
 * The `attachmentId` is caller-supplied so a test can deliberately reuse it
 * across two subjects. The URL host is the reserved `example.invalid`, so
 * nothing here can reach a real network.
 */
function seedSyntheticSubjectWithAttachment(
  subjectId: string,
  roomId: string,
  attachmentId: string,
  attachmentCount = 1,
): void {
  const snapshot = {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: subjectId,
      subjectName: 'Synthetic Attachment Subject',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: roomId,
      rooms: [{ roomId, topic: 'Synthetic Root Topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: {
      [roomId]: {
        roomId,
        topic: 'Synthetic Root Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        state: 'Created',
        notePath: `rooms/${roomId}/notes.md`,
        artifactPath: `rooms/${roomId}/artifact.md`,
        noteText: '',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 0,
            clarityReadability: 0,
          },
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: Array.from({ length: attachmentCount }, (_, index) => ({
          attachmentId,
          sourceType: 'external',
          fileName: `synthetic-external-${index}.png`,
          mimeType: 'image/png',
          externalUrl: 'https://example.invalid/synthetic-external-image.png',
          addedAt: '2026-01-01T00:00:00.000Z',
        })),
      },
    },
  };
  const storage = window.localStorage;
  storage.setItem(`knowledge-dungeon:v1:subject:${subjectId}`, JSON.stringify(snapshot));
  const index = JSON.parse(storage.getItem('knowledge-dungeon:v1:subjects') as string) as string[];
  if (!index.includes(subjectId)) {
    storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([...index, subjectId]));
  }
}

function seedLegacyStorage(): void {
  const storage = window.localStorage;
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([MIGRATION_SUBJECT_ID, EXTERNAL_SUBJECT_ID]));
  storage.setItem('knowledge-dungeon:v1:activeSubjectId', MIGRATION_SUBJECT_ID);
  storage.setItem(
    `knowledge-dungeon:v1:subject:${MIGRATION_SUBJECT_ID}`,
    readSubjectFixture('subject-1.0.0-migration-defaults.json'),
  );
  storage.setItem(
    `knowledge-dungeon:v1:subject:${EXTERNAL_SUBJECT_ID}`,
    readSubjectFixture('subject-1.1.0-full-unknown-fields.json'),
  );
  storage.setItem('knowledge-dungeon:backup:' + MIGRATION_SUBJECT_ID, '{"dungeon":broken');
  storage.setItem('knowledge-dungeon:corrupt:' + MIGRATION_SUBJECT_ID, '{"dungeon":');
  storage.setItem('kd-quest-step', 'synthetic-quest-step');
  storage.setItem('kd-village-spawn', '{"gridX":2,"gridY":3}');
  storage.setItem('knowledge-dungeon:ui:fishing-hint:v1', '1');
  storage.setItem('knowledge-dungeon:ui:tooltips:v1', '["synthetic-tooltip"]');
  storage.setItem('knowledge-dungeon:session:preferences', '{"colorTheme":"dark"}');
  storage.setItem(
    'knowledge-dungeon:session:shortcuts',
    JSON.stringify([{ label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false }]),
  );
  storage.setItem('knowledge-dungeon:locale', 'en');
  storage.setItem('knowledge-dungeon:custom-sprites:override:village/tree.svg', '<svg id="synthetic"/>');
  storage.setItem('knowledge-dungeon:custom-sprites:anim:village/tree.svg', '{"frameRate":4}');
  storage.setItem('knowledge-dungeon:custom-sprites:packs', '{"packs":[],"activePack":null}');
  // A key the application does not own. Reading it must not happen.
  storage.setItem('knowledge-dungeon:subjects:index', JSON.stringify(['should-not-be-read']));
  storage.setItem('kd-subject-index', JSON.stringify(['should-not-be-read']));
  storage.setItem('kd-subject:synthetic', '{"dungeon":{}}');
  storage.setItem('unrelated-third-party-key', 'leave-me-alone');
}

describe('legacy key allowlist', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(() => {
    resetStorageV2Environment();
  });

  it('enumerates exactly the app-owned key families from the Phase 0 baseline', () => {
    const keyIds = LEGACY_STORAGE_KEY_ALLOWLIST.map((spec) => spec.keyId);

    expect(keyIds).toEqual([
      'subject-index',
      'subject',
      'active-subject',
      'progression',
      'session-declared',
      'sessions',
      'recovery-backup',
      'recovery-corrupt',
      'quest-step',
      'village-spawn',
      'ui-touch-hint',
      'ui-fishing-hint',
      'ui-onboarding-gameplay-loop',
      'ui-export-reminder',
      'ui-tooltips',
      'preferences',
      'shortcuts',
      'locale',
      'custom-sprite-override',
      'custom-sprite-anim',
      'custom-sprite-original',
      'custom-sprite-packs',
    ]);
  });

  it('documents the excluded keys and why each is excluded', () => {
    const excludedKeys = LEGACY_KEY_EXCLUSIONS.map((entry) => entry.key);

    expect(excludedKeys).toContain('knowledge-dungeon:subjects:index');
    expect(excludedKeys).toContain('kd-subject-index');
    expect(excludedKeys).toContain('kd-subject:<subjectId>');
    for (const entry of LEGACY_KEY_EXCLUSIONS) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('reads only allowlisted keys and never a key the app does not own', () => {
    seedLegacyStorage();
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });

    expect(state.subjectIds).toEqual([MIGRATION_SUBJECT_ID, EXTERNAL_SUBJECT_ID]);
    expect(state.report.keys.some((entry) => entry.keyId.includes('subjects:index'))).toBe(false);
    expect(state.report.keysOutsideAllowlist).toBe(4);
    for (const key of state.report.keys) {
      expect(key.keyId).not.toContain('should-not-be-read');
    }
  });

  it('never resolves a key outside the allowlist', () => {
    seedLegacyStorage();
    const resolvedKeys = resolveAllowlistedKeys(toReadOnlyStorage(snapshotLocalStorage())).map(
      (entry) => entry.key,
    );

    expect(resolvedKeys).not.toContain('knowledge-dungeon:subjects:index');
    expect(resolvedKeys).not.toContain('kd-subject-index');
    expect(resolvedKeys).not.toContain('unrelated-third-party-key');
  });

  it('reports present, absent, and parse-error per key with sanitized reasons only', () => {
    window.localStorage.setItem('knowledge-dungeon:v1:progression', '{not json');
    seedLegacyStorage();
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });

    const progression = state.report.keys.find((entry) => entry.keyId === 'progression');
    expect(progression).toMatchObject({ status: 'parse-error', reason: 'json-parse-failed' });
    expect(progression?.byteLength).toBeGreaterThan(0);

    const sessions = state.report.keys.find((entry) => entry.keyId === 'sessions');
    expect(sessions).toMatchObject({ status: 'absent', reason: 'key-absent', byteLength: 0 });

    const index = state.report.keys.find((entry) => entry.keyId === 'subject-index');
    expect(index).toMatchObject({ status: 'present', reason: 'ok', itemCount: 2 });

    // A report never carries the value it describes.
    const serialized = JSON.stringify(state.report);
    expect(serialized).not.toContain('Synthetic Phase 0');
    expect(serialized).not.toContain('synthetic-tooltip');
    expect(serialized).not.toContain('"dungeon"');
  });

  it('reads recovery records as raw strings preserved verbatim', () => {
    seedLegacyStorage();
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });

    const backup = state.recovery.find((entry) => entry.kind === 'backup');
    const corrupt = state.recovery.find((entry) => entry.kind === 'corrupt');
    expect(backup?.raw).toBe('{"dungeon":broken');
    expect(corrupt?.raw).toBe('{"dungeon":');
    expect(state.report.recovery.count).toBe(2);
  });

  it('preserves custom sprite content verbatim, including unparseable anim data', () => {
    seedLegacyStorage();
    window.localStorage.setItem('knowledge-dungeon:custom-sprites:anim:village/tree.svg', 'not json');
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });

    const sprite = state.customSprites.find((entry) => entry.spritePath === 'village/tree.svg');
    expect(sprite?.override).toBe('<svg id="synthetic"/>');
    expect(sprite?.anim).toBe('not json');
    expect(state.spritePacksRaw).toBe('{"packs":[],"activePack":null}');
  });

  it('reports an empty state for an empty storage', () => {
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });

    expect(isEmptyLegacyAppState(state)).toBe(true);
    expect(state.report.totals.present).toBe(0);
  });

  it('recognizes a subject with no declared index entry', () => {
    window.localStorage.setItem(
      'knowledge-dungeon:v1:subject:subject-not-in-index',
      readSubjectFixture('subject-1.1.0-minimal.json'),
    );
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });

    expect(state.subjectIds).toContain('subject-not-in-index');
    expect(isEmptyLegacyAppState(state)).toBe(false);
  });
});

describe('subject 1.0.0 to 1.1.0 migration', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(() => {
    resetStorageV2Environment();
  });

  it('is idempotent: running it on its own output is a no-op', () => {
    const parsed = JSON.parse(readSubjectFixture('subject-1.0.0-migration-defaults.json')) as unknown;

    const first = migrateSubjectSnapshot(parsed, {
      nowIso: FIXED_NOW,
      unknownTopLevelFields: 'preserve',
    });
    const second = migrateSubjectSnapshot(first.snapshot, {
      nowIso: FIXED_NOW,
      unknownTopLevelFields: 'preserve',
    });
    const third = migrateSubjectSnapshot(second.snapshot, {
      nowIso: FIXED_NOW,
      unknownTopLevelFields: 'preserve',
    });

    expect(second.snapshot).toEqual(first.snapshot);
    expect(third.snapshot).toEqual(first.snapshot);
    expect(JSON.stringify(second.snapshot)).toBe(JSON.stringify(first.snapshot));
    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
    expect(second.appliedRoomDefaults).toBe(0);
  });

  it('is deterministic for a given clock and policy', () => {
    const parsed = JSON.parse(readSubjectFixture('subject-1.0.0-migration-defaults.json')) as unknown;
    const options = { nowIso: FIXED_NOW, unknownTopLevelFields: 'preserve' as const };

    expect(JSON.stringify(migrateSubjectSnapshot(parsed, options).snapshot)).toBe(
      JSON.stringify(migrateSubjectSnapshot(parsed, options).snapshot),
    );
  });

  it('preserves unknown top-level, dungeon, and room fields in the storage-v2 path', () => {
    const parsed = JSON.parse(readSubjectFixture('subject-1.0.0-migration-defaults.json')) as Record<string, unknown>;
    const migrated = migrateSubjectSnapshot(parsed, {
      nowIso: FIXED_NOW,
      unknownTopLevelFields: 'preserve',
    }).snapshot as unknown as Record<string, unknown>;

    expect(migrated).toHaveProperty('legacyEnvelope');
    expect(migrated).toHaveProperty('fixtureFormat');
    expect(migrated).toHaveProperty('fixtureVersion');
    expect((migrated.dungeon as Record<string, unknown>).fixtureDungeonField).toBe(
      'preserve-this-synthetic-dungeon-field',
    );
    expect(
      (migrated.rooms as Record<string, Record<string, unknown>>)['room-phase0-v100-migration-root']
        .fixtureRoomField,
    ).toBe('preserve-this-synthetic-room-field');
  });

  it('still drops the top-level envelope on the legacy import path', () => {
    const imported = importSubjectFromJson(readSubjectFixture('subject-1.0.0-migration-defaults.json')) as unknown as Record<
      string,
      unknown
    >;

    expect(imported).not.toHaveProperty('legacyEnvelope');
    expect(imported).toHaveProperty('dungeon');
    expect(imported).toHaveProperty('rooms');
  });

  it('uses the injected clock for the default next-review date', () => {
    const parsed = JSON.parse(readSubjectFixture('subject-1.0.0-minimal.json')) as unknown;
    const migrated = migrateSubjectSnapshot(parsed, { nowIso: FIXED_NOW }).snapshot;

    expect(migrated.dungeon.schemaVersion).toBe('1.1.0');
    expect(migrated.rooms['room-phase0-v100-minimal-root'].sm2NextReviewDate).toBe(FIXED_NOW);
  });

  it('leaves an already-current snapshot untouched', () => {
    const raw = readSubjectFixture('subject-1.1.0-minimal.json');
    const parsed = JSON.parse(raw) as unknown;
    const migrated = migrateSubjectSnapshot(parsed, { nowIso: FIXED_NOW, unknownTopLevelFields: 'drop' });

    expect(migrated.migrated).toBe(false);
    expect(migrated.snapshot).toEqual(parsed);
    expect(migrated.appliedRoomDefaults).toBe(0);
    expect(needsSubjectSchemaMigration(parsed)).toBe(false);
    expect(needsSubjectSchemaMigration(JSON.parse(readSubjectFixture('subject-1.0.0-minimal.json')))).toBe(true);
  });
});

describe('attachment external-only reporting', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(() => {
    resetStorageV2Environment();
  });

  function migrate(state: LegacyAppState) {
    return buildMigratedRecords(state, { now: FIXED_NOW, generationId: 'gen-test' });
  }

  it('marks every historical attachment external-only and never invents bytes', () => {
    seedLegacyStorage();
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });
    const built = migrate(state);

    expect(built.records.attachmentMetadata?.length ?? 0).toBeGreaterThan(0);
    for (const record of built.records.attachmentMetadata ?? []) {
      expect(record.availability).toBe('external-only');
      // No bytes are recoverable from the legacy web build, so there is no
      // content hash to report and none is invented.
      expect(record.contentHash).toBeNull();
    }
    for (const report of built.externalOnly) {
      expect(report.contentHash).toBeNull();
      expect(report.byteLength).toBeNull();
      expect(['historical-external-url', 'bytes-not-recoverable']).toContain(report.reason);
    }
  });

  it('reports opaque ids and hashes only: no filename, no URL, no subject name', () => {
    seedLegacyStorage();
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });
    const built = migrate(state);
    const serialized = JSON.stringify(built.externalOnly);

    expect(serialized).not.toContain('fileName');
    expect(serialized).not.toContain('externalUrl');
    expect(serialized).not.toContain('altText');
    expect(serialized).not.toContain('Synthetic Phase 0');
    expect(serialized).not.toContain('example.invalid');
    for (const report of built.externalOnly) {
      expect(Object.keys(report).sort()).toEqual([
        'attachmentId',
        'byteLength',
        'contentHash',
        'reason',
        'roomId',
        'sourceType',
        'subjectId',
      ]);
    }
  });

  it('scopes attachment dedupe to a subject so one subject cannot drop another\'s', () => {
    seedLegacyStorage();
    // Two different subjects that both reuse the same attachment id. An
    // attachment id is only unique within one subject's graph, so both records
    // must survive.
    seedSyntheticSubjectWithAttachment('subject-synthetic-dup-a', 'room-synthetic-dup-a', 'att-shared-id');
    seedSyntheticSubjectWithAttachment('subject-synthetic-dup-b', 'room-synthetic-dup-b', 'att-shared-id');

    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });
    const built = migrate(state);

    const shared = (built.records.attachmentMetadata ?? []).filter(
      (record) => record.attachmentId === 'att-shared-id',
    );
    expect(shared.map((record) => record.subjectId).sort()).toEqual([
      'subject-synthetic-dup-a',
      'subject-synthetic-dup-b',
    ]);
    expect(built.problems.some((problem) => problem.scope === 'attachment')).toBe(false);

    const reported = built.externalOnly
      .filter((report) => report.attachmentId === 'att-shared-id')
      .map((report) => report.subjectId)
      .sort();
    expect(reported).toEqual(['subject-synthetic-dup-a', 'subject-synthetic-dup-b']);
  });

  it('still dedupes a repeated attachment id inside one subject', () => {
    seedLegacyStorage();
    seedSyntheticSubjectWithAttachment('subject-synthetic-dup-internal', 'room-synthetic-dup-internal', 'att-repeated-id', 2);

    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });
    const built = migrate(state);

    expect(
      (built.records.attachmentMetadata ?? []).filter((record) => record.attachmentId === 'att-repeated-id'),
    ).toHaveLength(1);
    expect(
      built.problems.filter((problem) => problem.code === 'duplicate-identifier' && problem.scope === 'attachment'),
    ).toHaveLength(1);
  });

  it('does not fetch anything: a legacy external URL is never requested', () => {    seedLegacyStorage();
    seedSyntheticExternalAttachment();
    const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error('migration must not fetch');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const built = migrate(state);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(built.externalOnly.some((entry) => entry.reason === 'historical-external-url')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
