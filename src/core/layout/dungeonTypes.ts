import type { DungeonMap } from './dungeonGenerator';
export type {
  DungeonMap,
  DungeonRoom,
  DungeonCorridor,
  DungeonCorridorSegment,
  DungeonDoor,
  DungeonWalkable,
  DoorSide,
} from './dungeonGenerator';

export interface MinimapSnapshot {
  rooms: { roomId: string; gridX: number; gridY: number; status: string }[];
  bounds: DungeonMap['bounds'];
}
