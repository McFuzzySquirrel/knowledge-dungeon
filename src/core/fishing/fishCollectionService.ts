/**
 * Fish collection persistence layer - serialize, deserialize, and query
 * the player's caught fish collection. Backed by localStorage via the
 * progression store.
 *
 * All functions are pure; state management is handled by the progression store.
 *
 * Catalog identity (plan section 5.3, "fish catalog identity is discarded or
 * represented inconsistently") is handled in two layers:
 * - `deserializeFishCollection` preserves an existing `catalogId` verbatim and
 *   never invents one, so current persisted collections are unchanged.
 * - `toCanonicalFishEntry` / `toCanonicalFishCollection` resolve identity
 *   deterministically for storage, backup, and migration.
 */

import {
  FISH_CATALOG,
  UNKNOWN_FISH_CATALOG_ID,
  type CanonicalFishEntry,
  type FishCatalogIdSource,
  type FishEntry,
  type FishCollection,
  type FishRarity,
} from './fishingTypes';

/**
 * Create a unique fish entry id from catalog id and timestamp.
 */
export function createFishId(catalogId: string): string {
  const suffix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  return `${catalogId}:${suffix}`;
}

/**
 * Serialize a FishCollection to a JSON-safe array of plain objects.
 * No loss - FishEntry is already POJO-compatible.
 */
export function serializeFishCollection(collection: FishCollection): FishEntry[] {
  return collection.map((entry) => ({ ...entry }));
}

/**
 * Deserialize and validate raw data into a FishCollection.
 * Filters out malformed entries.
 */
export function deserializeFishCollection(raw: unknown): FishCollection {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
    )
    .map(normalizeFishEntry)
    .filter((entry): entry is FishEntry => entry !== null);
}

function normalizeFishEntry(raw: Record<string, unknown>): FishEntry | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  const rarity = isValidRarity(raw.rarity) ? raw.rarity : 'common';
  const subjectId = typeof raw.subjectId === 'string' ? raw.subjectId : '';
  const subjectName = typeof raw.subjectName === 'string' ? raw.subjectName : '';
  const caughtAt = typeof raw.caughtAt === 'string' ? raw.caughtAt : new Date(0).toISOString();

  if (id.length === 0 || name.length === 0) return null;

  // Only a real, non-empty catalog id is carried through. A missing id must not
  // become an explicit `undefined` key: the collection round trip and the
  // Phase 0 characterization compare these objects with exact equality.
  return typeof raw.catalogId === 'string' && raw.catalogId.length > 0
    ? { id, name, rarity, subjectId, subjectName, caughtAt, catalogId: raw.catalogId }
    : { id, name, rarity, subjectId, subjectName, caughtAt };
}

function isValidRarity(value: unknown): value is FishRarity {
  if (typeof value !== 'string') return false;
  return value === 'common' || value === 'rare' || value === 'epic';
}

/**
 * Return a new collection with the fish added at the front.
 * Returns the same array reference if the fish id already exists.
 */
export function addFishToCollection(
  collection: FishCollection,
  fish: FishEntry,
): FishCollection {
  if (collection.some((f) => f.id === fish.id)) return collection;
  return [fish, ...collection];
}

/**
 * Count fish by rarity in a collection.
 */
export function countByRarity(
  collection: FishCollection,
): Record<FishRarity, number> {
  return {
    common: collection.filter((f) => f.rarity === 'common').length,
    rare: collection.filter((f) => f.rarity === 'rare').length,
    epic: collection.filter((f) => f.rarity === 'epic').length,
  };
}

/**
 * Get the total count of unique fish catalog types caught.
 */
export function countUniqueTypes(collection: FishCollection): number {
  const names = new Set(collection.map((f) => f.name));
  return names.size;
}

// ── Canonical catalog identity ────────────────────────────────────────────

/** Deterministic slug used when an entry has no catalog match. */
function slugifyCatalogId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const CATALOG_IDS_BY_NAME: ReadonlyMap<string, string> = new Map(
  FISH_CATALOG.map((entry) => [entry.name.toLowerCase(), entry.id]),
);

/** Catalog ids, for the direct prefix membership test in the resolver. */
const CATALOG_IDS: ReadonlySet<string> = new Set(FISH_CATALOG.map((entry) => entry.id));

/**
 * Resolve the canonical catalog id of a fish entry.
 *
 * Resolution order, all deterministic and free of randomness:
 * 1. an explicit `catalogId` on the entry,
 * 2. the `<catalogId>:<suffix>` prefix produced by {@link createFishId},
 * 3. an exact (case-insensitive) catalog name match,
 * 4. a slug of the display name,
 * 5. the explicit `unknown-fish` marker.
 */
export function resolveFishCatalogId(
  entry: Pick<FishEntry, 'id' | 'name' | 'catalogId'>,
): { catalogId: string; source: FishCatalogIdSource } {
  if (typeof entry.catalogId === 'string' && entry.catalogId.length > 0) {
    return { catalogId: entry.catalogId, source: 'catalog-id-field' };
  }

  const separatorIndex = entry.id.indexOf(':');
  if (separatorIndex > 0) {
    const prefix = entry.id.slice(0, separatorIndex);
    if (CATALOG_IDS.has(prefix)) {
      return { catalogId: prefix, source: 'entry-id-prefix' };
    }
  }

  const byName = CATALOG_IDS_BY_NAME.get(entry.name.toLowerCase());
  if (byName) return { catalogId: byName, source: 'catalog-name-match' };

  const slug = slugifyCatalogId(entry.name);
  if (slug.length > 0) return { catalogId: slug, source: 'name-slug' };

  return { catalogId: UNKNOWN_FISH_CATALOG_ID, source: 'unknown' };
}

/**
 * Resolve a fish entry to its canonical form.
 *
 * The returned entry always carries a resolved `catalogId` and otherwise repeats
 * the entry unchanged. No random value is minted, and the transform is
 * idempotent: canonicalizing a canonical entry returns an equal entry.
 */
export function toCanonicalFishEntry(entry: FishEntry): CanonicalFishEntry {
  return { ...entry, catalogId: resolveFishCatalogId(entry).catalogId };
}

/**
 * Resolve a whole collection. Order and length are preserved, so the call is
 * idempotent: canonicalizing a canonical collection returns equal entries.
 */
export function toCanonicalFishCollection(collection: FishCollection): CanonicalFishEntry[] {
  return collection.map((entry) => toCanonicalFishEntry(entry));
}

/** Count distinct canonical catalog ids in a collection. */
export function countCanonicalCatalogTypes(collection: FishCollection): number {
  return new Set(toCanonicalFishCollection(collection).map((entry) => entry.catalogId)).size;
}
