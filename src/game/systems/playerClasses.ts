/**
 * Player class selection. Re-themed from repo-dungeon's adventurer archetypes
 * to "study archetypes" so the same UI/UX (class picker + class-flavoured
 * loot) keeps working in the knowledge-dungeon context.
 */

export type PlayerClassId = 'scholar' | 'cartographer' | 'archivist';

export interface PlayerClassDefinition {
  id: PlayerClassId;
  name: string;
  tagline: string;
  description: string;
  perk: string;
}

export const PLAYER_CLASSES: readonly PlayerClassDefinition[] = [
  {
    id: 'scholar',
    name: 'Scholar',
    tagline: 'Methodical, balanced, exam-ready.',
    description:
      'A careful note-taker who values structured Summary / Key Points / Recall layouts.',
    perk: '+1 quality bonus floor on every defeated encounter.',
  },
  {
    id: 'cartographer',
    name: 'Cartographer',
    tagline: 'Maps relationships between concepts.',
    description:
      'Excels at the Creator phase, linking topics quickly and resolving stray rooms.',
    perk: 'Cross-link suggestions appear sooner in the room-info panel.',
  },
  {
    id: 'archivist',
    name: 'Archivist',
    tagline: 'Loves revisiting old material.',
    description:
      'Optimised for the Archaeologist phase — generates richer self-check prompts.',
    perk: 'Self-check prompt cap increases from 4 to 6.',
  },
] as const;

export function findPlayerClass(id: PlayerClassId | null | undefined): PlayerClassDefinition | null {
  if (!id) return null;
  return PLAYER_CLASSES.find((c) => c.id === id) ?? null;
}
