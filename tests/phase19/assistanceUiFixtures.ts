/**
 * Phase 19 DOM fixtures: `SubjectSnapshot` values the assistance card can actually be rendered
 * from.
 *
 * The engine fixtures in `./support/fixtures.ts` are `AssistanceSubjectInput` - already reduced,
 * already numeric, and deliberately free of anything that looks like a stored record. They are the
 * right shape for testing the **engine** and the wrong shape for testing the **card**, because
 * `AssistanceCard` takes a `SubjectSnapshot` and runs the reduction itself. A test that skipped
 * the reduction would be testing a different component than the one that ships.
 *
 * So these build real snapshots: `rooms` as a record keyed by room id, `dungeon.edges` with
 * `createdAt`/`createdByPhase`, and a `validationState` the adapter reads.
 *
 * Everything is synthetic. No learner content, no real subject, no real room topic beyond
 * app-owned vocabulary.
 */
import {
  CURRENT_SCHEMA_VERSION,
  type DungeonMetadata,
  type RoomMetadata,
  type RoomState,
  type SubjectSnapshot,
  type ValidationState,
} from '@/core/validation/persistence/types';

/** A timestamp the whole file is measured against. Fixed, so nothing reads a clock. */
export const UI_NOW_ISO = '2026-03-15T12:00:00.000Z';

function validation(overrides: Partial<ValidationState> = {}): ValidationState {
  return {
    wordCount: 0,
    requiredSectionsPresent: true,
    failedChecks: [],
    criterionScores: {},
    finalPass: false,
    ...overrides,
  } as ValidationState;
}

/**
 * A well-formed `dungeon` block.
 *
 * Built through a real `DungeonMetadata` rather than an `as` cast, so a fixture cannot quietly
 * omit a field the adapter happens to read later - a cast would let this file compile against a
 * shape the type system has already rejected.
 */
function uiDungeon(overrides: Partial<DungeonMetadata> = {}): DungeonMetadata {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dungeonId: 'subject-a',
    subjectName: 'Synthetic Subject',
    createdAt: UI_NOW_ISO,
    updatedAt: UI_NOW_ISO,
    phaseState: 'CreatorActive',
    rootRoomId: 'room-a',
    rooms: [],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    ...overrides,
  };
}

export function uiRoom(overrides: Partial<RoomMetadata> = {}): RoomMetadata {
  return {
    roomId: 'room-a',
    topic: 'Algebra',
    createdAt: UI_NOW_ISO,
    updatedAt: UI_NOW_ISO,
    state: 'Created' as RoomState,
    notePath: '',
    artifactPath: '',
    noteText: '',
    artifactMarkdown: null,
    validationState: validation(),
    reviewPassCount: 0,
    attachments: [],
    ...overrides,
  };
}

/**
 * A one-room subject with no edges.
 *
 * `creator.missing-branch`'s clearest case, and chosen so the card has a suggestion to render:
 * an empty-DOM assertion over this fixture would be measuring nothing, which is the trap this
 * file's shape exists to avoid.
 */
export const UNBRANCHED_SNAPSHOT: SubjectSnapshot = {
  dungeon: uiDungeon({ dungeonId: 'subject-a', subjectName: 'Synthetic Subject' }),
  rooms: { 'room-a': uiRoom({ roomId: 'room-a', topic: 'Only Room' }) },
};

/** Nothing to suggest: every room cleared and validated, so no rule has anything to say. */
export const QUIET_SNAPSHOT: SubjectSnapshot = {
  dungeon: uiDungeon({
    dungeonId: 'subject-quiet',
    subjectName: 'Quiet Subject',
    edges: [
      {
        fromRoomId: 'room-a',
        toRoomId: 'room-b',
        relationType: 'subtopic',
        createdAt: UI_NOW_ISO,
        createdByPhase: 'Creator',
      },
    ],
  }),
  rooms: {
    'room-a': uiRoom({
      roomId: 'room-a',
      topic: 'Root Room',
      state: 'Cleared' as RoomState,
    }),
    'room-b': uiRoom({
      roomId: 'room-b',
      topic: 'Child Room',
      state: 'Cleared' as RoomState,
    }),
  },
};

/** Two rooms on one floor, so a card has more than one suggestion to order. */
export const TWO_SUGGESTION_SNAPSHOT: SubjectSnapshot = {
  dungeon: uiDungeon({ dungeonId: 'subject-two', subjectName: 'Two Suggestion Subject' }),
  rooms: {
    'room-a': uiRoom({ roomId: 'room-a', topic: 'Alpha', tags: ['shared'] }),
    'room-b': uiRoom({ roomId: 'room-b', topic: 'Beta', tags: ['shared'] }),
  },
};

/** A snapshot whose rooms the card cannot find, so every suggestion is unlocatable. */
export const NO_ROOMS_SNAPSHOT: SubjectSnapshot = {
  dungeon: uiDungeon({ dungeonId: 'subject-empty', subjectName: 'No Rooms Subject' }),
  rooms: {},
};