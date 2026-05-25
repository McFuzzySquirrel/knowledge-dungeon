import type {
  DungeonMetadata,
  RoomMetadata,
  RoomState,
} from '@/core/validation/persistence';

export const REVIEWABLE_ROOM_STATES = [
  'EncounterDefeated',
  'ArtifactCollected',
  'NeedsRevalidation',
] as const satisfies readonly RoomState[];

export interface ReviewUnlockInput {
  dungeon: DungeonMetadata;
  rooms: Record<string, RoomMetadata>;
  requiredCompletionRatio?: number;
}

export interface ReviewUnlockStatus {
  requiredCompletionRatio: number;
  completionRatio: number;
  totalRooms: number;
  clearedRooms: number;
  unlocked: boolean;
}

export interface SelfCheckPromptInput {
  roomId: string;
  subjectName: string;
  roomTopic: string;
  noteHeadings: readonly string[];
  relatedTopics: readonly string[];
  maxPromptCount?: number;
}

export interface SelfCheckPrompt {
  promptId: string;
  text: string;
  source: 'topic' | 'heading' | 'relation';
}

export interface ReviewAnalyticsSnapshot {
  reviewSessionCount: number;
  fullReviewPasses: number;
  currentReviewStreak: number;
  longestReviewStreak: number;
  reviewedRoomCount: number;
  totalReviewableRooms: number;
}
