/**
 * Equippable loot / gear system — Track 3c: Gameplay Depth.
 *
 * Expands the existing loot system to support equippable items that
 * modify gameplay stats (XP multipliers, quality bonuses, etc.).
 */

import type { LootItem } from '@/store/progressionStore';

/** Categories of equippable loot */
export type EquipSlot = 'head' | 'body' | 'accessory' | 'weapon';

export interface EquippableLootItem extends LootItem {
  equipSlot: EquipSlot;
  /** Bonus added to quality score on note submission */
  qualityBonus?: number;
  /** Multiplier applied to base XP (1.0 = no change) */
  xpMultiplier?: number;
  /** Bonus XP awarded per encounter (flat addition) */
  xpBonus?: number;
  /** Extra streak count after successful submission */
  streakBonus?: number;
  equipped: boolean;
}

/**
 * Pool of equippable loot items (expands the existing LOOT_POOL in progressionStore).
 */
export const EQUIPPABLE_LOOT_POOL: ReadonlyArray<Omit<EquippableLootItem, 'id' | 'acquiredAt' | 'equipped'>> = [
  // ── Head slot ──────────────────────────────────────────────
  {
    name: "Scholar's Cap",
    description: 'A velvet cap that sharpens the mind. +1 quality bonus on note submissions.',
    rarity: 'common',
    equipSlot: 'head',
    qualityBonus: 1,
  },
  {
    name: 'Crown of Clarity',
    description: 'Golden laurels blessed by the muses. +2 quality bonus, +2 XP per encounter.',
    rarity: 'rare',
    equipSlot: 'head',
    qualityBonus: 2,
    xpBonus: 2,
  },
  {
    name: "Archmage's Circlet",
    description: 'Faint stars orbit this silver circlet. +3 quality bonus, 10% XP multiplier.',
    rarity: 'epic',
    equipSlot: 'head',
    qualityBonus: 3,
    xpMultiplier: 1.1,
  },

  // ── Body slot ──────────────────────────────────────────────
  {
    name: "Scribe's Robes",
    description: 'Worn robes covered in ink stains. +1 XP per encounter.',
    rarity: 'common',
    equipSlot: 'body',
    xpBonus: 1,
  },
  {
    name: 'Mantle of Persistence',
    description: 'A heavy cloak that whispers encouragement. +1 streak bonus after clear.',
    rarity: 'rare',
    equipSlot: 'body',
    streakBonus: 1,
  },
  {
    name: 'Robe of the Grand Scholar',
    description: 'Embroidered with constellations of all known subjects. +4 XP, +1 quality bonus.',
    rarity: 'epic',
    equipSlot: 'body',
    xpBonus: 4,
    qualityBonus: 1,
  },

  // ── Accessory slot ─────────────────────────────────────────
  {
    name: 'Inkwell Charm',
    description: 'A tiny inkwell on a chain — never runs dry. +1 quality bonus.',
    rarity: 'common',
    equipSlot: 'accessory',
    qualityBonus: 1,
  },
  {
    name: 'Ring of Recall',
    description: 'A copper band etched with question marks. +2 XP per review pass.',
    rarity: 'rare',
    equipSlot: 'accessory',
    xpBonus: 2,
  },
  {
    name: 'Philosopher’s Pendant',
    description: 'Glows when you approach a mastered concept. +2 quality bonus, 5% XP multiplier.',
    rarity: 'epic',
    equipSlot: 'accessory',
    qualityBonus: 2,
    xpMultiplier: 1.05,
  },

  // ── Weapon slot ────────────────────────────────────────────
  {
    name: 'Quill of Quick Thought',
    description: 'A feathered quill that writes before you think. +2 XP per encounter.',
    rarity: 'common',
    equipSlot: 'weapon',
    xpBonus: 2,
  },
  {
    name: 'Scroll of Binding',
    description: 'Seals knowledge into memory with golden ink. 15% XP multiplier.',
    rarity: 'rare',
    equipSlot: 'weapon',
    xpMultiplier: 1.15,
  },
  {
    name: 'Pen of Absolute Truth',
    description: 'Anything written with this pen becomes indelible. +5 XP, +2 quality bonus.',
    rarity: 'epic',
    equipSlot: 'weapon',
    xpBonus: 5,
    qualityBonus: 2,
  },
];

export const EQUIP_SLOTS: readonly EquipSlot[] = ['head', 'body', 'accessory', 'weapon'];

export const EQUIP_SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head',
  body: 'Body',
  accessory: 'Accessory',
  weapon: 'Weapon',
};

/**
 * Compute total stat bonuses from equipped items.
 */
export function computeEquipBonuses(equipped: readonly EquippableLootItem[]): {
  qualityBonus: number;
  xpMultiplier: number;
  xpBonus: number;
  streakBonus: number;
} {
  let qualityBonus = 0;
  let xpMultiplier = 1.0;
  let xpBonus = 0;
  let streakBonus = 0;

  for (const item of equipped) {
    qualityBonus += item.qualityBonus ?? 0;
    xpMultiplier *= item.xpMultiplier ?? 1.0;
    xpBonus += item.xpBonus ?? 0;
    streakBonus += item.streakBonus ?? 0;
  }

  // Round multiplier to avoid floating point drift
  xpMultiplier = Math.round(xpMultiplier * 100) / 100;

  return { qualityBonus, xpMultiplier, xpBonus, streakBonus };
}

/**
 * Roll for equippable loot based on quality bonus.
 */
export function rollEquippableLoot(qualityBonus: number, minRarity?: 'rare' | 'epic'): EquippableLootItem | null {
  let pool = EQUIPPABLE_LOOT_POOL;

  if (minRarity === 'epic') {
    pool = pool.filter((l) => l.rarity === 'epic');
  } else if (minRarity === 'rare') {
    pool = pool.filter((l) => l.rarity !== 'common');
  } else if (qualityBonus < 4) {
    return null;
  } else if (qualityBonus < 7) {
    pool = pool.filter((l) => l.rarity === 'common');
  } else if (qualityBonus < 9) {
    pool = pool.filter((l) => l.rarity !== 'epic');
  }

  if (pool.length === 0) return null;

  const pick = pool[Math.floor(Math.random() * pool.length)]!;
  return {
    id: `gear-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: pick.name,
    description: pick.description,
    rarity: pick.rarity,
    acquiredAt: new Date().toISOString(),
    equipSlot: pick.equipSlot,
    qualityBonus: pick.qualityBonus,
    xpMultiplier: pick.xpMultiplier,
    xpBonus: pick.xpBonus,
    streakBonus: pick.streakBonus,
    equipped: false,
  };
}

/** Enhance existing loot pool items to be potentially equippable */
export function isEquippable(item: LootItem): item is EquippableLootItem {
  return 'equipSlot' in item && typeof (item as EquippableLootItem).equipSlot === 'string';
}
