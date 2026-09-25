/**
 * Renderer-neutral world event contract.
 *
 * A renderer host emits these named events and the application layer reacts to
 * them. The payload map below is the single source of truth: `WorldEventName`,
 * `WorldEventPayload`, `WorldEvent`, and `WorldEventHandlers` are all derived
 * from it, so a payload change cannot leave a handler or a scene callback
 * untyped.
 *
 * The current Phaser scenes emit these shapes through their `*SceneEvents`
 * callback objects (which are derived from the mapped `WorldEventHandlers` type
 * below); the future PixiJS host pushes the same shapes into a `WorldEventSink`.
 */
import type { FishRarity } from '@/core/fishing/fishingTypes';

/** Direction of a dungeon floor change, driven by a portal the player stands on. */
export type FloorTransitionDirection = 'up' | 'down';

/**
 * Payload of every renderer-neutral world event, keyed by event name.
 * Add new events here and every host/handler pair picks them up automatically.
 */
export interface WorldEventPayloadMap {
  // ── Dungeon ────────────────────────────────────────────────────────────
  'dungeon:room-entered': { roomId: string };
  'dungeon:npc-interact': { roomId: string; clientX: number; clientY: number };
  'dungeon:npc-dialog-position': { roomId: string; clientX: number; clientY: number };
  'dungeon:npc-out-of-range': { roomId: string };
  'dungeon:interact': { roomId: string };
  'dungeon:artifact-collected': { roomId: string };
  'dungeon:floor-transition': {
    fromRoomId: string;
    direction: FloorTransitionDirection;
  };

  // ── Village ────────────────────────────────────────────────────────────
  'village:structure-approached': { structureId: string };
  'village:structure-left': { structureId: string };
  'village:structure-interact': { structureId: string };
  'village:npc-approached': { npcId: string };
  'village:npc-left': { npcId: string };
  'village:npc-interact': { npcId: string };
  'village:npc-dialog-position': { npcId: string; clientX: number; clientY: number };
  /** Zero-payload event: the host is ready. */
  'village:ready': void;

  // ── Fishing ────────────────────────────────────────────────────────────
  'fishing:fish-caught': {
    fishName: string;
    rarity: FishRarity;
    catalogId: string;
    description: string;
  };
  /** Zero-payload event: the player asked to return to the village. */
  /** Zero-payload event: the player asked to return to the village. */
  'fishing:return-to-village': void;
  /** Zero-payload event: the fishing world is ready. */
  'fishing:ready': void;
}

/** Every renderer-neutral event name. */
export type WorldEventName = keyof WorldEventPayloadMap;

/** Payload type for a single named event. */
export type WorldEventPayload<E extends WorldEventName> = WorldEventPayloadMap[E];

/**
 * A single field of an event payload, for hosts whose callback historically
 * received one field instead of the whole payload object. Deriving the
 * parameter this way keeps the callback tied to the contract: change the
 * contract field and every renderer callback signature follows.
 */
export type WorldEventPayloadField<
  E extends WorldEventName,
  K extends keyof WorldEventPayloadMap[E],
> = WorldEventPayloadMap[E][K];

/** The handler type the contract declares for an event, ignoring optionality. */
export type WorldEventHandler<E extends WorldEventName> = NonNullable<WorldEventHandlers[E]>;

/** A tagged event; renderers either call handlers directly or emit this. */
export type WorldEvent = {
  [E in WorldEventName]: { type: E; payload: WorldEventPayloadMap[E] };
}[WorldEventName];

/**
 * A handler bag keyed by event name. Every handler receives exactly the payload
 * of its own event, so a renderer host and the application layer cannot drift.
 */
export type WorldEventHandlers = {
  [E in WorldEventName]?: (payload: WorldEventPayload<E>) => void;
};

/**
 * Single funnel any renderer can push events into, e.g. a PixiJS host that owns
 * one bus instead of a callback object.
 */
export type WorldEventSink = (event: WorldEvent) => void;

/**
 * Bind a handler bag to a sink, so a host can emit a tagged event and the mapped
 * handler still receives only its own payload.
 */
export function createWorldEventSink(handlers: WorldEventHandlers): WorldEventSink {
  return (event: WorldEvent) => {
    const handler = handlers[event.type] as ((payload: WorldEventPayload<WorldEventName>) => void) | undefined;
    handler?.(event.payload);
  };
}
