import type { JSX } from 'react';
import type { DungeonMap } from '@/game/systems/dungeonTypes';
import type { ColorTheme } from '@/store/preferencesStore';

interface MinimapProps {
  dungeonMap: DungeonMap;
  focusedRoomId: string | null;
  colorTheme?: ColorTheme;
  /**
   * Optional set of room IDs the player can currently see. When provided the
   * minimap only renders rooms / corridors inside this set, keeping the
   * minimap consistent with the in-game floor isolation.
   */
  visibleRoomIds?: ReadonlySet<string>;
  /** Direct parent of the current floor (used for portal-up styling). */
  portalUpRoomId?: string | null;
  /** Direct children that are entries to other floors. */
  portalDownRoomIds?: ReadonlySet<string>;
}

const SCALE = 4;

const MINIMAP_PALETTE: Record<
  ColorTheme,
  {
    corridorConnected: string;
    corridorPortal: string;
    corridorDefault: string;
    roomPortalFill: string;
    roomFocusedFill: string;
    roomNeighborFill: string;
    roomRootFill: string;
    roomDefaultFill: string;
    roomPortalStroke: string;
    roomNeighborStroke: string;
    roomDefaultStroke: string;
  }
> = {
  dark: {
    corridorConnected: '#7be3ff',
    corridorPortal: '#b48cff',
    corridorDefault: '#4f679f',
    roomPortalFill: '#263c68',
    roomFocusedFill: '#7be3ff',
    roomNeighborFill: '#c7b2ff',
    roomRootFill: '#8fc1ff',
    roomDefaultFill: '#22345d',
    roomPortalStroke: '#b48cff',
    roomNeighborStroke: '#7be3ff',
    roomDefaultStroke: '#4f679f',
  },
  colorful: {
    corridorConnected: '#ffcf5f',
    corridorPortal: '#7be3ff',
    corridorDefault: '#5f79c9',
    roomPortalFill: '#213865',
    roomFocusedFill: '#ffcf5f',
    roomNeighborFill: '#a6f0ff',
    roomRootFill: '#8db2ff',
    roomDefaultFill: '#1f315d',
    roomPortalStroke: '#7be3ff',
    roomNeighborStroke: '#ffcf5f',
    roomDefaultStroke: '#5f79c9',
  },
  aurora: {
    corridorConnected: '#9af7e5',
    corridorPortal: '#b48cff',
    corridorDefault: '#4f6cc7',
    roomPortalFill: '#273463',
    roomFocusedFill: '#9af7e5',
    roomNeighborFill: '#c9b3ff',
    roomRootFill: '#8fc1ff',
    roomDefaultFill: '#1f2f58',
    roomPortalStroke: '#b48cff',
    roomNeighborStroke: '#9af7e5',
    roomDefaultStroke: '#4f6cc7',
  },
};

export function Minimap({
  dungeonMap,
  focusedRoomId,
  colorTheme = 'dark',
  visibleRoomIds,
  portalUpRoomId,
  portalDownRoomIds,
}: MinimapProps): JSX.Element {
  const palette = MINIMAP_PALETTE[colorTheme];
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

  const isRoomVisible = (roomId: string): boolean =>
    !visibleRoomIds || visibleRoomIds.has(roomId);

  return (
    <div className="minimap" aria-label="Minimap" data-graphics="rpg">
      <svg width={Math.min(180, width)} height={Math.min(180, height)} viewBox={`0 0 ${width} ${height}`}>
        {dungeonMap.corridors.map((c, i) => {
          if (!isRoomVisible(c.fromRoomId) || !isRoomVisible(c.toRoomId)) return null;
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
          const isPortalEdge =
            c.fromRoomId === portalUpRoomId ||
            c.toRoomId === portalUpRoomId ||
            (portalDownRoomIds?.has(c.fromRoomId) ?? false) ||
            (portalDownRoomIds?.has(c.toRoomId) ?? false);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={
                isConnected
                  ? palette.corridorConnected
                  : isPortalEdge
                    ? palette.corridorPortal
                    : palette.corridorDefault
              }
              strokeWidth={isConnected ? 1.5 : 1}
              strokeLinecap="round"
              strokeDasharray={isPortalEdge ? '3 2' : undefined}
            />
          );
        })}
        {rooms.map((room) => {
          if (!isRoomVisible(room.roomId)) return null;
          const x = (room.gridX - bounds.minX) * SCALE;
          const y = (room.gridY - bounds.minY) * SCALE;
          const w = room.width * SCALE;
          const h = room.height * SCALE;
          const isFocused = room.roomId === focusedRoomId;
          const isNeighbor = neighborIds.has(room.roomId);
          const isPortal =
            room.roomId === portalUpRoomId ||
            (portalDownRoomIds?.has(room.roomId) ?? false);
          const rpgFill = isPortal
            ? palette.roomPortalFill
            : isFocused
              ? palette.roomFocusedFill
              : isNeighbor
                ? palette.roomNeighborFill
                : room.isRoot
                  ? palette.roomRootFill
                  : palette.roomDefaultFill;
          const fill = rpgFill;
          const stroke = isPortal
            ? palette.roomPortalStroke
            : isNeighbor && !isFocused
              ? palette.roomNeighborStroke
              : palette.roomDefaultStroke;
          const strokeWidth = isPortal || (isNeighbor && !isFocused) ? 1 : 0.5;
          return (
            <rect
              key={room.roomId}
              x={x}
              y={y}
              width={w}
              height={h}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          );
        })}
      </svg>
      <div className="minimap-legend" aria-label="Minimap legend">
        <span><i className="minimap-legend-swatch minimap-legend-swatch--focus" /> Focused room</span>
        <span><i className="minimap-legend-swatch minimap-legend-swatch--neighbor" /> Connected room</span>
        <span><i className="minimap-legend-swatch minimap-legend-swatch--portal" /> Portal room / floor link</span>
      </div>
    </div>
  );
}
