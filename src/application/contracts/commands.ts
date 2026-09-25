/**
 * Renderer-neutral application command contract.
 *
 * Commands are the application layer's request vocabulary: a renderer or a DOM
 * control asks for something (`room/interact`, `floor/change`, `village/return`)
 * and the application layer decides what actually happens. One discriminated
 * union member per command, with the payload map as the single source of truth.
 */
import type { FloorTransitionDirection } from './events';

/** Payload of every application command, keyed by command name. */
export interface WorldCommandPayloadMap {
  /** Load a subject and make it the active subject for session + progression. */
  'subject/activate': { subjectId: string };
  /** Player pressed interact on a dungeon room. */
  'room/interact': { roomId: string };
  /** Player pressed interact on a village structure. */
  'structure/interact': { structureId: string };
  /** Player used a portal: change the active floor from the room it stands on. */
  'floor/change': { fromRoomId: string; direction: FloorTransitionDirection };
  /** Travel to a room, switching the active floor when required. */
  'floor/travel': { roomId: string };
  /** Record an artifact produced by clearing a room. */
  'artifact/collect': { roomId: string };
  /** Finish the review of a room and award review progression. */
  'review/complete': { roomId: string };
  /** Leave the dungeon and return to the village. */
  'village/return': void;
  /** Start fishing at a village pond. */
  'fishing/enter': { pondId: string };
  /** Leave the fishing world and return to the village. */
  'fishing/exit': void;
}

/** Every application command name. */
export type WorldCommandName = keyof WorldCommandPayloadMap;

/** Payload type for a single named command. */
export type WorldCommandPayload<C extends WorldCommandName> = WorldCommandPayloadMap[C];

/** A tagged command; `type` is the command name and `payload` its arguments. */
export type WorldCommand = {
  [C in WorldCommandName]: { type: C; payload: WorldCommandPayloadMap[C] };
}[WorldCommandName];
