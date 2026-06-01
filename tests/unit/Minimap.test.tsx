import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Minimap } from '@/ui/components/Minimap';
import type { DungeonMap } from '@/game/systems/dungeonTypes';

const dungeonMap: DungeonMap = {
  seed: 'test-seed',
  tileSize: 32,
  rootRoomId: 'root',
  bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  rooms: [
    {
      roomId: 'root',
      topic: 'Root',
      gridX: 1,
      gridY: 1,
      width: 3,
      height: 3,
      isRoot: true,
      status: 'Visited',
    },
    {
      roomId: 'child',
      topic: 'Child',
      gridX: 6,
      gridY: 6,
      width: 3,
      height: 3,
      isRoot: false,
      status: 'Visited',
    },
  ],
  corridors: [
    {
      fromRoomId: 'root',
      toRoomId: 'child',
      relationType: 'subtopic',
      fromDoor: { roomId: 'root', side: 'E', x: 3, y: 2 },
      toDoor: { roomId: 'child', side: 'W', x: 6, y: 7 },
      pathTiles: [],
      segments: [],
      elbow: null,
    },
  ],
  doors: [
    { roomId: 'root', side: 'E', x: 3, y: 2 },
    { roomId: 'child', side: 'W', x: 6, y: 7 },
  ],
  walkable: {
    width: 11,
    height: 11,
    offsetX: 0,
    offsetY: 0,
    data: new Uint8Array(11 * 11).fill(1),
  },
};

describe('Minimap rendering', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('draws rooms as rectangular chambers', () => {
    const { container } = render(<Minimap dungeonMap={dungeonMap} focusedRoomId={null} />);
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('ellipse').length).toBe(0);
    expect(screen.getByText(/Focused room/i)).toBeInTheDocument();
  });
});
