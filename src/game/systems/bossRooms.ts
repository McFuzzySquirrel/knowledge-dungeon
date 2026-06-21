/**
 * Boss room system — Track 3c: Gameplay Depth.
 *
 * Generates boss encounter data for milestone floors and provides
 * the logic for boss room XP and loot multipliers.
 */

export interface BossEncounter {
  /** Room ID of the boss encounter */
  roomId: string;
  /** The milestone floor number (1-indexed) */
  floorNumber: number;
  /** Boss title (e.g., "Guardian of Floor 10") */
  title: string;
  /** Boss flavor description */
  description: string;
  /** Multiplier applied to base XP for this encounter */
  xpMultiplier: number;
  /** Multiplier applied to quality bonus for this encounter */
  qualityMultiplier: number;
  /** Guaranteed loot rarity minimum */
  minLootRarity: 'rare' | 'epic';
  /** Whether the boss has been defeated */
  defeated: boolean;
}

/**
 * Milestone floors that trigger boss encounters.
 * Default: every 10th floor.
 */
const BOSS_MILESTONE_INTERVAL = 10;

const BOSS_TITLES: ReadonlyArray<{
  title: string;
  description: string;
  xpMultiplier: number;
  qualityMultiplier: number;
  minLootRarity: 'rare' | 'epic';
}> = [
  {
    title: 'Gatekeeper of the Dungeon',
    description:
      'A towering stone guardian blocks the way forward. Cracks in its armor pulse with an ancient knowledge.',
    xpMultiplier: 2.0,
    qualityMultiplier: 1.5,
    minLootRarity: 'rare',
  },
  {
    title: 'Warden of Forgotten Tomes',
    description:
      'Ink-stained tentacles rise from a pool of dark knowledge, each tipped with a quill that writes forbidden notes.',
    xpMultiplier: 2.5,
    qualityMultiplier: 1.5,
    minLootRarity: 'rare',
  },
  {
    title: 'Arch-Scribe of the Abyss',
    description:
      'A spectral librarian floats above a desk of bones, demanding your best notes in exchange for passage.',
    xpMultiplier: 3.0,
    qualityMultiplier: 2.0,
    minLootRarity: 'epic',
  },
  {
    title: 'Grand Cartographer of Chaos',
    description:
      'A living map-sized creature whose parchment skin shows every room you have ever entered. It knows your path.',
    xpMultiplier: 3.5,
    qualityMultiplier: 2.0,
    minLootRarity: 'epic',
  },
  {
    title: 'Master of the Empty Page',
    description:
      'An invisible presence fills the room — the terror of the blank page. Only structured notes can banish it.',
    xpMultiplier: 4.0,
    qualityMultiplier: 2.5,
    minLootRarity: 'epic',
  },
];

export function isBossFloor(floorNumber: number): boolean {
  return floorNumber > 0 && floorNumber % BOSS_MILESTONE_INTERVAL === 0;
}

export function getBossFloorNumbers(totalFloors: number): number[] {
  const floors: number[] = [];
  for (let f = BOSS_MILESTONE_INTERVAL; f <= totalFloors; f += BOSS_MILESTONE_INTERVAL) {
    floors.push(f);
  }
  return floors;
}

export function generateBossEncounter(
  roomId: string,
  floorNumber: number,
  defeated = false,
): BossEncounter | null {
  if (!isBossFloor(floorNumber)) return null;

  // Cycle through boss titles based on how many milestone intervals this floor is at
  const bossIndex = Math.floor(floorNumber / BOSS_MILESTONE_INTERVAL) - 1;
  const template = BOSS_TITLES[bossIndex % BOSS_TITLES.length]!;

  return {
    roomId,
    floorNumber,
    title: `${template.title} (Floor ${floorNumber})`,
    description: template.description,
    xpMultiplier: template.xpMultiplier,
    qualityMultiplier: template.qualityMultiplier,
    minLootRarity: template.minLootRarity,
    defeated,
  };
}

/**
 * Calculate boosted XP for a boss encounter.
 */
export function calculateBossXp(
  baseXp: number,
  qualityBonus: number,
  xpMultiplier: number,
  qualityMultiplier: number,
): { boostedBase: number; boostedQuality: number; total: number } {
  const boostedBase = Math.round(baseXp * xpMultiplier);
  const boostedQuality = Math.round(qualityBonus * qualityMultiplier);
  return {
    boostedBase,
    boostedQuality,
    total: boostedBase + boostedQuality,
  };
}
