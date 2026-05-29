import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { Minimap } from '@/ui/components/Minimap';
import { usePreferencesStore } from '@/store/preferencesStore';
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
  corridors: [{ fromRoomId: 'root', toRoomId: 'child', relationType: 'subtopic' }],
};

describe('Minimap graphics mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('draws rooms as ellipses in mind-map mode', () => {
    usePreferencesStore.setState({ graphicsMode: 'mindmap' });
    const { container } = render(<Minimap dungeonMap={dungeonMap} focusedRoomId={null} />);
    expect(container.querySelectorAll('ellipse').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('rect').length).toBe(0);
  });

  it('draws rooms as rectangular chambers in RPG mode', () => {
    usePreferencesStore.setState({ graphicsMode: 'rpg' });
    const { container } = render(<Minimap dungeonMap={dungeonMap} focusedRoomId={null} />);
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('ellipse').length).toBe(0);
  });
});
