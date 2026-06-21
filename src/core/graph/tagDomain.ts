/**
 * Tag Domain — tag management for room metadata.
 *
 * Phase 4f: Tag system for cross-subject topic linking.
 * Provides tag indexing, search, and cross-subject navigation helpers.
 */

import type { DungeonMetadata, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';

/**
 * Rebuild the tag index from room metadata.
 * The tag index maps each tag to the list of roomIds that have it.
 */
export function rebuildTagIndex(snapshot: SubjectSnapshot): Record<string, string[]> {
  const tagIndex: Record<string, string[]> = {};

  for (const room of Object.values(snapshot.rooms)) {
    const tags = room.tags ?? [];
    for (const tag of tags) {
      const normalized = normalizeTag(tag);
      if (normalized.length === 0) continue;
      if (!tagIndex[normalized]) {
        tagIndex[normalized] = [];
      }
      if (!tagIndex[normalized].includes(room.roomId)) {
        tagIndex[normalized].push(room.roomId);
      }
    }
  }

  return tagIndex;
}

/**
 * Normalize a tag string for consistent indexing.
 */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/**
 * Set tags on a room and update the tag index on the dungeon metadata.
 */
export function setRoomTags(
  snapshot: SubjectSnapshot,
  roomId: string,
  tags: string[],
): { room: RoomMetadata; dungeon: DungeonMetadata } {
  const room = snapshot.rooms[roomId];
  if (!room) throw new Error(`Room not found: ${roomId}`);

  const normalizedTags = tags.map(normalizeTag).filter((t) => t.length > 0);
  const uniqueTags = [...new Set(normalizedTags)];

  const updatedRoom: RoomMetadata = {
    ...room,
    tags: uniqueTags,
    updatedAt: new Date().toISOString(),
  };

  const updatedRooms = { ...snapshot.rooms, [roomId]: updatedRoom };
  const updatedTagIndex = rebuildTagIndex({ dungeon: snapshot.dungeon, rooms: updatedRooms });

  const updatedDungeon: DungeonMetadata = {
    ...snapshot.dungeon,
    tagIndex: updatedTagIndex,
    updatedAt: new Date().toISOString(),
  };

  return { room: updatedRoom, dungeon: updatedDungeon };
}

/**
 * Find all rooms across all loaded subjects that match a tag.
 */
export function findRoomsByTag(
  snapshots: SubjectSnapshot[],
  tag: string,
): Array<{ subjectId: string; subjectName: string; roomId: string; topic: string }> {
  const normalized = normalizeTag(tag);
  if (normalized.length === 0) return [];

  const results: Array<{ subjectId: string; subjectName: string; roomId: string; topic: string }> = [];

  for (const snapshot of snapshots) {
    const tagIndex = snapshot.dungeon.tagIndex ?? {};
    const roomIds = tagIndex[normalized] ?? [];
    for (const roomId of roomIds) {
      const room = snapshot.rooms[roomId];
      if (room) {
        results.push({
          subjectId: snapshot.dungeon.dungeonId,
          subjectName: snapshot.dungeon.subjectName,
          roomId: room.roomId,
          topic: room.topic,
        });
      }
    }
  }

  return results;
}

/**
 * Get the set of all unique tags across all rooms in a snapshot.
 */
export function getAllTags(snapshot: SubjectSnapshot): string[] {
  const tags = new Set<string>();

  for (const room of Object.values(snapshot.rooms)) {
    for (const tag of room.tags ?? []) {
      const normalized = normalizeTag(tag);
      if (normalized.length > 0) tags.add(normalized);
    }
  }

  return [...tags].sort();
}

/**
 * Add a single tag to a room and return updated state.
 */
export function addRoomTag(
  snapshot: SubjectSnapshot,
  roomId: string,
  tag: string,
): { room: RoomMetadata; dungeon: DungeonMetadata } {
  const room = snapshot.rooms[roomId];
  if (!room) throw new Error(`Room not found: ${roomId}`);

  const currentTags = room.tags ?? [];
  const normalized = normalizeTag(tag);
  if (normalized.length === 0) return { room, dungeon: snapshot.dungeon };

  if (currentTags.some((t) => normalizeTag(t) === normalized)) {
    return { room, dungeon: snapshot.dungeon };
  }

  return setRoomTags(snapshot, roomId, [...currentTags, tag]);
}

/**
 * Remove a tag from a room and return updated state.
 */
export function removeRoomTag(
  snapshot: SubjectSnapshot,
  roomId: string,
  tag: string,
): { room: RoomMetadata; dungeon: DungeonMetadata } {
  const room = snapshot.rooms[roomId];
  if (!room) throw new Error(`Room not found: ${roomId}`);

  const normalized = normalizeTag(tag);
  const currentTags = room.tags ?? [];
  const filtered = currentTags.filter((t) => normalizeTag(t) !== normalized);

  if (filtered.length === currentTags.length) {
    return { room, dungeon: snapshot.dungeon };
  }

  return setRoomTags(snapshot, roomId, filtered);
}
