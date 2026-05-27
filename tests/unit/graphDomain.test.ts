import { describe, expect, it } from 'vitest';
import {
  addCrossLink,
  addLinkedRooms,
  createRootDungeon,
  deriveTraversalSnapshot,
  propagateRevalidationAfterGraphMutation,
  reparentRoom,
  removeRoom,
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

describe('graphDomain', () => {
  it('creates a root dungeon in CreatorActive phase', () => {
    const dungeon = bootstrap();
    expect(dungeon.phaseState).toBe('CreatorActive');
    expect(dungeon.rooms).toHaveLength(1);
    expect(dungeon.edges).toHaveLength(0);
  });

  it('adds linked rooms with subtopic edges', () => {
    const dungeon = bootstrap();
    const result = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [
        { roomId: 'room-a', topic: 'Subspaces' },
        { roomId: 'room-b', topic: 'Bases' },
      ],
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dungeon.rooms).toHaveLength(3);
    expect(result.value.createdRoomIds).toEqual(['room-a', 'room-b']);
    expect(result.value.dungeon.edges[0]?.relationType).toBe('subtopic');
  });

  it('rejects duplicate topics case-insensitively', () => {
    const dungeon = bootstrap();
    const result = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-x', topic: ' vector spaces ' }],
      nowIso: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOPIC_ALREADY_EXISTS');
  });

  it('adds cross links and rejects self loops', () => {
    const dungeon = bootstrap();
    const withChild = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-a', topic: 'Subspaces' }],
      nowIso: NOW,
    });
    if (!withChild.ok) throw new Error('setup failed');
    const cross = addCrossLink(withChild.value.dungeon, {
      fromRoomId: 'room-root',
      toRoomId: 'room-a',
      nowIso: NOW,
    });
    expect(cross.ok).toBe(false); // already exists from subtopic edge
    const selfLoop = addCrossLink(withChild.value.dungeon, {
      fromRoomId: 'room-root',
      toRoomId: 'room-root',
      nowIso: NOW,
    });
    expect(selfLoop.ok).toBe(false);
  });

  it('propagates revalidation only after Scribe started', () => {
    const dungeon = bootstrap();
    const result = propagateRevalidationAfterGraphMutation({
      dungeon,
      touchedRoomIds: ['room-root'],
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revalidatedRoomIds).toHaveLength(0);
  });

  it('derives a traversal snapshot with status buckets', () => {
    const dungeon = bootstrap();
    const snap = deriveTraversalSnapshot(dungeon);
    expect(snap.roomIdsByStatus.Created).toContain('room-root');
    expect(snap.unvisitedRoomIds).toContain('room-root');
  });

  it('removes a non-root room and any orphaned descendants', () => {
    const dungeon = bootstrap();
    const a = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-a', topic: 'Subspaces' }],
      nowIso: NOW,
    });
    if (!a.ok) throw new Error('add a failed');
    const b = addLinkedRooms(a.value.dungeon, {
      fromRoomId: 'room-a',
      drafts: [{ roomId: 'room-b', topic: 'Bases' }],
      nowIso: NOW,
    });
    if (!b.ok) throw new Error('add b failed');

    const removed = removeRoom(b.value.dungeon, { roomId: 'room-a', nowIso: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    // room-b is only reachable via room-a, so it should be cascade-removed.
    expect(removed.value.removedRoomIds).toEqual(['room-a', 'room-b']);
    expect(removed.value.dungeon.rooms.map((r) => r.roomId)).toEqual(['room-root']);
    expect(removed.value.dungeon.edges).toHaveLength(0);
  });

  it('refuses to remove the root room', () => {
    const dungeon = bootstrap();
    const result = removeRoom(dungeon, { roomId: 'room-root', nowIso: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_OPERATION');
  });

  it('keeps descendants that remain reachable via a cross-link when a room is removed', () => {
    const dungeon = bootstrap();
    const a = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-a', topic: 'A' }],
      nowIso: NOW,
    });
    if (!a.ok) throw new Error('add a failed');
    const b = addLinkedRooms(a.value.dungeon, {
      fromRoomId: 'room-a',
      drafts: [{ roomId: 'room-b', topic: 'B' }],
      nowIso: NOW,
    });
    if (!b.ok) throw new Error('add b failed');
    // Cross-link from root → b, so b stays reachable when a is removed.
    const linked = addCrossLink(b.value.dungeon, {
      fromRoomId: 'room-root',
      toRoomId: 'room-b',
      nowIso: NOW,
    });
    if (!linked.ok) throw new Error('cross-link failed');

    const removed = removeRoom(linked.value.dungeon, { roomId: 'room-a', nowIso: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removedRoomIds).toEqual(['room-a']);
    const remainingIds = removed.value.dungeon.rooms.map((r) => r.roomId).sort();
    expect(remainingIds).toEqual(['room-b', 'room-root']);
  });

  it('reparents a room without disconnecting it from the root', () => {
    const dungeon = bootstrap();
    const a = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-a', topic: 'A' }],
      nowIso: NOW,
    });
    if (!a.ok) throw new Error('add a failed');
    const b = addLinkedRooms(a.value.dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-b', topic: 'B' }],
      nowIso: NOW,
    });
    if (!b.ok) throw new Error('add b failed');

    const moved = reparentRoom(b.value.dungeon, {
      roomId: 'room-b',
      newParentRoomId: 'room-a',
      nowIso: NOW,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.previousParentRoomId).toBe('room-root');
    expect(
      moved.value.dungeon.edges.find((edge) => edge.toRoomId === 'room-b')?.fromRoomId,
    ).toBe('room-a');
  });

  it('refuses to reparent a room beneath one of its descendants', () => {
    const dungeon = bootstrap();
    const a = addLinkedRooms(dungeon, {
      fromRoomId: 'room-root',
      drafts: [{ roomId: 'room-a', topic: 'A' }],
      nowIso: NOW,
    });
    if (!a.ok) throw new Error('add a failed');
    const b = addLinkedRooms(a.value.dungeon, {
      fromRoomId: 'room-a',
      drafts: [{ roomId: 'room-b', topic: 'B' }],
      nowIso: NOW,
    });
    if (!b.ok) throw new Error('add b failed');

    const moved = reparentRoom(b.value.dungeon, {
      roomId: 'room-a',
      newParentRoomId: 'room-b',
      nowIso: NOW,
    });
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe('INVALID_OPERATION');
  });
});
