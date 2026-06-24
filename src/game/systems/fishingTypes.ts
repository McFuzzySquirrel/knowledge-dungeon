/**
 * Fisher's Rest — Fishing mini-game types.
 *
 * Defines the fish rarity tiers, individual fish entries, the fish catalog
 * (all catchable fish across every rarity), and the per-player fish collection.
 */

/** Rarity tier for catchable fish. Determines appearance and XP multiplier. */
export type FishRarity = 'common' | 'rare' | 'epic';

/** A single fish that the player has caught and kept. */
export interface FishEntry {
  /** Unique id combining the fish catalog id + a random suffix. */
  id: string;
  /** Catalog name of the fish (e.g. "Moss Carp"). */
  name: string;
  /** Rarity tier. */
  rarity: FishRarity;
  /** The dungeon subject id this fish was caught from. */
  subjectId: string;
  /** Human-readable subject name for display. */
  subjectName: string;
  /** ISO-8601 timestamp of when the fish was caught. */
  caughtAt: string;
}

/** A collection of caught fish entries. */
export type FishCollection = FishEntry[];

/** A single fish type definition in the catchable catalog. */
export interface FishCatalogEntry {
  id: string;
  name: string;
  rarity: FishRarity;
  /** Flavor text shown when the fish is caught. */
  description: string;
  /** Sprite filename in public/assets/sprites/fishing/ */
  sprite: string;
}

/**
 * Complete catalog of all catchable fish.
 *
 * Must contain at least 6 fish across all 3 rarities (Phase F1 validation).
 */
export const FISH_CATALOG: readonly FishCatalogEntry[] = [
  // ── Common (65% drop rate) ────────────────────────
  {
    id: 'moss-carp',
    name: 'Moss Carp',
    rarity: 'common',
    description: 'A placid bottom-feeder with scales the colour of river stones. Common in still waters near settlements.',
    sprite: 'fish-moss-carp.svg',
  },
  {
    id: 'sun-skip',
    name: 'Sun Skip',
    rarity: 'common',
    description: 'A quick little silver fish that flashes in the light as it leaps from the water.',
    sprite: 'fish-sun-skip.svg',
  },
  {
    id: 'reed-darter',
    name: 'Reed Darter',
    rarity: 'common',
    description: 'A slender fish that darts between water weeds. Its green-brown stripes make it hard to spot.',
    sprite: 'fish-reed-darter.svg',
  },
  {
    id: 'ink-minnow',
    name: 'Ink Minnow',
    rarity: 'common',
    description: 'Tiny and dark as spilled ink, these minnows swim in swirling schools.',
    sprite: 'fish-ink-minnow.svg',
  },
  // ── Rare (28% drop rate) ──────────────────────────
  {
    id: 'lunar-trout',
    name: 'Lunar Trout',
    rarity: 'rare',
    description: 'Its pale blue spots glow faintly in the dark. Said to only bite when the moon is high.',
    sprite: 'fish-lunar-trout.svg',
  },
  {
    id: 'ember-perch',
    name: 'Ember Perch',
    rarity: 'rare',
    description: 'Warm to the touch, as if a tiny flame burns within. Prized by alchemists for its heat.',
    sprite: 'fish-ember-perch.svg',
  },
  // ── Epic (7% drop rate) ───────────────────────────
  {
    id: 'gilded-koi',
    name: 'Gilded Koi',
    rarity: 'epic',
    description: 'A magnificent fish with scales that gleam like polished gold. Legends say it grants wisdom.',
    sprite: 'fish-gilded-koi.svg',
  },
  {
    id: 'abyssal-eel',
    name: 'Abyssal Eel',
    rarity: 'epic',
    description: 'A ribbon of living shadow pulled from the deep. Its eyes hold the memory of forgotten knowledge.',
    sprite: 'fish-abyssal-eel.svg',
  },
];

export const FISH_RARITY_WEIGHTS: Record<FishRarity, number> = {
  common: 65,
  rare: 28,
  epic: 7,
};

/** XP multiplier applied to the base fishing XP based on rarity. */
export const FISH_RARITY_XP_MULTIPLIER: Record<FishRarity, number> = {
  common: 1.0,
  rare: 1.5,
  epic: 2.0,
};

/** Minimum and maximum wait time (seconds) before a fish bites. */
export const BITE_TIMER_MIN_SEC = 3;
export const BITE_TIMER_MAX_SEC = 15;

/** Window (seconds) the player has to click after the bite indicator appears. */
export const BITE_WINDOW_SEC = 2;

// ── Proximity-based bite (Phase F3 redesign) ─────────────────────────────

/** Direction from which a fish enters the scene to swim toward the bobber. */
export type FishDirection = 'right' | 'bottom';

/** Equal weights for random fish-direction selection each cast. */
export const FISH_DIRECTION_WEIGHTS: Record<FishDirection, number> = {
  right: 1,
  bottom: 1,
};

/** Maximum time (ms) a fish will search for the bobber before giving up and swimming away. */
export const MAX_PROXIMITY_WAIT_MS = 20_000;
