import { describe, expect, it } from 'vitest';
import {
  addLinkedRooms,
  computeFloorVisibility,
  createRootDungeon,
  deriveGraphHierarchy,
} from '@/core/graph';

const NOW = '2026-01-01T00:00:00.000Z';

function bootstrap() {
  const created = createRootDungeon({
    dungeonId: 'subject-1',
    subjectName: 'Algebra',
    rootRoomId: 'room-root',
    rootTopic: 'Vector Spaces',
    nowIso: NOW,
  });
  if (!created.ok) throw new Error('failed to bootstrap');
  return created.value;
}

describe('graph navigation helpers', () => {
  it('derives breadcrumbs and floor assignments from subtopic edges', () => {
    const dungeon = bootstrap();
    const first = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [
        { roomId: 'room-a', topic: 'Matrices' },
        { roomId: 'room-b', topic: 'Eigenvalues' },
      ],
      nowIso: NOW,
    });
    if (!first.ok) throw new Error('first add failed');
    const second = addLinkedRooms(first.value.dungeon, {
      fromRoomId: 'room-a',
      drafts: [{ roomId: 'room-c', topic: 'Determinants' }],
      nowIso: NOW,
    });
    if (!second.ok) throw new Error('second add failed');

    const hierarchy = deriveGraphHierarchy(second.value.dungeon);
    expect(hierarchy.breadcrumbRoomIdsByRoomId['room-c']).toEqual([
      'room-root',
      'room-a',
      'room-c',
    ]);
    expect(hierarchy.floorIdByRoomId['room-c']).toBe('room-a');
    expect(hierarchy.roomIdsByFloorId['room-a']).toEqual(['room-c', 'room-a']);
  });

  it('computes per-floor visibility with portal-up and portal-down rooms', () => {
    const dungeon = bootstrap();
    const first = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [
        { roomId: 'room-a', topic: 'Matrices' },
        { roomId: 'room-b', topic: 'Eigenvalues' },
      ],
      nowIso: NOW,
    });
    if (!first.ok) throw new Error('first add failed');
    const second = addLinkedRooms(first.value.dungeon, {
      fromRoomId: 'room-a',
      drafts: [{ roomId: 'room-c', topic: 'Determinants' }],
      nowIso: NOW,
    });
    if (!second.ok) throw new Error('second add failed');
    const finalDungeon = second.value.dungeon;
    const hierarchy = deriveGraphHierarchy(finalDungeon);

    // Root floor: only the root room is native, with top-level subtopics
    // exposed as down-portals so the player can descend into each.
    const root = computeFloorVisibility(hierarchy, finalDungeon, 'room-root');
    expect([...root.floorRoomIds].sort()).toEqual(['room-root']);
    expect(root.portalUpRoomId).toBeNull();
    expect([...root.portalDownRoomIds].sort()).toEqual(['room-a', 'room-b']);
    expect([...root.visibleRoomIds].sort()).toEqual(['room-a', 'room-b', 'room-root']);

    // Sub-floor: contains the top-level subtopic + its descendants, with the
    // parent (root) exposed as a portal-up so the player can ascend.
    const subFloor = computeFloorVisibility(hierarchy, finalDungeon, 'room-a');
    expect([...subFloor.floorRoomIds].sort()).toEqual(['room-a', 'room-c']);
    expect(subFloor.portalUpRoomId).toBe('room-root');
    expect([...subFloor.portalDownRoomIds]).toEqual([]);
    expect([...subFloor.visibleRoomIds].sort()).toEqual([
      'room-a',
      'room-c',
      'room-root',
    ]);
  });
});
