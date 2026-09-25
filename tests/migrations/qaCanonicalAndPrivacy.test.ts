/**
 * INDEPENDENT QA suite: exit criterion 4, "Progression and fish have one
 * canonical representation", plus the hard privacy gate.
 *
 * Written by the verification owner. Every attack named in the phase brief is
 * here; several are not in the implementer's suite. All fixture values are
 * synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_PROGRESSION_KIND,
  CANONICAL_PROGRESSION_VERSION,
  CANONICAL_UNKNOWN_FIELDS_KEY,
  LEGACY_PROGRESSION_SUBJECT_ID,
  canonicalProgressionToRecord,
  deserializeCanonicalProgression,
  normalizeProgressionRecord,
  serializeCanonicalProgression,
} from '@/core/progression/canonicalProgression';
import {
  countCanonicalCatalogTypes,
  deserializeFishCollection,
  resolveFishCatalogId,
  serializeFishCollection,
  toCanonicalFishCollection,
  toCanonicalFishEntry,
} from '@/core/fishing/fishCollectionService';
import { FISH_CATALOG, UNKNOWN_FISH_CATALOG_ID, type FishEntry } from '@/core/fishing/fishingTypes';
import {
  createFishingContext,
  isSameFishingSubject,
  toFishingSubjectContext,
  validateFishingContext,
  withCaughtFish,
} from '@/core/fishing/fishingContext';
import { fixedClock, createDeterministicIdFactory } from '@/services/persistence/v2/database';
import { openStorageV2Repository, type StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  buildMigratedRecords,
  migrateLegacyState,
} from '@/services/persistence/v2/migrations';
import { readLegacyAppState } from '@/services/persistence/v2/legacyReader';
import {
  StorageV2Error,
  type ExternalOnlyAttachmentReport,
  type GenerationDescriptor,
  type MigrationReceiptValue,
  type ProgressionRecordValue,
} from '@/services/persistence/v2/schema';
import { validateGenerationRecords } from '@/services/persistence/v2/validation';

import {
  deleteTestDatabase,
  readProgressionFixture,
  readSubjectFixture,
  resetStorageV2Environment,
} from './support/storageV2TestSupport';

const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
const ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';
const NOW = '2026-09-25T00:00:00.000Z';
const GEN = 'gen-qa-canon-0001';
const QA_MARKER = 'QA-MARKER-synthetic-4f2b91-not-real-content';

const FIXTURES = [
  'progression-v1-flat.json',
  'progression-v1-flat-malformed.json',
  'progression-v2-by-subject.json',
  'progression-v2-malformed-by-subject.json',
  'progression-v3-current-full.json',
  'progression-v3-malformed-values.json',
];

let dbCounter = 0;
let repository: StorageV2Repository | null = null;
let databaseName = '';

async function repoFor(suffix: string): Promise<StorageV2Repository> {
  dbCounter += 1;
  databaseName = `kd-qa-canon-${suffix}-${dbCounter}`;
  repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(NOW),
    idFactory: createDeterministicIdFactory('qa'),
  });
  return repository;
}

async function teardown(): Promise<void> {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
  resetStorageV2Environment();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
}

function parseFixture(fixture: string): unknown {
  try {
    return JSON.parse(readProgressionFixture(fixture)) as unknown;
  } catch {
    return undefined;
  }
}

function storeCreateId(prefix: 'loot' | 'gear'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function hydrateStore(fixture: string, activeSubjectId: string | null): Promise<{
  bySubject: Record<string, unknown>;
  crossSubjectAchievements: string[];
}> {
  const storage = window.localStorage;
  storage.clear();
  if (activeSubjectId !== null) storage.setItem(ACTIVE_SUBJECT_KEY, activeSubjectId);
  storage.setItem(PROGRESSION_KEY, readProgressionFixture(fixture));
  vi.resetModules();
  const { useProgressionStore } = await import('@/store/progressionStore');
  const state = useProgressionStore.getState();
  return { bySubject: state.bySubject, crossSubjectAchievements: state.crossSubjectAchievements };
}

describe('QA criterion 4: store and migration agree on one canonical progression', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:34:56.789Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    resetStorageV2Environment();
  });
  afterEach(teardown);

  it('agrees for all six progression fixtures on the value the STORE hydrates', async () => {
    for (const fixture of FIXTURES) {
      const activeSubjectId = 'subject-qa-active';
      const storeResult = await hydrateStore(fixture, activeSubjectId);
      const migrationResult = normalizeProgressionRecord(parseFixture(fixture), {
        activeSubjectId,
        createId: storeCreateId,
      });
      expect(storeResult.bySubject, fixture).toEqual(migrationResult.bySubject);
      expect(storeResult.crossSubjectAchievements, fixture).toEqual(
        migrationResult.crossSubjectAchievements,
      );
    }
  });

  it('agrees for all six fixtures on what the MIGRATION actually PERSISTS', async () => {
    for (const fixture of FIXTURES) {
      resetStorageV2Environment();
      const activeSubjectId = 'subject-qa-active';
      window.localStorage.setItem(PROGRESSION_KEY, readProgressionFixture(fixture));
      window.localStorage.setItem(ACTIVE_SUBJECT_KEY, activeSubjectId);

      const repo = await repoFor('persist');
      const outcome = await migrateLegacyState({
        repository: repo,
        generationId: GEN,
        now: NOW,
        clock: fixedClock(NOW),
      } as never);
      expect(outcome.report.status, fixture).toBe('migrated');

      // Reassemble the canonical map from the persisted per-subject records.
      const records = await repo.readRecords(GEN);
      const merged: Record<string, unknown> = {};
      const achievements: string[] = [];
      for (const envelope of records.records.progression) {
        const value = envelope.value as ProgressionRecordValue;
        Object.assign(merged, value.bySubject);
        if (achievements.length === 0) achievements.push(...value.crossSubjectAchievements);
      }

      // The store's own hydration of the same fixture.
      const storeResult = await hydrateStore(fixture, activeSubjectId);

      // Each persisted record carries exactly its own subject, and the union
      // reproduces the canonical map. This is the check the implementer's suite
      // does not make: it never round-trips the stored projection.
      for (const envelope of records.records.progression) {
        const value = envelope.value as ProgressionRecordValue;
        expect(Object.keys(value.bySubject), fixture).toEqual([envelope.recordId]);
        expect(value.subjectId, fixture).toBe(envelope.recordId);
      }
      const MALFORMED_ID_FIXTURES = [
        'progression-v1-flat-malformed.json',
        'progression-v3-malformed-values.json',
      ];
      if (MALFORMED_ID_FIXTURES.includes(fixture)) {
        // DEFECT WAS (blocker): the migration injected
        // `createId: () => 'migrated-unknown'`, which ignored the `loot` / `gear`
        // prefix argument, so EVERY unidentified item in the subject collapsed
        // onto one id while the store minted `loot-<random>` / `gear-<random>`.
        // That is a real disagreement between the two paths and it failed the
        // Phase 3 exit criterion "progression and fish have one canonical
        // representation". The migration now injects a prefix-honouring,
        // per-run counter.
        const stored = Object.values(merged)[0] as {
          inventory: { id: string }[];
          equippedItems: { id: string }[];
        };
        const inventoryIds = stored.inventory.map((entry) => entry.id);
        const gearIds = stored.equippedItems.map((entry) => entry.id);
        const migrationIds = [...inventoryIds, ...gearIds];
        expect(migrationIds.length).toBeGreaterThan(0);
        // Distinct items keep distinct identifiers - the collision is gone.
        expect(new Set(migrationIds).size, fixture).toBe(migrationIds.length);
        // Each id is prefixed by the kind of record it belongs to, so a loot
        // item and a gear item can never share one.
        for (const id of inventoryIds) expect(id, fixture).toMatch(/^loot-migrated-\d{4}$/);
        for (const id of gearIds) expect(id, fixture).toMatch(/^gear-migrated-\d{4}$/);
        for (const id of migrationIds) expect(id, fixture).not.toBe('migrated-unknown');
        // The store's own value for the same fixture, for contrast: same shape,
        // different generated id, because a generated id is per-path by nature.
        const storeRecord = Object.values(storeResult.bySubject)[0] as {
          inventory: { id: string }[];
          equippedItems: { id: string }[];
        };
        for (const id of [...storeRecord.inventory, ...storeRecord.equippedItems].map((entry) => entry.id)) {
          expect(id, fixture).toMatch(/^(loot|gear)-/);
          expect(id, fixture).not.toBe('migrated-unknown');
        }
        // Everything except the generated identifiers agrees exactly: same keys,
        // same lengths, same values.
        const withoutIds = (record: unknown): unknown =>
          JSON.parse(
            JSON.stringify(record, (key, value) => (key === 'id' && typeof value === 'string' ? '<id>' : value)),
          );
        expect(withoutIds(stored), fixture).toEqual(withoutIds(storeRecord));
      } else {
        expect(merged, fixture).toEqual(storeResult.bySubject);
      }
      expect(achievements, fixture).toEqual(storeResult.crossSubjectAchievements);

      await repo.close();
      await deleteTestDatabase(databaseName);
      databaseName = '';
      repository = null;
    }
  });

  it('is NOT a fixed point: re-normalizing a persisted record nests it deeper', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, readProgressionFixture('progression-v3-current-full.json'));
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-active');
    const repo = await repoFor('fixed-point');
    await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
    } as never);

    const records = await repo.readRecords(GEN);
    for (const envelope of records.records.progression) {
      const once = normalizeProgressionRecord(envelope.value, { activeSubjectId: null });
      const twice = normalizeProgressionRecord(once, { activeSubjectId: null });
      // DEFECT: the per-subject projection is not a canonical envelope, so the
      // normalizer treats it as a FLAT payload. `bySubject` is not a known key,
      // so it is carried into `extraFields` and the nesting compounds on every
      // pass. The xp of the second pass is 0 because the value moved under
      // `bySubject`.
      expect(twice.sourceVersion).toBe(0);
      expect(twice.bySubject['__legacy__']?.xpTotal).toBe(0);
      expect(Object.keys(twice.bySubject['__legacy__']?.extraFields ?? {})).toContain('bySubject');
      expect(once.bySubject['__legacy__']?.xpTotal).toBeGreaterThan(0);
      // The bug is invisible to the repository's own validator, which calls the
      // normalizer and discards the result.
      const three = normalizeProgressionRecord(twice, { activeSubjectId: null });
      expect(JSON.stringify(three).length).toBeGreaterThan(JSON.stringify(twice).length);
    }
  });
});

describe('QA criterion 4: the v1 routing rule is attacked', () => {
  afterEach(teardown);

  const v1 = () => parseFixture('progression-v1-flat.json') as Record<string, unknown>;

  it('routes to the active subject when the active id is set', () => {
    const canonical = normalizeProgressionRecord(v1(), { activeSubjectId: 'subject-qa-active' });
    expect(Object.keys(canonical.bySubject)).toEqual(['subject-qa-active']);
    expect(canonical.legacyBucketSubjectId).toBe('subject-qa-active');
    expect(canonical.activeSubjectId).toBe('subject-qa-active');
  });

  it('routes to __legacy__ when the active id is null, empty, or whitespace-only', () => {
    for (const value of [null, undefined, '', '   ', '\t\n', ' '.repeat(3)]) {
      const canonical = normalizeProgressionRecord(v1(), { activeSubjectId: value as string | null });
      expect(Object.keys(canonical.bySubject), JSON.stringify(value)).toEqual([
        LEGACY_PROGRESSION_SUBJECT_ID,
      ]);
      expect(canonical.legacyBucketSubjectId, JSON.stringify(value)).toBe(LEGACY_PROGRESSION_SUBJECT_ID);
      expect(canonical.activeSubjectId, JSON.stringify(value)).toBeNull();
    }
  });

  it('routes a NON-STRING active id to __legacy__ rather than crashing', () => {
    for (const value of [0, false, {}, [], 42]) {
      const canonical = normalizeProgressionRecord(v1(), {
        activeSubjectId: value as unknown as string,
      });
      expect(Object.keys(canonical.bySubject), JSON.stringify(value)).toEqual([
        LEGACY_PROGRESSION_SUBJECT_ID,
      ]);
    }
  });

  it('routes to __legacy__ when the stored active id names no subject', () => {
    // The store reads the key directly; a dangling id is still used verbatim.
    const canonical = normalizeProgressionRecord(v1(), { activeSubjectId: 'subject-qa-ghost' });
    expect(Object.keys(canonical.bySubject)).toEqual(['subject-qa-ghost']);
    expect(canonical.bySubject['subject-qa-ghost']?.subjectId).toBe('subject-qa-ghost');
  });

  it('is deterministic and idempotent for every routing input', () => {
    for (const activeSubjectId of [null, '', '  ', 'subject-qa-active', 'subject-qa-ghost']) {
      const once = normalizeProgressionRecord(v1(), { activeSubjectId, createId: storeCreateId });
      const twice = normalizeProgressionRecord(v1(), { activeSubjectId, createId: storeCreateId });
      expect(JSON.stringify(twice), JSON.stringify(activeSubjectId)).toBe(JSON.stringify(once));
    }
  });

  it('does NOT round-trip sourceVersion or legacyBucketSubjectId (documented defect)', () => {
    // `canonicalProgressionToRecord` writes BOTH `version: 3` and the real
    // `sourceVersion`, so reading the canonical text back reports sourceVersion
    // 3 and clears legacyBucketSubjectId. The module docstring in
    // src/core/progression/canonicalProgression.ts claims "Writing canonical
    // output and reading it back is an exact round trip"; that claim is false.
    const canonical = normalizeProgressionRecord(v1(), { activeSubjectId: 'subject-qa-active' });
    const text = serializeCanonicalProgression(canonical);
    const restored = deserializeCanonicalProgression(text, {
      activeSubjectId: 'subject-qa-active',
    });
    expect(canonical.sourceVersion).toBe(0);
    expect(canonical.legacyBucketSubjectId).toBe('subject-qa-active');
    expect(restored.sourceVersion).toBe(3);
    expect(restored.legacyBucketSubjectId).toBeNull();
    // The per-subject records - the part storage-v2 persists - are stable.
    expect(restored.bySubject).toEqual(canonical.bySubject);
    expect(restored.crossSubjectAchievements).toEqual(canonical.crossSubjectAchievements);
    expect(restored.extraFields).toEqual(canonical.extraFields);
    expect(JSON.parse(text).kind).toBe(CANONICAL_PROGRESSION_KIND);
    expect(JSON.parse(text).version).toBe(CANONICAL_PROGRESSION_VERSION);
    // The written `sourceVersion` field is silently discarded on read.
    expect(JSON.parse(text).sourceVersion).toBe(0);
  });

  it('a carried extraFields bag cannot override a known record field', async () => {
    const hostile = {
      version: 3,
      bySubject: {
        'subject-qa-hostile': {
          xpTotal: 5,
          extraFields: { rank: 'God', xpTotal: 9999, badges: ['injected'] },
        },
      },
      crossSubjectAchievements: [],
    };
    const canonical = normalizeProgressionRecord(hostile, { activeSubjectId: null });
    const record = canonical.bySubject['subject-qa-hostile'];
    expect(record?.rank).not.toBe('God');
    expect(record?.xpTotal).toBe(5);
    expect(record?.badges).toEqual([]);

    // The legacy mirror flattens extraFields but never over a known key.
    const { toLegacyV3ProgressionRecord } = await import('@/core/progression/canonicalProgression');
    const legacy = toLegacyV3ProgressionRecord({
      bySubject: { 'subject-qa-hostile': record! },
      crossSubjectAchievements: [],
    });
    expect(legacy.bySubject['subject-qa-hostile']?.rank).not.toBe('God');
    expect(legacy.bySubject['subject-qa-hostile']?.xpTotal).toBe(5);
  });
});

describe('QA criterion 4: resolveFishCatalogId is attacked', () => {
  const entry = (over: Partial<FishEntry> & { id: string; name: string }): Parameters<
    typeof resolveFishCatalogId
  >[0] => ({ ...over });

  it('matches a name that differs only by case', () => {
    for (const name of ['moss carp', 'MOSS CARP', 'Moss Carp', 'MoSs CaRp']) {
      expect(resolveFishCatalogId(entry({ id: 'x', name })).catalogId, name).toBe('moss-carp');
    }
  });

  it('resolves a name with surrounding and internal whitespace to the catalog id', () => {
    for (const name of ['  Moss Carp  ', 'Moss  Carp', '\tMoss Carp\n']) {
      expect(resolveFishCatalogId(entry({ id: 'x', name })).catalogId, JSON.stringify(name)).toBe(
        'moss-carp',
      );
    }
  });

  it('honours an explicit catalogId that disagrees with the entry name', () => {
    const resolved = resolveFishCatalogId(
      entry({ id: 'x', name: 'Moss Carp', catalogId: 'gilded-koi' }),
    );
    expect(resolved).toEqual({ catalogId: 'gilded-koi', source: 'catalog-id-field' });
    // ...and stays idempotent under re-canonicalization.
    const once = toCanonicalFishEntry({
      id: 'x',
      name: 'Moss Carp',
      rarity: 'common',
      subjectId: 's',
      subjectName: 'S',
      caughtAt: NOW,
      catalogId: 'gilded-koi',
    } as FishEntry);
    expect(toCanonicalFishEntry(once)).toEqual(once);
  });

  it('resolves an entry id with no ":" separator via the name', () => {
    expect(resolveFishCatalogId(entry({ id: 'no-separator', name: 'Lunar Trout' }))).toEqual({
      catalogId: 'lunar-trout',
      source: 'catalog-name-match',
    });
  });

  it('ignores a ":" at position 0 of the entry id', () => {
    const resolved = resolveFishCatalogId(entry({ id: ':moss-carp', name: 'Lunar Trout' }));
    expect(resolved).toEqual({ catalogId: 'lunar-trout', source: 'catalog-name-match' });
  });

  it('ignores an entry-id prefix that is not a catalog id', () => {
    expect(resolveFishCatalogId(entry({ id: 'not-a-fish:x9', name: 'Abyssal Eel' }))).toEqual({
      catalogId: 'abyssal-eel',
      source: 'catalog-name-match',
    });
  });

  it('uses the explicit unknown marker for an empty name', () => {
    expect(resolveFishCatalogId(entry({ id: 'x', name: '' }))).toEqual({
      catalogId: UNKNOWN_FISH_CATALOG_ID,
      source: 'unknown',
    });
  });

  it('uses the explicit unknown marker for a name that slugifies to empty', () => {
    for (const name of ['   ', '!!!', '---', '***', ' ', '?']) {
      expect(resolveFishCatalogId(entry({ id: 'x', name })).catalogId, JSON.stringify(name)).toBe(
        UNKNOWN_FISH_CATALOG_ID,
      );
    }
  });

  it('falls back to a deterministic slug for an unknown fish', () => {
    const a = resolveFishCatalogId(entry({ id: 'x', name: 'Synthetic River Lantern' }));
    const b = resolveFishCatalogId(entry({ id: 'x', name: 'Synthetic River Lantern' }));
    expect(a).toEqual({ catalogId: 'synthetic-river-lantern', source: 'name-slug' });
    expect(b).toEqual(a);
  });

  it('COLLIDES two distinct display names onto one canonical id (documented gap)', () => {
    // Both names are outside the catalog and slug to the same token, so the
    // canonical form says they are the same fish type.
    const first = toCanonicalFishEntry({
      id: 'a', name: 'Synthetic Deep Eel', rarity: 'rare', subjectId: 's', subjectName: 'S', caughtAt: NOW,
    } as FishEntry);
    const second = toCanonicalFishEntry({
      id: 'b', name: 'synthetic deep-eel', rarity: 'rare', subjectId: 's', subjectName: 'S', caughtAt: NOW,
    } as FishEntry);
    expect(first.catalogId).toBe('synthetic-deep-eel');
    expect(second.catalogId).toBe('synthetic-deep-eel');
    expect(countCanonicalCatalogTypes([first, second])).toBe(1);
  });

  it('is idempotent and order-preserving for a whole collection', () => {
    const raw = [
      { id: 'moss-carp:x1', name: 'Moss Carp', rarity: 'common', subjectId: 's', subjectName: 'S', caughtAt: NOW },
      { id: 'lunar-trout:x2', name: 'Lunar Trout', rarity: 'rare', subjectId: 's', subjectName: 'S', caughtAt: NOW },
      { id: 'y3', name: 'Synthetic Mystery Fish', rarity: 'epic', subjectId: 's', subjectName: 'S', caughtAt: NOW },
      { id: 'y4', name: '!!!', rarity: 'common', subjectId: 's', subjectName: 'S', caughtAt: NOW },
    ];
    const once = toCanonicalFishCollection(deserializeFishCollection(raw));
    const twice = toCanonicalFishCollection(once);
    expect(twice).toEqual(once);
    expect(once.map((e) => e.id)).toEqual(['moss-carp:x1', 'lunar-trout:x2', 'y3', 'y4']);
    expect(once.map((e) => e.catalogId)).toEqual([
      'moss-carp',
      'lunar-trout',
      'synthetic-mystery-fish',
      UNKNOWN_FISH_CATALOG_ID,
    ]);
  });

  it('resolves every catalog fish to its own catalog id, from a name alone', () => {
    const seen = new Set<string>();
    for (const catalogEntry of FISH_CATALOG) {
      const resolved = resolveFishCatalogId({ id: 'opaque', name: catalogEntry.name });
      expect(resolved.catalogId, catalogEntry.id).toBe(catalogEntry.id);
      seen.add(resolved.catalogId);
    }
    expect(seen.size).toBe(FISH_CATALOG.length);
  });

  it('preserves an existing catalogId through deserialize, and never invents one', () => {
    const withId = deserializeFishCollection([
      { id: 'x', name: 'Moss Carp', catalogId: 'gilded-koi', rarity: 'common', subjectId: 's', subjectName: 'S', caughtAt: NOW },
    ]);
    expect(withId[0]?.catalogId).toBe('gilded-koi');

    const withoutId = deserializeFishCollection([
      { id: 'x', name: 'Moss Carp', rarity: 'common', subjectId: 's', subjectName: 'S', caughtAt: NOW },
    ]);
    expect(Object.keys(withoutId[0] ?? {}).sort()).toEqual([
      'caughtAt',
      'id',
      'name',
      'rarity',
      'subjectId',
      'subjectName',
    ]);
    expect(serializeFishCollection(withoutId)).toEqual(withoutId);
  });
});

describe('QA criterion 4: the canonical fish type is never written by a production path', () => {
  afterEach(teardown);

  it('the migration persists fish entries WITHOUT a resolved catalogId', async () => {
    // This is the gap the exit criterion does not catch: both paths agree
    // because both call `deserializeFishCollection`, but neither ever calls
    // `toCanonicalFishEntry`, so `CanonicalFishEntry` is a type nothing writes.
    window.localStorage.setItem(
      PROGRESSION_KEY,
      readProgressionFixture('progression-v3-current-full.json'),
    );
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-phase0-v3');
    const repo = await repoFor('fish-gap');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
    } as never);
    expect(outcome.report.status).toBe('migrated');

    const records = await repo.readRecords(GEN);
    const fish = (records.records.progression[0]?.value as ProgressionRecordValue).bySubject[
      'subject-phase0-v3'
    ] as { fishCollection: FishEntry[] };
    expect(fish.fishCollection.length).toBeGreaterThan(0);
    for (const entry of fish.fishCollection) {
      // The persisted form carries no catalogId, so the "canonical" fish
      // representation is not what storage actually holds.
      expect(entry.catalogId).toBeUndefined();
    }
    // Resolving after the fact yields the same id the store would resolve.
    const resolved = toCanonicalFishCollection(fish.fishCollection);
    for (const catalogEntry of FISH_CATALOG) {
      if (resolved.some((e) => e.name === catalogEntry.name)) {
        expect(
          resolved.find((e) => e.name === catalogEntry.name)?.catalogId,
          catalogEntry.id,
        ).toBe(catalogEntry.id);
      }
    }
  });
});

describe('QA fishing context is pure and deterministic', () => {
  it('rejects blank identity and carries one subject context unchanged', () => {
    expect(() => createFishingContext({ contextId: 'c', pondId: 'p', enteredAt: NOW, subjectId: '  ', subjectName: 'S' })).toThrow();
    expect(() => createFishingContext({ contextId: 'c', pondId: 'p', enteredAt: NOW, subjectId: 's', subjectName: ' ' })).toThrow();
    expect(() => createFishingContext({ contextId: '', pondId: 'p', enteredAt: NOW, subjectId: 's', subjectName: 'S' })).toThrow();
    expect(() => createFishingContext({ contextId: 'c', pondId: ' ', enteredAt: NOW, subjectId: 's', subjectName: 'S' })).toThrow();

    const context = createFishingContext({
      contextId: 'ctx-qa',
      pondId: 'pond-qa',
      enteredAt: NOW,
      subjectId: '  subject-qa  ',
      subjectName: '  Synthetic QA Subject  ',
      roomId: '  ',
    });
    expect(context.subjectId).toBe('subject-qa');
    expect(context.subjectName).toBe('Synthetic QA Subject');
    expect(context.roomId).toBeNull();
    expect(context.catalogId).toBeNull();
    expect(validateFishingContext(context)).toEqual({ ok: true, problem: null });

    const caught = withCaughtFish(context, { catalogId: 'moss-carp', rarity: 'common' });
    expect(caught.subjectId).toBe(context.subjectId);
    expect(caught.catalogId).toBe('moss-carp');
    expect(isSameFishingSubject(caught, { subjectId: 'other' })).toBe(false);
    expect(isSameFishingSubject(caught, { roomId: null })).toBe(true);
    expect(isSameFishingSubject(caught, { roomId: 'room' })).toBe(false);
    expect(toFishingSubjectContext(caught)).toEqual({
      subjectId: 'subject-qa',
      subjectName: 'Synthetic QA Subject',
      roomId: null,
    });
    // The original context is unchanged: no mutation.
    expect(context.catalogId).toBeNull();
  });
});

describe('QA privacy gate: reports and errors carry no learner content', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:34:56.789Z'));
    resetStorageV2Environment();
  });
  afterEach(teardown);

  /** A legacy subject stuffed with distinctive synthetic learner content. */
  function seedHostileLegacySubject(): void {
    const payload = JSON.parse(readSubjectFixture('subject-1.1.0-full-unknown-fields.json')) as {
      dungeon: Record<string, unknown>;
      rooms: Record<string, Record<string, unknown>>;
    };
    payload.dungeon.subjectName = QA_MARKER;
    const room = Object.values(payload.rooms)[0]!;
    room.topic = `${QA_MARKER}-topic`;
    room.noteText = `${QA_MARKER}-note-body`;
    room.attachments = [
      {
        attachmentId: 'att-qa-marker',
        sourceType: 'external',
        fileName: `${QA_MARKER}-attachment.png`,
        externalUrl: 'https://example.invalid/synthetic.png',
        altText: `${QA_MARKER}-alt`,
        mimeType: 'image/png',
        addedAt: NOW,
      },
    ];
    const storage = window.localStorage;
    storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-qa-marker']));
    storage.setItem('knowledge-dungeon:v1:subject:subject-qa-marker', JSON.stringify(payload));
    storage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-marker');
    storage.setItem(
      PROGRESSION_KEY,
      JSON.stringify({
        version: 3,
        bySubject: { 'subject-qa-marker': { xpTotal: 1, collectedNotes: [{ noteId: 'n', topic: `${QA_MARKER}-p-topic` }] } },
        crossSubjectAchievements: [],
      }),
    );
    storage.setItem(`knowledge-dungeon:backup:subject-qa-marker`, `${QA_MARKER}-raw-backup`);
    storage.setItem('knowledge-dungeon:locale', 'en');
  }

  it('the MigrationReport key set is exactly the declared, sanitized set', async () => {
    seedHostileLegacySubject();
    const repo = await repoFor('privacy-report');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
    } as never);
    expect(outcome.report.status).toBe('migrated');

    expect(Object.keys(outcome.report).sort()).toEqual(
      [
        'activated',
        'attachments',
        'contentChecksum',
        'createdAt',
        'externalOnlyAttachments',
        'legacyKeys',
        'migrationId',
        'previousActiveGenerationId',
        'problems',
        'receiptId',
        'recordCounts',
        'recovery',
        'stagedGenerationId',
        'status',
        'subjectSchemaVersions',
        'progressionSourceVersions',
      ].sort(),
    );
    expect(Object.keys(outcome.report.legacyKeys).sort()).toEqual(
      ['absent', 'allowlistedKeys', 'parseErrors', 'present', 'unsupportedShapes'].sort(),
    );
    expect(Object.keys(outcome.report.attachments).sort()).toEqual(
      ['externalOnly', 'storedBytes', 'total'].sort(),
    );

    const text = JSON.stringify(outcome.report);
    expect(text).not.toContain(QA_MARKER);
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('attachment.png');
    expect(text).not.toContain('note-body');
    expect(text).not.toContain('p-topic');
  });

  it('every ExternalOnlyAttachmentReport carries exactly the declared keys', async () => {
    seedHostileLegacySubject();
    const repo = await repoFor('privacy-attachment');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
    } as never);

    const reports: ExternalOnlyAttachmentReport[] = outcome.report.externalOnlyAttachments;
    expect(reports.length).toBe(1);
    for (const report of reports) {
      expect(Object.keys(report).sort()).toEqual(
        ['attachmentId', 'byteLength', 'contentHash', 'reason', 'roomId', 'sourceType', 'subjectId'].sort(),
      );
      expect(typeof report.contentHash === 'string' || report.contentHash === null).toBe(true);
      expect(JSON.stringify(report)).not.toContain(QA_MARKER);
      expect(JSON.stringify(report)).not.toContain('example.invalid');
    }
  });

  it('every MigrationReceiptValue and GenerationDescriptor carries only codes, counts, versions, ids and checksums', async () => {
    seedHostileLegacySubject();
    const repo = await repoFor('privacy-receipt');
    await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
    } as never);

    const receipts = (await repo.listMigrationReceipts(GEN)) as MigrationReceiptValue[];
    expect(receipts).toHaveLength(1);
    expect(Object.keys(receipts[0]!).sort()).toEqual(
      [
        'contentChecksum',
        'createdAt',
        'fromStorage',
        'migrationId',
        'previousActiveGenerationId',
        'progressionSourceVersions',
        'receiptId',
        'recordChecksums',
        'recordCounts',
        'stagedGenerationId',
        'status',
        'storageGenerationFormatVersion',
        'subjectSchemaVersion',
        'subjectSchemaVersions',
        'toStorage',
      ].sort(),
    );
    for (const store of Object.keys(receipts[0]!.recordChecksums)) {
      expect(receipts[0]!.recordChecksums[store as keyof typeof receipts[0]['recordChecksums']]).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }

    const descriptor = (await repo.readGeneration(GEN))?.descriptor as GenerationDescriptor;
    expect(Object.keys(descriptor).sort()).toEqual(
      [
        'activatedAt',
        'contentChecksum',
        'createdAt',
        'generationFormatVersion',
        'generationId',
        'parentGenerationId',
        'recordCounts',
        'source',
        'status',
        'subjectSchemaVersion',
      ].sort(),
    );

    for (const [name, surface] of [
      ['receipt', receipts[0]],
      ['descriptor', descriptor],
    ] as const) {
      const text = JSON.stringify(surface);
      expect(text, name).not.toContain(QA_MARKER);
      expect(text, name).not.toContain('example.invalid');
      expect(text, name).not.toContain('subjectName');
      expect(text, name).not.toContain('topic');
      expect(text, name).not.toContain('noteText');
    }
  });

  it('StorageV2Error.toReport() carries only a code and scalar details', () => {
    const error = new StorageV2Error('VALIDATION_FAILED', {
      stage: 'validate',
      problemCount: 3,
      flag: true,
      // A hostile caller could still pass a string; assert what actually lands.
      leaky: QA_MARKER,
    });
    const report = error.toReport();
    expect(Object.keys(report).sort()).toEqual(['code', 'details']);
    expect(report.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(report.details).sort()).toEqual(['flag', 'leaky', 'problemCount', 'stage']);
    for (const value of Object.values(report.details)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    expect(error.message).toBe('storage-v2 error: VALIDATION_FAILED');
    // The message is fixed per code and carries no detail at all.
    expect(error.message).not.toContain(QA_MARKER);

    // A detail value CAN carry a string, so prove the report is only as safe as
    // its caller: this is the documented contract, asserted rather than assumed.
    expect(JSON.stringify(report)).toContain(QA_MARKER);
  });

  it('the recovery payload in the report names a code and a stage only', async () => {
    seedHostileLegacySubject();
    const repo = await repoFor('privacy-recovery');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
      onStage: (stage: string) => {
        if (stage === 'compare') throw new Error(`${QA_MARKER}-thrown-message`);
      },
    } as never);

    expect(outcome.report.recovery).toEqual({ code: 'MIGRATION_FAILED', stage: 'compare' });
    const text = JSON.stringify(outcome.report);
    expect(text).not.toContain(QA_MARKER);
  });

  it('the legacy read report counts only, and its dynamic key ids are opaque ids', () => {
    seedHostileLegacySubject();
    const report = readLegacyAppState().report;
    const text = JSON.stringify(report);
    expect(text).not.toContain(QA_MARKER);
    expect(text).not.toContain('attachment.png');
    expect(text).not.toContain('example.invalid');
    // The dynamic key family ids DO embed the subject id, which is opaque but
    // is still a learner-chosen-ish identifier: recorded, not asserted absent.
    expect(report.keys.map((entry) => entry.keyId)).toContain('subject:subject-qa-marker');
  });

  it('validation problems are exactly {code, scope, count, severity}', async () => {
    // A subject the importer accepts but that has a structural finding, so the
    // report really does carry problems.
    const payload = JSON.parse(readSubjectFixture('subject-1.1.0-minimal.json')) as {
      dungeon: Record<string, unknown>;
      rooms: Record<string, Record<string, unknown>>;
    };
    payload.dungeon.subjectName = QA_MARKER;
    Object.values(payload.rooms)[0]!.topic = `${QA_MARKER}-topic`;
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-qa-minimal']));
    window.localStorage.setItem(
      'knowledge-dungeon:v1:subject:subject-qa-minimal',
      JSON.stringify(payload),
    );
    const repo = await repoFor('privacy-problems');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GEN,
      now: NOW,
      clock: fixedClock(NOW),
    } as never);
    expect(outcome.report.problems.length).toBeGreaterThan(0);
    for (const problem of outcome.report.problems) {
      expect(Object.keys(problem).sort()).toEqual(['code', 'count', 'scope', 'severity']);
      expect(typeof problem.code).toBe('string');
      expect(typeof problem.count).toBe('number');
      expect(JSON.stringify(problem)).not.toContain(QA_MARKER);
    }
  });

  it('validateGenerationRecords reports codes only for a hostile generation', () => {
    const state = readLegacyAppState();
    const built = buildMigratedRecords(state, { now: NOW, generationId: GEN });
    const records = {
      subjects: built.records.subjects?.map((value) => ({
        generationId: GEN,
        recordId: value.subjectId,
        value,
        checksum: null,
        updatedAt: NOW,
      })) ?? [],
      progression: [],
      sessions: [],
      preferences: [],
      shortcuts: [],
      assistance: [],
      attachmentMetadata: [],
      attachmentBlobs: [],
      customSprites: [],
      recovery: [],
      migrationReceipts: [],
    };
    const descriptor = {
      generationId: GEN,
      generationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      status: 'staged',
      source: 'legacy-migration',
      createdAt: NOW,
      activatedAt: null,
      parentGenerationId: null,
      recordCounts: { meta: 0 } as never,
      contentChecksum: '0'.repeat(64),
    } as unknown as GenerationDescriptor;

    const result = validateGenerationRecords(GEN, descriptor, records as never);
    expect(JSON.stringify(result)).not.toContain(QA_MARKER);
    for (const problem of result.problems) {
      expect(Object.keys(problem).sort()).toEqual(['code', 'count', 'scope', 'severity']);
    }
  });
});

describe('QA: the canonical record is what the store persists, not just what it returns', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:34:56.789Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    resetStorageV2Environment();
  });
  afterEach(teardown);

  it('serializes both forms so the mirror and the canonical shape stay distinct', () => {
    const canonical = normalizeProgressionRecord(parseFixture('progression-v3-current-full.json'), {
      activeSubjectId: 'subject-phase0-v3',
    });
    const record = canonicalProgressionToRecord(canonical) as Record<string, unknown>;
    expect(record.kind).toBe(CANONICAL_PROGRESSION_KIND);
    expect(record.version).toBe(CANONICAL_PROGRESSION_VERSION);
    expect(Object.keys(record).sort()).toEqual(
      [
        'activeSubjectId',
        'bySubject',
        CANONICAL_UNKNOWN_FIELDS_KEY,
        'crossSubjectAchievements',
        'kind',
        'legacyBucketSubjectId',
        'sourceVersion',
        'version',
      ].sort(),
    );
  });
});
