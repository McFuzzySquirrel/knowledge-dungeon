import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, type SubjectSnapshot } from '@/core/validation/persistence';
import { exportSubjectToJson, importSubjectFromJson } from '@/services/persistence/subjectPersistence';

function makeSnapshot(): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      dungeonId: 'subject-1',
      subjectName: 'Linear Algebra',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: 'room-1',
      rooms: [{ roomId: 'room-1', topic: 'Vectors', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-1': {
        roomId: 'room-1',
        topic: 'Vectors',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        state: 'Created',
        notePath: 'rooms/room-1/notes.md',
        artifactPath: 'rooms/room-1/artifact.md',
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

describe('subjectPersistence import/export JSON', () => {
  it('round-trips a valid subject snapshot', () => {
    const snapshot = makeSnapshot();
    const json = exportSubjectToJson(snapshot);

    expect(importSubjectFromJson(json)).toEqual(snapshot);
  });

  it('rejects unsupported schema versions', () => {
    const snapshot = makeSnapshot();
    snapshot.dungeon.schemaVersion = '0.9.0';

    expect(() => importSubjectFromJson(JSON.stringify(snapshot))).toThrow(/Unsupported subject schema version/i);
  });

  it('rejects malformed room mappings', () => {
    const snapshot = makeSnapshot();
    delete snapshot.rooms['room-1'];

    expect(() => importSubjectFromJson(JSON.stringify(snapshot))).toThrow(/missing room payload/i);
  });

  it('rejects invalid top-level payload shape', () => {
    expect(() => importSubjectFromJson(JSON.stringify({ ok: true }))).toThrow(/Invalid subject snapshot format/i);
  });
});
