import type { DungeonMap } from './dungeonGenerator';
export type { DungeonMap, DungeonRoom, DungeonCorridor } from './dungeonGenerator';

export interface MinimapSnapshot {
  rooms: { roomId: string; gridX: number; gridY: number; status: string }[];
  bounds: DungeonMap['bounds'];
}
