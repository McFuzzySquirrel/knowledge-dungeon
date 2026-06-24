import { describe, expect, it } from 'vitest';
import {
  evaluateReviewUnlock,
  extractMarkdownHeadings,
  generateSelfCheckPrompts,
} from '@/core/review';
import {
  makeEmptyRoomMetadata,
  type DungeonMetadata,
  type RoomMetadata,
} from '@/core/validation/persistence';

function dungeonWithRooms(roomIds: string[]): DungeonMetadata {
  return {
    schemaVersion: '1.0.0',
    dungeonId: 'd1',
    subjectName: 'Subject',
    createdAt: 'iso',
    updatedAt: 'iso',
    phaseState: 'ScribeActive',
    rootRoomId: roomIds[0],
    rooms: roomIds.map((id) => ({ roomId: id, topic: `Topic ${id}`, status: 'Created' })),
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
}

function roomMap(ids: string[], finalPassIds: string[] = []): Record<string, RoomMetadata> {
  const map: Record<string, RoomMetadata> = {};
  for (const id of ids) {
    const meta = makeEmptyRoomMetadata({ roomId: id, topic: `Topic ${id}`, nowIso: 'iso' });
    if (finalPassIds.includes(id)) {
      meta.state = 'ArtifactCollected';
      meta.validationState.finalPass = true;
    }
    map[id] = meta;
  }
  return map;
}

describe('reviewDomain', () => {
  it('unlocks only when all rooms are cleared', () => {
    const dungeon = dungeonWithRooms(['a', 'b']);
    const partial = evaluateReviewUnlock({
      dungeon,
      rooms: roomMap(['a', 'b'], ['a']),
    });
    expect(partial.unlocked).toBe(false);

    const full = evaluateReviewUnlock({
      dungeon,
      rooms: roomMap(['a', 'b'], ['a', 'b']),
    });
    expect(full.unlocked).toBe(true);
  });

  it('generates self-check prompts capped by maxPromptCount', () => {
    const prompts = generateSelfCheckPrompts({
      roomId: 'room-1',
      subjectName: 'Subject',
      roomTopic: 'Topic A',
      noteHeadings: ['Summary', 'Key Points'],
      relatedTopics: ['Topic B'],
      maxPromptCount: 3,
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]?.source).toBe('topic');
  });

  it('extracts unique markdown headings', () => {
    const headings = extractMarkdownHeadings('# A\n## B\n## B\nNo heading');
    expect(headings).toEqual(['A', 'B']);
  });
});
