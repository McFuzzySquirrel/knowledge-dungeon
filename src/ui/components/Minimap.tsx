import type { JSX } from 'react';
import type { DungeonMap } from '@/game/systems/dungeonTypes';

interface MinimapProps {
  dungeonMap: DungeonMap;
  focusedRoomId: string | null;
}

const SCALE = 4;

export function Minimap({ dungeonMap, focusedRoomId }: MinimapProps): JSX.Element {
  const { bounds, rooms } = dungeonMap;
  const width = (bounds.maxX - bounds.minX) * SCALE;
  const height = (bounds.maxY - bounds.minY) * SCALE;

  // Find neighbors (rooms directly connected to the focused room via any
  // edge). Used to highlight the focused room's "children" / connected
  // topics on the minimap.
  const neighborIds = new Set<string>();
  if (focusedRoomId) {
    for (const c of dungeonMap.corridors) {
      if (c.fromRoomId === focusedRoomId) neighborIds.add(c.toRoomId);
      else if (c.toRoomId === focusedRoomId) neighborIds.add(c.fromRoomId);
    }
  }

  return (
    <div className="minimap" aria-label="Minimap">
      <svg width={Math.min(180, width)} height={Math.min(180, height)} viewBox={`0 0 ${width} ${height}`}>
        {dungeonMap.corridors.map((c, i) => {
          const from = rooms.find((r) => r.roomId === c.fromRoomId);
          const to = rooms.find((r) => r.roomId === c.toRoomId);
          if (!from || !to) return null;
          const x1 = (from.gridX - bounds.minX + from.width / 2) * SCALE;
          const y1 = (from.gridY - bounds.minY + from.height / 2) * SCALE;
          const x2 = (to.gridX - bounds.minX + to.width / 2) * SCALE;
          const y2 = (to.gridY - bounds.minY + to.height / 2) * SCALE;
          const isConnected =
            focusedRoomId !== null &&
            (c.fromRoomId === focusedRoomId || c.toRoomId === focusedRoomId);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={isConnected ? '#f2c879' : '#3b455e'}
              strokeWidth={isConnected ? 1.5 : 1}
            />
          );
        })}
        {rooms.map((room) => {
          const x = (room.gridX - bounds.minX) * SCALE;
          const y = (room.gridY - bounds.minY) * SCALE;
          const w = room.width * SCALE;
          const h = room.height * SCALE;
          const isFocused = room.roomId === focusedRoomId;
          const isNeighbor = neighborIds.has(room.roomId);
          const fill = isFocused
            ? '#f2c879'
            : isNeighbor
              ? '#f7d99c'
              : room.isRoot
                ? '#7fb2ff'
                : '#1f2433';
          return (
            <rect
              key={room.roomId}
              x={x}
              y={y}
              width={w}
              height={h}
              fill={fill}
              stroke={isNeighbor && !isFocused ? '#f2c879' : '#a8b0c8'}
              strokeWidth={isNeighbor && !isFocused ? 1 : 0.5}
            />
          );
        })}
      </svg>
    </div>
  );
}
