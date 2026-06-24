/**
 * Fisher's Rest — Fishing mechanics: bite timing, rarity rolls, and
 * recall question pulling from cleared dungeon rooms.
 */

import type { FishCatalogEntry, FishRarity } from '@/game/systems/fishingTypes';
import {
  FISH_CATALOG,
  FISH_RARITY_WEIGHTS,
  BITE_TIMER_MIN_SEC,
  BITE_TIMER_MAX_SEC,
  BITE_WINDOW_SEC,
} from '@/game/systems/fishingTypes';
import type { RoomMetadata, DungeonRoomSummary } from '@/core/validation/persistence';
import { generateSelfCheckPrompts, extractMarkdownHeadings } from '@/core/review/reviewDomain';
import type { SelfCheckPrompt } from '@/core/review/types';

/**
 * Generate a random bite delay in milliseconds between BITE_TIMER_MIN and MAX.
 *
 * @deprecated Since Phase F3, bite timing uses proximity-based detection
 * (fish sprite within 50 px of bobber) instead of a random timer.
 * Kept as a utility for the max-timeout fallback (20 s) only.
 *
 * TODO Phase F4: Add seeded RNG based on subjectId + fishCount for determinism.
 */
export function rollBiteDelayMs(): number {
  const sec = BITE_TIMER_MIN_SEC + Math.random() * (BITE_TIMER_MAX_SEC - BITE_TIMER_MIN_SEC);
  return Math.round(sec * 1000);
}

/**
 * Roll a fish rarity using the weighted distribution.
 * Returns the rolled rarity and the fish catalog entry.
 */
export function rollFishRarity(): { rarity: FishRarity; entry: FishCatalogEntry } {
  const roll = Math.random() * 100;
  let cumulative = 0;
  let rolledRarity: FishRarity = 'common';

  for (const [rarity, weight] of Object.entries(FISH_RARITY_WEIGHTS)) {
    cumulative += weight;
    if (roll <= cumulative) {
      rolledRarity = rarity as FishRarity;
      break;
    }
  }

  const candidates = FISH_CATALOG.filter((f) => f.rarity === rolledRarity);
  const entry = candidates[Math.floor(Math.random() * candidates.length)];

  return { rarity: rolledRarity, entry };
}

/**
 * Identify cleared, reviewable rooms from a dungeon's rooms.
 * A room is "cleared" if it's in a reviewable state and has passed validation.
 */
export function getClearedRooms(rooms: Record<string, RoomMetadata>): RoomMetadata[] {
  const REVIEWABLE_STATES = new Set(['EncounterDefeated', 'ArtifactCollected', 'NeedsRevalidation']);
  return Object.values(rooms).filter(
    (room) =>
      REVIEWABLE_STATES.has(room.state) &&
      room.validationState.finalPass,
  );
}

/**
 * Pull a random recall question from a cleared room in the given dungeon subject.
 *
 * Returns null if no cleared rooms are available (the caller should show
 * the "unlock fish here" message per FSH-FR-23).
 */
export function pullRecallQuestion(args: {
  clearedRooms: RoomMetadata[];
  dungeonRooms: DungeonRoomSummary[];
  subjectName: string;
}): { prompt: SelfCheckPrompt; roomId: string } | null {
  const { clearedRooms, dungeonRooms, subjectName } = args;

  if (clearedRooms.length === 0) return null;

  const pickedRoom = clearedRooms[Math.floor(Math.random() * clearedRooms.length)];

  // Gather related topics from linked rooms
  const dungeonRoomMap = new Map(dungeonRooms.map((r) => [r.roomId, r]));
  const relatedTopics: string[] = [];
  const pickedRoomSummary = dungeonRoomMap.get(pickedRoom.roomId);
  if (pickedRoomSummary) {
    // Use other room topics as related topics
    for (const other of dungeonRooms) {
      if (other.roomId !== pickedRoom.roomId && other.topic) {
        relatedTopics.push(other.topic);
      }
    }
  }

  const noteHeadings = extractMarkdownHeadings(pickedRoom.noteText || '');

  const prompts = generateSelfCheckPrompts({
    roomId: pickedRoom.roomId,
    subjectName,
    roomTopic: pickedRoom.topic,
    noteHeadings,
    relatedTopics,
    maxPromptCount: 3,
  });

  const prompt = prompts[Math.floor(Math.random() * prompts.length)];

  return { prompt, roomId: pickedRoom.roomId };
}

/** Re-export bite window for convenience. */
export { BITE_WINDOW_SEC };
