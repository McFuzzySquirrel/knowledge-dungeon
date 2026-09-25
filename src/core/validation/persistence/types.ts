/**
 * Core domain types shared across the validation, graph, progression,
 * artifacts, and review modules. Ported verbatim from mindmap-dungeon.
 */

export const CURRENT_SCHEMA_VERSION = '1.1.0';

/**
 * Version identifiers are three separate contracts and must never be
 * interchanged (plan section 12, rule 4):
 *
 * - the **subject schema version** below, which describes a subject snapshot;
 * - the **storage generation version**, declared by the storage-v2 schema
 *   module, which describes the shape of an IndexedDB generation;
 * - the **data product format version** below, which describes a `.kdbak`,
 *   `.kdsubject`, or `.kdtemplate` archive.
 */
export type SubjectSchemaVersion = typeof CURRENT_SCHEMA_VERSION;

/** Which data product a versioned archive carries. */
export type DataProductKind = 'kdbak' | 'kdsubject' | 'kdtemplate';

/**
 * Data product format versions, one per product. These describe the archive
 * layout only; they are not subject schema versions and not storage generation
 * versions. Phases 5-7 own the payloads and may bump these independently.
 */
export const DATA_PRODUCT_FORMAT_VERSIONS: Readonly<Record<DataProductKind, number>> = {
  kdbak: 1,
  kdsubject: 1,
  kdtemplate: 1,
};

/**
 * Manifest written as the first member of a `.kdbak` or `.kdsubject` archive.
 *
 * Deliberately carries counts, versions, and checksums only. It never carries a
 * subject name, a topic, a note, a filename, or any other learner value.
 */
export interface DataProductManifest {
  product: DataProductKind;
  formatVersion: number;
  subjectSchemaVersion: string;
  createdAt: string;
  memberCount: number;
  totalBytes: number;
  contentChecksum: string;
}

export const PHASE_STATES = [
  'SubjectCreated',
  'CreatorActive',
  'CreatorComplete',
  'ScribeActive',
  'ScribePartial',
  'ScribeComplete',
  'ArchaeologistUnlocked',
  'ArchaeologistActive',
  'SubjectMastered',
] as const;

export const ROOM_STATES = [
  'Uncreated',
  'Created',
  'Visited',
  'NotesDrafted',
  'EncounterDefeated',
  'ArtifactCollected',
  'NeedsRevalidation',
] as const;

export const EDGE_RELATION_TYPES = [
  'prerequisite',
  'subtopic',
  'analogy',
  'depends_on',
  'related',
] as const;

export const EDGE_PHASES = ['Creator', 'Scribe', 'Archaeologist'] as const;

export const QUALITY_SCORE_KEYS = [
  'sectionCompleteness',
  'conceptTermCoverage',
  'linkReferences',
  'recallQuestionQuality',
  'clarityReadability',
] as const;

export type PhaseState = (typeof PHASE_STATES)[number];
export type RoomState = (typeof ROOM_STATES)[number];
export type EdgeRelationType = (typeof EDGE_RELATION_TYPES)[number];
export type EdgeCreatedByPhase = (typeof EDGE_PHASES)[number];
export type QualityScoreKey = (typeof QUALITY_SCORE_KEYS)[number];

export type CriterionScores = Record<QualityScoreKey, number>;

export interface RoomAttachment {
  attachmentId: string;
  sourceType: 'local' | 'external';
  fileName: string;
  mimeType: string;
  relativePath?: string;
  externalUrl?: string;
  altText?: string;
  addedAt: string;
}

export interface ValidationState {
  wordCount: number;
  requiredSectionsPresent: boolean;
  manualConfirmed: boolean;
  criterionScores: CriterionScores;
  failedChecks: string[];
  qualityBonus: number;
  finalPass: boolean;
}

export interface RoomMetadata {
  roomId: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  state: RoomState;
  notePath: string;
  artifactPath: string;
  noteText: string;
  artifactMarkdown: string | null;
  validationState: ValidationState;
  reviewPassCount: number;
  attachments: RoomAttachment[];
  /** Phase 4a: SM-2 spaced repetition fields. */
  sm2QualityResponse?: number;
  sm2EaseFactor?: number;
  sm2IntervalDays?: number;
  sm2NextReviewDate?: string;
  sm2ConsecutiveCorrect?: number;
  /** Phase 4f: tags assigned to this room. */
  tags?: string[];
}

export interface DungeonRoomSummary {
  roomId: string;
  topic: string;
  status: RoomState;
}

export interface DungeonEdge {
  fromRoomId: string;
  toRoomId: string;
  relationType: EdgeRelationType;
  createdAt: string;
  createdByPhase: EdgeCreatedByPhase;
}

/** A single caught fish entry for persistence. */
export interface FishEntry {
  id: string;
  name: string;
  rarity: 'common' | 'rare' | 'epic';
  subjectId: string;
  subjectName: string;
  caughtAt: string;
}

export interface ProgressionSnapshot {
  xpTotal: number;
  rank: string;
  badges: string[];
  /** Fisher's Rest: fish caught by the player. */
  fishCollection: FishEntry[];
}

export interface DungeonMetadata {
  schemaVersion: string;
  dungeonId: string;
  subjectName: string;
  createdAt: string;
  updatedAt: string;
  phaseState: PhaseState;
  rootRoomId: string;
  rooms: DungeonRoomSummary[];
  edges: DungeonEdge[];
  progression: ProgressionSnapshot;
  /** Phase 4c: Custom biome for this subject. */
  biome?: string;
  /** Phase 4f: Cross-subject tag index (tag → roomIds). */
  tagIndex?: Record<string, string[]>;
}

export interface SubjectSnapshot {
  dungeon: DungeonMetadata;
  rooms: Record<string, RoomMetadata>;
}

export interface AppSettings {
  schemaVersion: string;
  theme: 'cozy' | 'classic' | 'high-contrast';
  textStyle: 'serif' | 'sans' | 'dyslexia-friendly';
  reducedMotion: boolean;
}

export function makeEmptyValidationState(): ValidationState {
  return {
    wordCount: 0,
    requiredSectionsPresent: false,
    manualConfirmed: false,
    criterionScores: {
      sectionCompleteness: 0,
      conceptTermCoverage: 0,
      linkReferences: 0,
      recallQuestionQuality: 0,
      clarityReadability: 0,
    },
    failedChecks: [],
    qualityBonus: 0,
    finalPass: false,
  };
}

export function makeEmptyRoomMetadata(args: {
  roomId: string;
  topic: string;
  nowIso: string;
}): RoomMetadata {
  return {
    roomId: args.roomId,
    topic: args.topic,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    state: 'Created',
    notePath: `rooms/${args.roomId}/notes.txt`,
    artifactPath: `rooms/${args.roomId}/artifact.md`,
    noteText: '',
    artifactMarkdown: null,
    validationState: makeEmptyValidationState(),
    reviewPassCount: 0,
    attachments: [],
  };
}
