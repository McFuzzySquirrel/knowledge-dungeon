import { describe, expect, it } from 'vitest';
import {
  serializeFishCollection,
  deserializeFishCollection,
  addFishToCollection,
  countByRarity,
  countUniqueTypes,
} from '@/core/fishing/fishCollectionService';
import type { FishEntry, FishCollection } from '@/game/systems/fishingTypes';

function makeFish(overrides: Partial<FishEntry> = {}): FishEntry {
  return {
    id: 'moss-carp:abc-123',
    name: 'Moss Carp',
    rarity: 'common',
    subjectId: 'subject-1',
    subjectName: 'Linear Algebra',
    caughtAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('fishCollectionService', () => {
  describe('serializeFishCollection → deserializeFishCollection round-trip', () => {
    it('preserves an empty collection', () => {
      const result = deserializeFishCollection(serializeFishCollection([]));
      expect(result).toEqual([]);
    });

    it('preserves a single fish entry', () => {
      const fish = makeFish();
      const roundTripped = deserializeFishCollection(serializeFishCollection([fish]));
      expect(roundTripped).toHaveLength(1);
      expect(roundTripped[0]).toEqual(fish);
    });

    it('preserves multiple fish entries', () => {
      const collection: FishCollection = [
        makeFish({ id: 'moss-carp:1', name: 'Moss Carp' }),
        makeFish({ id: 'lunar-trout:2', name: 'Lunar Trout', rarity: 'rare' }),
        makeFish({ id: 'gilded-koi:3', name: 'Gilded Koi', rarity: 'epic' }),
      ];
      const roundTripped = deserializeFishCollection(serializeFishCollection(collection));
      expect(roundTripped).toHaveLength(3);
      expect(roundTripped[0].name).toBe('Moss Carp');
      expect(roundTripped[1].name).toBe('Lunar Trout');
      expect(roundTripped[2].name).toBe('Gilded Koi');
    });
  });

  describe('deserializeFishCollection', () => {
    it('returns empty array for null input', () => {
      expect(deserializeFishCollection(null)).toEqual([]);
    });

    it('returns empty array for undefined input', () => {
      expect(deserializeFishCollection(undefined)).toEqual([]);
    });

    it('returns empty array for non-array input', () => {
      expect(deserializeFishCollection({ fish: 'nope' })).toEqual([]);
    });

    it('filters out malformed entries (missing id)', () => {
      const result = deserializeFishCollection([
        { name: 'Moss Carp', rarity: 'common' },
      ]);
      expect(result).toEqual([]);
    });

    it('filters out malformed entries (missing name)', () => {
      const result = deserializeFishCollection([
        { id: 'moss-carp:1', rarity: 'common' },
      ]);
      expect(result).toEqual([]);
    });

    it('defaults missing rarity to common', () => {
      const result = deserializeFishCollection([
        { id: 'moss-carp:1', name: 'Moss Carp' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].rarity).toBe('common');
    });

    it('defaults invalid rarity to common', () => {
      const result = deserializeFishCollection([
        { id: 'moss-carp:1', name: 'Moss Carp', rarity: 'legendary' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].rarity).toBe('common');
    });

    it('defaults missing subjectId to empty string', () => {
      const result = deserializeFishCollection([
        { id: 'moss-carp:1', name: 'Moss Carp' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].subjectId).toBe('');
    });

    it('defaults missing caughtAt to epoch ISO', () => {
      const result = deserializeFishCollection([
        { id: 'moss-carp:1', name: 'Moss Carp' },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].caughtAt).toBe(new Date(0).toISOString());
    });
  });

  describe('addFishToCollection', () => {
    it('adds first fish to empty collection', () => {
      const fish = makeFish();
      const result = addFishToCollection([], fish);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(fish);
    });

    it('adds multiple fish to collection (newest first)', () => {
      const fish1 = makeFish({ id: 'moss-carp:1' });
      const fish2 = makeFish({ id: 'lunar-trout:2' });
      const afterFirst = addFishToCollection([], fish1);
      const afterSecond = addFishToCollection(afterFirst, fish2);
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[0]).toEqual(fish2);
      expect(afterSecond[1]).toEqual(fish1);
    });

    it('deduplicates — same fish ID is not added twice', () => {
      const fish = makeFish({ id: 'moss-carp:1' });
      const collection = addFishToCollection([], fish);
      const result = addFishToCollection(collection, fish);
      expect(result).toBe(collection); // same reference
      expect(result).toHaveLength(1);
    });

    it('does not mutate the original collection', () => {
      const original: FishCollection = [];
      const fish = makeFish();
      const result = addFishToCollection(original, fish);
      expect(original).toHaveLength(0);
      expect(result).not.toBe(original);
    });
  });

  describe('countByRarity', () => {
    it('correctly counts common, rare, epic', () => {
      const collection: FishCollection = [
        makeFish({ id: 'moss-carp:1', rarity: 'common' }),
        makeFish({ id: 'sun-skip:2', rarity: 'common' }),
        makeFish({ id: 'lunar-trout:3', rarity: 'rare' }),
        makeFish({ id: 'gilded-koi:4', rarity: 'epic' }),
      ];
      const counts = countByRarity(collection);
      expect(counts).toEqual({ common: 2, rare: 1, epic: 1 });
    });

    it('empty collection returns all zeros', () => {
      const counts = countByRarity([]);
      expect(counts).toEqual({ common: 0, rare: 0, epic: 0 });
    });

    it('only rare fish returns correct counts', () => {
      const collection: FishCollection = [
        makeFish({ id: 'lunar-trout:1', rarity: 'rare' }),
        makeFish({ id: 'ember-perch:2', rarity: 'rare' }),
      ];
      const counts = countByRarity(collection);
      expect(counts).toEqual({ common: 0, rare: 2, epic: 0 });
    });
  });

  describe('countUniqueTypes', () => {
    it('counts unique fish types by name', () => {
      const collection: FishCollection = [
        makeFish({ id: 'moss-carp:1', name: 'Moss Carp' }),
        makeFish({ id: 'moss-carp:2', name: 'Moss Carp' }), // duplicate name
        makeFish({ id: 'lunar-trout:3', name: 'Lunar Trout' }),
        makeFish({ id: 'gilded-koi:4', name: 'Gilded Koi' }),
      ];
      expect(countUniqueTypes(collection)).toBe(3);
    });

    it('empty collection returns 0', () => {
      expect(countUniqueTypes([])).toBe(0);
    });

    it('single fish returns 1', () => {
      expect(countUniqueTypes([makeFish()])).toBe(1);
    });
  });
});
