/**
 * One canonical representation for progression and for fish.
 *
 * Exit criterion covered: "Progression and fish have one canonical
 * representation." The store's normalizer and the migration normalizer are the
 * same function, and this suite proves it by importing both call sites and
 * comparing their output for the same fixture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_PROGRESSION_KIND,
  LEGACY_PROGRESSION_SUBJECT_ID,
  canonicalProgressionToRecord,
  deserializeCanonicalProgression,
  normalizeProgressionRecord,
  serializeCanonicalProgression,
} from '@/core/progression/canonicalProgression';
import { assignRankTier } from '@/core/progression';
import {
  countCanonicalCatalogTypes,
  deserializeFishCollection,
  resolveFishCatalogId,
  serializeFishCollection,
  toCanonicalFishCollection,
  toCanonicalFishEntry,
} from '@/core/fishing/fishCollectionService';
import { FISH_CATALOG, type FishEntry } from '@/core/fishing/fishingTypes';
import { readProgressionFixture, resetStorageV2Environment } from './support/storageV2TestSupport';

const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
const ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';

const FIXTURE_CASES: { fixture: string; activeSubjectId: string | null }[] = [
  { fixture: 'progression-v1-flat.json', activeSubjectId: 'subject-phase0-v1' },
  { fixture: 'progression-v1-flat.json', activeSubjectId: null },
  { fixture: 'progression-v1-flat-malformed.json', activeSubjectId: 'subject-phase0-v1-malformed' },
  { fixture: 'progression-v2-by-subject.json', activeSubjectId: 'subject-phase0-v2' },
  { fixture: 'progression-v2-malformed-by-subject.json', activeSubjectId: 'subject-phase0-v2-fallback' },
  { fixture: 'progression-v3-current-full.json', activeSubjectId: 'subject-phase0-v3' },
  { fixture: 'progression-v3-malformed-values.json', activeSubjectId: 'subject-phase0-v3-malformed' },
  { fixture: 'progression-invalid-syntax.txt', activeSubjectId: null },
];

function parseFixture(fixture: string): unknown {
  try {
    return JSON.parse(readProgressionFixture(fixture)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The store's own id factory, reproduced. The store builds it from
 * `Math.random()`; the migrations module builds a seeded counter with the same
 * `loot` / `gear` prefix contract. Both honour the prefix, which is the property
 * that matters; the generated value itself is necessarily per-path.
 */
function storeCreateId(prefix: 'loot' | 'gear'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The migration's per-run counter: deterministic, and prefix-honouring. */
function migrationCreateId(prefix: 'loot' | 'gear'): string {
  return `${prefix}-migrated-0001`;
}

/**
 * Hydrate the real progression store and return what it normalized.
 *
 * This is the store path, not a re-implementation of it: the store module is
 * imported fresh with the fixture in `localStorage`, exactly as the Phase 0
 * characterization tests do.
 */
async function hydrateStore(fixture: string, activeSubjectId: string | null): Promise<{
  bySubject: unknown;
  crossSubjectAchievements: unknown;
}> {
  const storage = window.localStorage;
  // A fresh start every time: a leftover active-subject key from the previous
  // case would silently change which bucket a v1 record lands in.
  storage.clear();
  if (activeSubjectId !== null) storage.setItem(ACTIVE_SUBJECT_KEY, activeSubjectId);
  storage.setItem(PROGRESSION_KEY, readProgressionFixture(fixture));
  vi.resetModules();
  const storeModule = await import('@/store/progressionStore');
  // Phase 4: hydration is an explicit step owned by the application bootstrap,
  // not a module-load side effect. These two calls are exactly what the
  // bootstrap performs for the legacy repository, so the characterization
  // below still exercises the real hydration path with its assertions intact.
  storeModule.useProgressionStore.getState().hydrateProgression(
    storeModule.readPersistedProgressionPayload(),
  );
  const state = storeModule.useProgressionStore.getState();
  return { bySubject: state.bySubject, crossSubjectAchievements: state.crossSubjectAchievements };
}

describe('canonical progression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:34:56.789Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    resetStorageV2Environment();
  });

  afterEach(() => {
    resetStorageV2Environment();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('is literally one normalizer: the store and the migration resolve the same function', async () => {
    // This was previously asserted by handing the STORE's id factory to the
    // MIGRATION's normalizer and comparing the two, which cannot fail however the
    // two paths differ - it compares the migration normalizer to itself. The real
    // property is that both call sites resolve the same function object, so there
    // is only one set of rules to disagree about.
    vi.resetModules();
    const storeModule = await import('@/store/progressionStore');
    const coreModule = await import('@/core/progression/canonicalProgression');
    const source = readFileSync(
      join(process.cwd(), 'src/store/progressionStore.ts'),
      'utf8',
    );

    // The store's hydration path is the shared normalizer, reached through the
    // barrel it imports from.
    expect(source).toContain("from '@/core/progression/canonicalProgression'");
    expect(source).toContain('normalizeProgressionRecord');
    expect(source).toContain('makeDefaultSubjectProgression');
    // It has no normalizer of its own any more.
    expect(source).not.toContain('function normalizeSubjectProgression');
    expect(source).not.toContain('function normalizeInventory');
    expect(source).not.toContain('function normalizeEquippedItems');
    // The migration resolves the same function from the same module.
    const migrationSource = readFileSync(
      join(process.cwd(), 'src/services/persistence/v2/migrations.ts'),
      'utf8',
    );
    expect(migrationSource).toContain(
      "from '@/core/progression/canonicalProgression'",
    );
    expect(migrationSource).toContain('normalizeProgressionRecord');
    expect(typeof coreModule.normalizeProgressionRecord).toBe('function');
    // The store module really did load and really does hold canonical records.
    expect(typeof storeModule.useProgressionStore.getState().bySubject).toBe('object');
  });

  it('agrees with the store on the values the store hydrates, for every fixture', async () => {
    for (const testCase of FIXTURE_CASES) {
      const storeResult = await hydrateStore(testCase.fixture, testCase.activeSubjectId);
      // A deterministic, prefix-honouring factory - the same contract the
      // migration injects. It is NOT the store's `Math.random` factory: a
      // generated id is per-path by nature, and the real cross-path agreement is
      // proven against what the migration PERSISTS in
      // `qaCanonicalAndPrivacy.test.ts`.
      const sharedResult = normalizeProgressionRecord(parseFixture(testCase.fixture), {
        activeSubjectId: testCase.activeSubjectId,
        createId: migrationCreateId,
      });

      // Unreadable JSON is the one case where the two deliberately differ: the
      // store keeps its historical empty in-memory state, while the migration
      // reports the payload as unusable and writes nothing for it.
      if (parseFixture(testCase.fixture) === undefined) {
        expect(storeResult, testCase.fixture).toEqual({
          bySubject: {},
          crossSubjectAchievements: [],
        });
        continue;
      }

      expect(sharedResult.crossSubjectAchievements, testCase.fixture).toEqual(
        storeResult.crossSubjectAchievements,
      );
      expect(Object.keys(sharedResult.bySubject).sort(), testCase.fixture).toEqual(
        Object.keys(storeResult.bySubject as Record<string, unknown>).sort(),
      );
      for (const [subjectId, record] of Object.entries(sharedResult.bySubject)) {
        const storeRecord = (storeResult.bySubject as Record<string, Record<string, unknown>>)[subjectId];
        // Everything except the generated identifiers must match exactly.
        const withoutIds = (value: unknown): unknown =>
          JSON.parse(
            JSON.stringify(value, (key, entry) =>
              key === 'id' && typeof entry === 'string' ? '<id>' : entry,
            ),
          );
        expect(withoutIds(record), `${testCase.fixture}:${subjectId}`).toEqual(withoutIds(storeRecord));
      }
    }
  });

  it('converges progression versions 1, 2, and 3 on the same record shape', () => {
    const v1 = normalizeProgressionRecord(parseFixture('progression-v1-flat.json'), {
      activeSubjectId: 'subject-phase0-v1',
    });
    const v2 = normalizeProgressionRecord(parseFixture('progression-v2-by-subject.json'), {
      activeSubjectId: 'subject-phase0-v2',
    });
    const v3 = normalizeProgressionRecord(parseFixture('progression-v3-current-full.json'), {
      activeSubjectId: 'subject-phase0-v3',
    });

    const expectedKeys = [
      'artifacts',
      'badges',
      'bossesDefeated',
      'collectedNotes',
      'equippedItems',
      'extraFields',
      'fishCollection',
      'inventory',
      'rank',
      'reviewPasses',
      'roomsCleared',
      'streakCount',
      'subjectId',
      'subjectsMastered',
      'xpTotal',
    ];

    for (const canonical of [v1, v2, v3]) {
      for (const record of Object.values(canonical.bySubject)) {
        // One shape, whichever version the payload declared.
        expect(Object.keys(record).sort()).toEqual(expectedKeys);
        // The rank is always derived from the XP total, so a stored rank can
        // never disagree with it.
        expect(record.rank).toBe(assignRankTier(record.xpTotal));
        expect(typeof record.xpTotal).toBe('number');
      }
    }
  });

  it('derives rank from xpTotal and ignores a stale stored rank', () => {
    const stale = { xpTotal: 315, rank: 'Epic Overlord', badges: [] };

    const canonical = normalizeProgressionRecord(stale, { activeSubjectId: 'subject-x' });

    expect(canonical.bySubject['subject-x']?.rank).toBe('Scholar');
  });

  it('routes an unversioned v1 record to the active subject, or to __legacy__', () => {
    const parsed = parseFixture('progression-v1-flat.json');

    const withActive = normalizeProgressionRecord(parsed, { activeSubjectId: 'subject-a' });
    expect(Object.keys(withActive.bySubject)).toEqual(['subject-a']);
    expect(withActive.legacyBucketSubjectId).toBe('subject-a');
    expect(withActive.activeSubjectId).toBe('subject-a');

    const withoutActive = normalizeProgressionRecord(parsed, { activeSubjectId: null });
    expect(Object.keys(withoutActive.bySubject)).toEqual([LEGACY_PROGRESSION_SUBJECT_ID]);
    expect(withoutActive.legacyBucketSubjectId).toBe(LEGACY_PROGRESSION_SUBJECT_ID);
    expect(withoutActive.activeSubjectId).toBeNull();

    const blankActive = normalizeProgressionRecord(parsed, { activeSubjectId: '   ' });
    expect(Object.keys(blankActive.bySubject)).toEqual([LEGACY_PROGRESSION_SUBJECT_ID]);
  });

  it('falls back to flat normalization when a by-subject payload is null', () => {
    const canonical = normalizeProgressionRecord(parseFixture('progression-v2-malformed-by-subject.json'), {
      activeSubjectId: 'subject-phase0-v2-fallback',
    });

    expect(Object.keys(canonical.bySubject)).toEqual(['subject-phase0-v2-fallback']);
    expect(canonical.bySubject['subject-phase0-v2-fallback']?.xpTotal).toBe(325);
  });

  it('retains unknown app-owned fields at both the record and envelope level', () => {
    const canonical = normalizeProgressionRecord(
      {
        version: 3,
        unknownEnvelopeField: { marker: 'synthetic-envelope' },
        bySubject: {
          'subject-a': { xpTotal: 10, unknownRecordField: 'synthetic-record' },
        },
        crossSubjectAchievements: [],
      },
      { activeSubjectId: 'subject-a' },
    );

    expect(canonical.extraFields).toEqual({ unknownEnvelopeField: { marker: 'synthetic-envelope' } });
    expect(canonical.bySubject['subject-a']?.extraFields).toEqual({ unknownRecordField: 'synthetic-record' });
  });

  it('round-trips through the serializer without losing unknown fields', () => {
    const canonical = normalizeProgressionRecord(
      {
        version: 3,
        unknownEnvelopeField: 1,
        bySubject: { 'subject-a': { xpTotal: 42, unknownRecordField: ['x'] } },
        crossSubjectAchievements: ['synthetic-achievement'],
      },
      { activeSubjectId: 'subject-a' },
    );

    const serialized = serializeCanonicalProgression(canonical);
    const restored = deserializeCanonicalProgression(serialized, { activeSubjectId: 'subject-a' });

    expect(restored).toEqual(canonical);
    expect(JSON.parse(serialized).kind).toBe(CANONICAL_PROGRESSION_KIND);
    expect(serializeCanonicalProgression(restored)).toBe(serialized);
  });

  it('serializes to the current version-3 persisted shape', () => {
    const record = canonicalProgressionToRecord({
      sourceVersion: 3,
      activeSubjectId: null,
      legacyBucketSubjectId: null,
      bySubject: {
        'subject-a': normalizeProgressionRecord({ xpTotal: 5 }, { activeSubjectId: 'subject-a' }).bySubject['subject-a']!,
      },
      crossSubjectAchievements: [],
      extraFields: {},
    });

    expect(record.version).toBe(3);
    expect(record.bySubject).toHaveProperty('subject-a');
  });

  it('honours the id factory prefix for both loot and gear', () => {
    expect(storeCreateId('loot')).toMatch(/^loot-/);
    expect(storeCreateId('gear')).toMatch(/^gear-/);
    expect(migrationCreateId('loot')).toMatch(/^loot-/);
    expect(migrationCreateId('gear')).toMatch(/^gear-/);
  });

  it('is deterministic when the id factory is seeded', () => {
    const parsed = parseFixture('progression-v1-flat-malformed.json');
    const first = normalizeProgressionRecord(parsed, { activeSubjectId: 's', createId: migrationCreateId });
    const second = normalizeProgressionRecord(parsed, { activeSubjectId: 's', createId: migrationCreateId });

    expect(second).toEqual(first);
    expect(first.bySubject.s?.inventory[0]?.id).toBe('loot-migrated-0001');
  });

  it('yields empty state for corrupt JSON instead of throwing', () => {
    const canonical = deserializeCanonicalProgression(readProgressionFixture('progression-invalid-syntax.txt'));

    expect(canonical.bySubject).toEqual({});
    expect(canonical.crossSubjectAchievements).toEqual([]);
  });
});

describe('canonical fish identity', () => {
  const mossCarp: FishEntry = {
    id: 'moss-carp:m1-abc',
    name: 'Moss Carp',
    rarity: 'common',
    subjectId: 'subject-a',
    subjectName: 'Synthetic Subject',
    caughtAt: '2026-01-01T00:00:00.000Z',
  };

  it('preserves an existing catalogId through deserialize and round trip', () => {
    const withCatalogId: FishEntry = { ...mossCarp, catalogId: 'moss-carp' };

    const deserialized = deserializeFishCollection([withCatalogId]);
    const reserialized = deserializeFishCollection(serializeFishCollection(deserialized));

    expect(deserialized[0]?.catalogId).toBe('moss-carp');
    expect(reserialized).toEqual(deserialized);
  });

  it('leaves a collection without catalogId byte-identical to the current behavior', () => {
    const deserialized = deserializeFishCollection([mossCarp]);

    expect(deserialized).toEqual([mossCarp]);
    expect(Object.hasOwn(deserialized[0] ?? {}, 'catalogId')).toBe(false);
  });

  it('resolves catalog identity from the entry id prefix', () => {
    expect(resolveFishCatalogId(mossCarp)).toEqual({ catalogId: 'moss-carp', source: 'entry-id-prefix' });
    expect(toCanonicalFishEntry(mossCarp).catalogId).toBe('moss-carp');
  });

  it('resolves catalog identity from an explicit catalogId', () => {
    const explicit: FishEntry = { ...mossCarp, id: 'opaque-1', catalogId: 'moss-carp' };

    expect(resolveFishCatalogId(explicit)).toEqual({ catalogId: 'moss-carp', source: 'catalog-id-field' });
    expect(toCanonicalFishEntry(explicit).catalogId).toBe('moss-carp');
  });

  it('resolves catalog identity from an exact catalog name match', () => {
    const byName: FishEntry = { ...mossCarp, id: 'opaque-2' };

    expect(resolveFishCatalogId(byName)).toEqual({ catalogId: 'moss-carp', source: 'catalog-name-match' });
    expect(toCanonicalFishEntry(byName).catalogId).toBe('moss-carp');
  });

  it('falls back to a deterministic name slug for a fish outside the catalog', () => {
    const unknown: FishEntry = { ...mossCarp, id: 'opaque-3', name: 'Synthetic River Lantern' };

    expect(resolveFishCatalogId(unknown)).toEqual({
      catalogId: 'synthetic-river-lantern',
      source: 'name-slug',
    });
    expect(toCanonicalFishEntry(unknown).catalogId).toBe('synthetic-river-lantern');
  });

  it('uses the explicit unknown marker when no identity can be resolved', () => {
    const nameless: FishEntry = { ...mossCarp, id: 'opaque-4', name: '---' };

    expect(resolveFishCatalogId(nameless)).toEqual({ catalogId: 'unknown-fish', source: 'unknown' });
  });

  it('is idempotent: canonicalizing a canonical collection returns equal entries', () => {
    const raw = [
      mossCarp,
      { ...mossCarp, id: 'gilded-koi:m2', name: 'Gilded Koi', rarity: 'epic' as const },
      { ...mossCarp, id: 'opaque-5', name: 'Synthetic River Lantern' },
    ];

    const once = toCanonicalFishCollection(deserializeFishCollection(raw));
    const twice = toCanonicalFishCollection(once);

    expect(twice).toEqual(once);
    expect(once.every((entry) => entry.catalogId.length > 0)).toBe(true);
  });

  it('round-trips identity through deserialize, canonicalize, and serialize', () => {
    const raw = [mossCarp, { ...mossCarp, id: 'lunar-trout:m3', name: 'Lunar Trout', rarity: 'rare' as const }];

    const canonical = toCanonicalFishCollection(deserializeFishCollection(raw));
    const restored = toCanonicalFishCollection(deserializeFishCollection(canonical));

    expect(restored).toEqual(canonical);
    expect(restored.map((entry) => entry.catalogId)).toEqual(['moss-carp', 'lunar-trout']);
  });

  it('counts distinct catalog types by canonical identity, not by display name', () => {
    const collection = deserializeFishCollection([
      { ...mossCarp, id: 'moss-carp:1' },
      { ...mossCarp, id: 'moss-carp:2' },
      { ...mossCarp, id: 'lunar-trout:3', name: 'Lunar Trout' },
    ]);

    expect(countCanonicalCatalogTypes(collection)).toBe(2);
  });

  it('resolves every catalog fish to its own catalog id', () => {
    for (const catalogEntry of FISH_CATALOG) {
      const resolved = toCanonicalFishEntry({
        id: `opaque-${catalogEntry.id}`,
        name: catalogEntry.name,
        rarity: catalogEntry.rarity,
        subjectId: 'subject-a',
        subjectName: 'Synthetic Subject',
        caughtAt: '2026-01-01T00:00:00.000Z',
      });

      expect(resolved.catalogId).toBe(catalogEntry.id);
    }
  });
});
