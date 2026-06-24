/**
 * Fish collection persistence layer - serialize, deserialize, and query
 * the player's caught fish collection. Backed by localStorage via the
 * progression store.
 *
 * All functions are pure; state management is handled by the progression store.
 */

import type { FishEntry, FishCollection, FishRarity } from '@/game/systems/fishingTypes';

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

  return { id, name, rarity, subjectId, subjectName, caughtAt };
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
