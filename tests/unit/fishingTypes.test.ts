import { describe, expect, it } from 'vitest';
import {
  FISH_CATALOG,
  FISH_RARITY_WEIGHTS,
  FISH_RARITY_XP_MULTIPLIER,
} from '@/game/systems/fishingTypes';

describe('fishingTypes', () => {
  describe('FISH_CATALOG', () => {
    it('contains exactly 8 entries', () => {
      expect(FISH_CATALOG).toHaveLength(8);
    });

    it('all entries have required fields (id, name, rarity, description, sprite)', () => {
      for (const entry of FISH_CATALOG) {
        expect(entry).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
            rarity: expect.stringMatching(/^(common|rare|epic)$/),
            description: expect.any(String),
            sprite: expect.any(String),
          }),
        );
        expect(entry.id.length).toBeGreaterThan(0);
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.sprite.length).toBeGreaterThan(0);
      }
    });
  });

  describe('FISH_RARITY_WEIGHTS', () => {
    it('rarity weights sum to 100', () => {
      const sum = Object.values(FISH_RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
      expect(sum).toBe(100);
    });
  });

  describe('FISH_RARITY_XP_MULTIPLIER', () => {
    it('all XP multipliers are positive', () => {
      for (const [rarity, multiplier] of Object.entries(FISH_RARITY_XP_MULTIPLIER)) {
        expect(multiplier, `${rarity} XP multiplier`).toBeGreaterThan(0);
      }
    });

    it('epic multiplier is higher than common', () => {
      expect(FISH_RARITY_XP_MULTIPLIER.epic).toBeGreaterThan(
        FISH_RARITY_XP_MULTIPLIER.common,
      );
    });
  });
});
