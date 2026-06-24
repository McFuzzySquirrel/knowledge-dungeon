/**
 * Phase 5: Unit tests for error recovery service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  safeJsonParse,
  isValidSubjectData,
  checkSubjectIntegrity,
  backupSubjectData,
  quarantineCorruptData,
  safeLocalStorageSet,
  getStorageUsageKB,
  getStorageThreshold,
} from '@/services/errorRecovery';

const SUBJECT_KEY = 'knowledge-dungeon:v1:subject:test-subject';

function makeValidSubjectData(): string {
  return JSON.stringify({
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: 'test-subject',
      subjectName: 'Test Subject',
      rootRoomId: 'room-1',
      rooms: [{ roomId: 'room-1', topic: 'Root', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phaseState: 'CreatorActive',
    },
    rooms: {
      'room-1': {
        roomId: 'room-1',
        topic: 'Root',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: 'Created',
        notePath: 'rooms/room-1/notes.txt',
        artifactPath: 'rooms/room-1/artifact.md',
        noteText: '',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {},
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [],
      },
    },
  });
}

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(safeJsonParse('')).toBeNull();
  });
});

describe('isValidSubjectData', () => {
  it('accepts valid subject data', () => {
    const data = JSON.parse(makeValidSubjectData());
    expect(isValidSubjectData(data)).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidSubjectData(null)).toBe(false);
  });

  it('rejects data missing dungeon', () => {
    expect(isValidSubjectData({ rooms: {} })).toBe(false);
  });

  it('rejects data with missing dungeonId', () => {
    const data = JSON.parse(makeValidSubjectData());
    delete (data.dungeon as Record<string, unknown>).dungeonId;
    expect(isValidSubjectData(data)).toBe(false);
  });

  it('rejects data with missing rootRoomId', () => {
    const data = JSON.parse(makeValidSubjectData());
    delete (data.dungeon as Record<string, unknown>).rootRoomId;
    expect(isValidSubjectData(data)).toBe(false);
  });

  it('rejects data with missing rooms array', () => {
    const data = JSON.parse(makeValidSubjectData());
    delete (data.dungeon as Record<string, unknown>).rooms;
    expect(isValidSubjectData(data)).toBe(false);
  });
});

describe('checkSubjectIntegrity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('detects when no data exists', () => {
    const result = checkSubjectIntegrity('nonexistent');
    expect(result.recovered).toBe(false);
    expect(result.message).toContain('No saved data');
  });

  it('passes valid data', () => {
    const validData = makeValidSubjectData();
    localStorage.setItem(SUBJECT_KEY, validData);
    const result = checkSubjectIntegrity('test-subject');
    expect(result.recovered).toBe(true);
    expect(result.message).toContain('passed');
  });

  it('detects corrupt JSON data', () => {
    localStorage.setItem(SUBJECT_KEY, 'not-valid-json{{{');
    const result = checkSubjectIntegrity('test-subject');
    expect(result.recovered).toBe(false);
    expect(result.message).toContain('corrupt');
  });

  it('recovers from backup when primary is corrupt', () => {
    const validData = makeValidSubjectData();
    localStorage.setItem('knowledge-dungeon:backup:test-subject', validData);
    localStorage.setItem(SUBJECT_KEY, 'corrupt{{{');
    const result = checkSubjectIntegrity('test-subject');
    expect(result.recovered).toBe(true);
    expect(result.message).toContain('recovered from a backup');
    // Primary should be restored
    expect(localStorage.getItem(SUBJECT_KEY)).toBe(validData);
  });
});

describe('backupSubjectData', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('creates a backup under the backup key', () => {
    const data = makeValidSubjectData();
    backupSubjectData('test-subject', data);
    const backup = localStorage.getItem('knowledge-dungeon:backup:test-subject');
    expect(backup).toBe(data);
  });

  it('overwrites previous backup', () => {
    backupSubjectData('test-subject', 'old-data');
    backupSubjectData('test-subject', 'new-data');
    const backup = localStorage.getItem('knowledge-dungeon:backup:test-subject');
    expect(backup).toBe('new-data');
  });
});

describe('quarantineCorruptData', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('moves corrupt data to quarantine and removes from index', () => {
    const corruptData = 'corrupt{{{data';
    localStorage.setItem(SUBJECT_KEY, corruptData);
    localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['test-subject']));

    quarantineCorruptData('test-subject');

    expect(localStorage.getItem(SUBJECT_KEY)).toBeNull();
    expect(localStorage.getItem('knowledge-dungeon:corrupt:test-subject')).toBe(corruptData);
    const index = JSON.parse(localStorage.getItem('knowledge-dungeon:v1:subjects')!);
    expect(index).not.toContain('test-subject');
  });

  it('handles nonexistent data gracefully', () => {
    expect(() => quarantineCorruptData('nonexistent')).not.toThrow();
  });
});

describe('safeLocalStorageSet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sets a value and returns success', () => {
    const result = safeLocalStorageSet('test-key', 'test-value');
    expect(result.success).toBe(true);
    expect(localStorage.getItem('test-key')).toBe('test-value');
  });

  it('returns error for invalid operations', () => {
    // Simulate quota exceeded by mocking
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockImplementationOnce(() => {
      const err = new DOMException('Quota exceeded', 'QuotaExceededError');
      throw err;
    });

    const result = safeLocalStorageSet('key', 'value');
    expect(result.success).toBe(false);
    expect(result.error).toContain('quota');
    setItem.mockRestore();
  });
});

describe('getStorageUsageKB', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns 0 with no data', () => {
    expect(getStorageUsageKB()).toBe(0);
  });

  it('returns non-zero with data', () => {
    localStorage.setItem('knowledge-dungeon:test', 'x'.repeat(2000));
    expect(getStorageUsageKB()).toBeGreaterThan(0);
  });
});

describe('getStorageThreshold', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns ok for empty storage', () => {
    expect(getStorageThreshold()).toBe('ok');
  });

  it('returns warn or critical when approaching limit', () => {
    // Fill up to ~3MB
    const chunk = 'x'.repeat(50000);
    for (let i = 0; i < 55; i += 1) {
      try {
        localStorage.setItem(`knowledge-dungeon:fill-${i}`, chunk);
      } catch {
        break;
      }
    }
    const threshold = getStorageThreshold();
    expect(['warn', 'critical']).toContain(threshold);
  });
});
