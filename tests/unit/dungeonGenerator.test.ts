import { describe, expect, it } from 'vitest';
import { generateDungeonMap } from '@/game/systems/dungeonGenerator';
import { addLinkedRooms, createRootDungeon } from '@/core/graph';

const NOW = '2026-01-01T00:00:00.000Z';

describe('generateDungeonMap', () => {
  it('places the root room at the origin and adds children at adjacent cells', () => {
    const root = createRootDungeon({
      dungeonId: 's1',
      subjectName: 'Sub',
      rootRoomId: 'root',
      rootTopic: 'Root',
      nowIso: NOW,
    });
    if (!root.ok) throw new Error('init failed');
    const withChildren = addLinkedRooms(root.value, {
      fromRoomId: 'root',
      drafts: [
        { roomId: 'c1', topic: 'Child 1' },
        { roomId: 'c2', topic: 'Child 2' },
      ],
      nowIso: NOW,
    });
    if (!withChildren.ok) throw new Error('add failed');

    const map = generateDungeonMap(withChildren.value.dungeon);
    expect(map.rooms).toHaveLength(3);
    const rootRoom = map.rooms.find((r) => r.isRoot);
    expect(rootRoom).toBeTruthy();
    expect(rootRoom?.gridX).toBe(0);
    expect(rootRoom?.gridY).toBe(0);
    expect(map.corridors).toHaveLength(2);
  });

  it('is deterministic given the same seed', () => {
    const root = createRootDungeon({
      dungeonId: 's1',
      subjectName: 'Sub',
      rootRoomId: 'root',
      rootTopic: 'Root',
      nowIso: NOW,
    });
    if (!root.ok) throw new Error('init failed');
    const withChildren = addLinkedRooms(root.value, {
      fromRoomId: 'root',
      drafts: [
        { roomId: 'c1', topic: 'Child 1' },
        { roomId: 'c2', topic: 'Child 2' },
        { roomId: 'c3', topic: 'Child 3' },
      ],
      nowIso: NOW,
    });
    if (!withChildren.ok) throw new Error('add failed');

    const a = generateDungeonMap(withChildren.value.dungeon, 'fixed-seed');
    const b = generateDungeonMap(withChildren.value.dungeon, 'fixed-seed');
    expect(a.rooms.map((r) => `${r.roomId}:${r.gridX},${r.gridY}`)).toEqual(
      b.rooms.map((r) => `${r.roomId}:${r.gridX},${r.gridY}`),
    );
  });
});
