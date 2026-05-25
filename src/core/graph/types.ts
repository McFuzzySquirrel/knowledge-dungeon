import type {
  DungeonMetadata,
  DungeonRoomSummary,
  EdgeCreatedByPhase,
  EdgeRelationType,
  PhaseState,
  RoomState,
} from '@/core/validation/persistence';

export interface GraphDomainError {
  code:
    | 'ROOM_NOT_FOUND'
    | 'ROOM_ALREADY_EXISTS'
    | 'TOPIC_ALREADY_EXISTS'
    | 'EDGE_ALREADY_EXISTS'
    | 'SELF_LOOP_EDGE'
    | 'EMPTY_TOPIC'
    | 'INVALID_OPERATION';
  message: string;
  details?: Record<string, unknown>;
}

export type GraphDomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GraphDomainError };

export interface RootDungeonInitInput {
  dungeonId: string;
  subjectName: string;
  rootRoomId: string;
  rootTopic: string;
  nowIso: string;
}

export interface LinkedRoomDraft {
  roomId: string;
  topic: string;
  relationType?: EdgeRelationType;
}

export interface AddLinkedRoomsInput {
  fromRoomId: string;
  drafts: readonly LinkedRoomDraft[];
  nowIso: string;
  createdByPhase?: EdgeCreatedByPhase;
}

export interface AddLinkedRoomsOutput {
  dungeon: DungeonMetadata;
  createdRoomIds: string[];
  touchedRoomIds: string[];
}

export interface AddCrossLinkInput {
  fromRoomId: string;
  toRoomId: string;
  relationType?: EdgeRelationType;
  nowIso: string;
  createdByPhase?: EdgeCreatedByPhase;
}

export interface AddCrossLinkOutput {
  dungeon: DungeonMetadata;
  touchedRoomIds: string[];
}

export interface CreatorTraversalSnapshot {
  roomIdsByStatus: Record<RoomState, string[]>;
  visitedRoomIds: string[];
  unvisitedRoomIds: string[];
  unresolvedRoomIds: string[];
  revalidationNeededRoomIds: string[];
}

export interface RevalidationPropagationInput {
  dungeon: DungeonMetadata;
  touchedRoomIds: readonly string[];
  nowIso: string;
}

export interface RevalidationPropagationOutput {
  dungeon: DungeonMetadata;
  impactedRoomIds: string[];
  revalidatedRoomIds: string[];
}

export interface TopicSuggestionInput {
  sourceTopic: string;
  existingRooms: readonly DungeonRoomSummary[];
  maxSuggestions?: number;
}

export const SCRIBE_STARTED_PHASES: readonly PhaseState[] = [
  'ScribeActive',
  'ScribePartial',
  'ScribeComplete',
  'ArchaeologistUnlocked',
  'ArchaeologistActive',
  'SubjectMastered',
] as const;
