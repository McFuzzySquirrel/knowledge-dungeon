import type { SubjectSnapshot } from '@/core/validation/persistence';
import { CURRENT_SCHEMA_VERSION } from '@/core/validation/persistence';

const TUTORIAL_ID = 'tutorial-first-walkthrough';
const ROOT_ROOM_ID = 'tut-note';
const ROOM_ATTACHMENTS_ID = 'tut-tools';
const ROOM_MAP_ID = 'tut-map';

export function createTutorialSubject(): SubjectSnapshot {
  const now = new Date().toISOString();

  return {
    dungeon: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dungeonId: TUTORIAL_ID,
      subjectName: 'First Dungeon (Tutorial)',
      createdAt: now,
      updatedAt: now,
      phaseState: 'CreatorActive',
      rootRoomId: ROOT_ROOM_ID,
      rooms: [
        { roomId: ROOT_ROOM_ID, topic: 'The Note', status: 'Created' },
        { roomId: ROOM_ATTACHMENTS_ID, topic: 'Tools of the Trade', status: 'Created' },
        { roomId: ROOM_MAP_ID, topic: 'The Map & Beyond', status: 'Created' },
      ],
      edges: [
        {
          fromRoomId: ROOT_ROOM_ID,
          toRoomId: ROOM_ATTACHMENTS_ID,
          relationType: 'subtopic',
          createdAt: now,
          createdByPhase: 'Creator',
        },
        {
          fromRoomId: ROOT_ROOM_ID,
          toRoomId: ROOM_MAP_ID,
          relationType: 'subtopic',
          createdAt: now,
          createdByPhase: 'Creator',
        },
      ],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      [ROOT_ROOM_ID]: {
        roomId: ROOT_ROOM_ID,
        topic: 'The Note',
        createdAt: now,
        updatedAt: now,
        state: 'Created',
        notePath: '',
        artifactPath: '',
        noteText: '',
        artifactMarkdown: null,
        validationState: {
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
        },
        reviewPassCount: 0,
        attachments: [],
      },
      [ROOM_ATTACHMENTS_ID]: {
        roomId: ROOM_ATTACHMENTS_ID,
        topic: 'Tools of the Trade',
        createdAt: now,
        updatedAt: now,
        state: 'Created',
        notePath: '',
        artifactPath: '',
        noteText: '',
        artifactMarkdown: null,
        validationState: {
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
        },
        reviewPassCount: 0,
        attachments: [],
      },
      [ROOM_MAP_ID]: {
        roomId: ROOM_MAP_ID,
        topic: 'The Map & Beyond',
        createdAt: now,
        updatedAt: now,
        state: 'Created',
        notePath: '',
        artifactPath: '',
        noteText: '',
        artifactMarkdown: null,
        validationState: {
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
        },
        reviewPassCount: 0,
        attachments: [],
      },
    },
  };
}

export const TUTORIAL_SUBJECT_ID = TUTORIAL_ID;
