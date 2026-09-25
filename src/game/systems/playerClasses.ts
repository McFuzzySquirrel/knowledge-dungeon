/**
 * Player class selection. Re-themed from repo-dungeon's adventurer archetypes
 * to "study archetypes" so the same UI/UX (class picker + class-flavoured
 * loot) keeps working in the knowledge-dungeon context.
 */
import type { PlayerClassId as NeutralPlayerClassId } from '@/application/contracts/world';

export type PlayerClassId = 'scholar' | 'cartographer' | 'archivist';

/**
 * Compile-time drift guard: the renderer-neutral `PlayerClassId` declared in
 * `src/application/contracts/world.ts` (the application layer must not import
 * from `src/game`) has to stay exactly in sync with the runtime union above.
 *
 * `AssertTrue<T extends true>` makes the constraint real: when either side gains
 * or loses a member the conditional resolves to `false`, which does not satisfy
 * the constraint, so `npm run typecheck` fails right here instead of relying on
 * an unrelated use site. A plain alias whose body resolves to `never` would be a
 * legal declaration and enforce nothing.
 */
type AssertTrue<T extends true> = T;
export type NeutralPlayerClassIdParity = AssertTrue<
  [NeutralPlayerClassId] extends [PlayerClassId]
    ? [PlayerClassId] extends [NeutralPlayerClassId]
      ? true
      : false
    : false
>;

export type PlayerDirection = 'down' | 'left' | 'right' | 'up';

export const DIRECTION_SUFFIX: Record<PlayerDirection, string> = {
  down: '',
  left: '-left',
  right: '-right',
  up: '-back',
};

const PLAYER_SPRITE_BASE: Record<PlayerClassId, string> = {
  scholar: 'sprites/player-hero',
  cartographer: 'sprites/player-explorer',
  archivist: 'sprites/player-archivist',
};

const PLAYER_SPRITE_FALLBACK_BASE = 'sprites/player';

export function getPlayerSpritePath(cls: PlayerClassId | null | undefined, dir: PlayerDirection): string {
  const base = cls ? PLAYER_SPRITE_BASE[cls] : PLAYER_SPRITE_FALLBACK_BASE;
  return `${base}${DIRECTION_SUFFIX[dir]}.svg`;
}

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
      'Optimised for the Archaeologist phase - generates richer self-check prompts.',
    perk: 'Self-check prompt cap increases from 4 to 6.',
  },
] as const;

export function findPlayerClass(id: PlayerClassId | null | undefined): PlayerClassDefinition | null {
  if (!id) return null;
  return PLAYER_CLASSES.find((c) => c.id === id) ?? null;
}
