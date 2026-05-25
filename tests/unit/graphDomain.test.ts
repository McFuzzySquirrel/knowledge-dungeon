import { describe, expect, it } from 'vitest';
import {
  addCrossLink,
  addLinkedRooms,
  createRootDungeon,
  deriveTraversalSnapshot,
  propagateRevalidationAfterGraphMutation,
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
      drafts: [{ roomId: 'room-a', topic: 'Subspaces' }],
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dungeon.rooms).toHaveLength(2);
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
});
