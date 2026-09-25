import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importSubjectFromJson,
  loadSubjectSnapshot,
  STORAGE_KEYS,
} from '@/services/persistence/subjectPersistence';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/persistence/subject');
const FIXED_NOW = '2026-09-24T12:34:56.789Z';
const MINIMAL_V10_ID = 'subject-phase0-v100-minimal';
const MIGRATION_ID = 'subject-phase0-v100-migration';
const FULL_V10_ID = 'subject-phase0-v100-full';
const PARSEABLE_INVALID_ID = 'subject-phase0-parseable-invalid-v100';
const CORRUPT_ID = 'subject-phase0-corrupt';

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

describe('Phase 0 subject persistence characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    window.localStorage.clear();
    delete window.electronKnowledgeBridge;
  });

  afterEach(() => {
    window.localStorage.clear();
    delete window.electronKnowledgeBridge;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts a shallow 1.0.0 payload and applies the current 1.0.0 to 1.1.0 defaults', () => {
    const imported = importSubjectFromJson(readFixture('subject-1.0.0-minimal.json'));
    const room = imported.rooms['room-phase0-v100-minimal-root'];

    expect(imported.dungeon.dungeonId).toBe(MINIMAL_V10_ID);
    expect(imported.dungeon.schemaVersion).toBe('1.1.0');
    expect(Object.hasOwn(imported.dungeon, 'biome')).toBe(true);
    expect(imported.dungeon.biome).toBeUndefined();
    expect(imported.dungeon.tagIndex).toEqual({});
    expect(room).toMatchObject({
      sm2QualityResponse: 3,
      sm2EaseFactor: 2.5,
      sm2IntervalDays: 1,
      sm2NextReviewDate: FIXED_NOW,
      sm2ConsecutiveCorrect: 0,
      tags: [],
    });
  });

  it('accepts a 1.1.0 payload without changing its parsed shape', () => {
    const raw = readFixture('subject-1.1.0-minimal.json');
    const parsed = JSON.parse(raw) as unknown;

    expect(importSubjectFromJson(raw)).toEqual(parsed);
  });

  it('adds migration defaults only where 1.0.0 values are absent', () => {
    const imported = importSubjectFromJson(
      readFixture('subject-1.0.0-migration-defaults.json'),
    );
    const root = imported.rooms['room-phase0-v100-migration-root'];
    const branch = imported.rooms['room-phase0-v100-migration-branch'];

    expect(imported.dungeon.schemaVersion).toBe('1.1.0');
    expect(imported.dungeon.biome).toBeUndefined();
    expect(imported.dungeon.tagIndex).toEqual({});
    expect(root).toMatchObject({
      sm2QualityResponse: 3,
      sm2EaseFactor: 2.5,
      sm2IntervalDays: 1,
      sm2NextReviewDate: FIXED_NOW,
      sm2ConsecutiveCorrect: 0,
      tags: [],
      fixtureRoomField: 'preserve-this-synthetic-room-field',
    });
    expect(branch).toMatchObject({
      sm2QualityResponse: 5,
      sm2EaseFactor: 2.7,
      sm2IntervalDays: 6,
      sm2NextReviewDate: '2026-01-08T03:04:05.000Z',
      sm2ConsecutiveCorrect: 2,
      tags: ['synthetic-existing-tag'],
    });
  });

  it('distinguishes the raw localStorage loader from the importing migration path', async () => {
    const raw = readFixture('subject-1.0.0-full-unknown-fields.json');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    window.localStorage.setItem(STORAGE_KEYS.subject(FULL_V10_ID), raw);

    const loaded = await loadSubjectSnapshot(FULL_V10_ID);
    const imported = importSubjectFromJson(raw);

    expect(loaded).toEqual(parsed);
    expect(loaded?.dungeon.schemaVersion).toBe('1.0.0');
    expect(loaded?.rooms['room-phase0-v100-full-root']).not.toHaveProperty(
      'sm2QualityResponse',
    );
    expect(imported.dungeon.schemaVersion).toBe('1.1.0');
    expect(imported.rooms['room-phase0-v100-full-root']).toMatchObject({
      sm2QualityResponse: 3,
      sm2NextReviewDate: FIXED_NOW,
      tags: [],
    });
  });

  it('freezes the known raw-loader gap for parseable but structurally invalid 1.0.0 data', async () => {
    const raw = readFixture('subject-invalid-parseable-missing-room-v1.0.json');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    window.localStorage.setItem(STORAGE_KEYS.subject(PARSEABLE_INVALID_ID), raw);

    const loaded = await loadSubjectSnapshot(PARSEABLE_INVALID_ID);

    expect(loaded).toEqual(parsed);
    expect(loaded?.dungeon.schemaVersion).toBe('1.0.0');
    expect(loaded?.dungeon).not.toHaveProperty('tagIndex');
    expect(loaded?.dungeon).not.toHaveProperty('biome');
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(PARSEABLE_INVALID_ID))).toBe(raw);
    expect(window.localStorage.getItem(`knowledge-dungeon:corrupt:${PARSEABLE_INVALID_ID}`)).toBeNull();
    expect(() => importSubjectFromJson(raw)).toThrow(/missing room payload/i);
  });

  it('preserves unknown fields for a current 1.1.0 import', () => {
    const raw = readFixture('subject-1.1.0-full-unknown-fields.json');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const imported = importSubjectFromJson(raw);

    expect(imported).toEqual(parsed);
    expect(imported).toHaveProperty('unknownTopLevelField.marker');
    expect(imported.dungeon).toHaveProperty('fixtureDungeonField');
    expect(imported.rooms['room-phase0-v110-full-root']).toHaveProperty(
      'fixtureRoomField',
    );
  });

  it('preserves dungeon and room unknown fields during 1.0.0 migration', () => {
    const imported = importSubjectFromJson(
      readFixture('subject-1.0.0-migration-defaults.json'),
    );

    expect(imported).not.toHaveProperty('legacyEnvelope');
    expect(imported.dungeon).toHaveProperty('fixtureDungeonField');
    expect(imported.rooms['room-phase0-v100-migration-root']).toHaveProperty(
      'fixtureRoomField',
    );
  });

  it('rejects parseable but invalid subject payloads at the import boundary', () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        'unsupported schema version',
        'subject-invalid-unsupported-version.json',
        /Unsupported subject schema version/i,
      ],
      [
        'missing room payload',
        'subject-invalid-missing-room.json',
        /missing room payload/i,
      ],
      [
        'malformed room summary',
        'subject-invalid-malformed-room-summary.json',
        /room summary is malformed/i,
      ],
      [
        'missing schema version',
        'subject-invalid-missing-schema-version.json',
        /missing schema version/i,
      ],
    ];

    for (const [label, fixture, message] of cases) {
      expect(() => importSubjectFromJson(readFixture(fixture)), label).toThrow(message);
    }
  });

  it('rejects syntactically invalid JSON before any migration work', () => {
    expect(() => importSubjectFromJson(readFixture('subject-invalid-syntax.txt'))).toThrow(
      SyntaxError,
    );
  });

  it('quarantines malformed raw subject JSON and returns null from the loader', async () => {
    const corruptRaw = '{"dungeon":';
    window.localStorage.setItem(STORAGE_KEYS.subject(CORRUPT_ID), corruptRaw);

    await expect(loadSubjectSnapshot(CORRUPT_ID)).resolves.toBeNull();
    expect(window.localStorage.getItem(`knowledge-dungeon:corrupt:${CORRUPT_ID}`)).toBe(
      corruptRaw,
    );
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(CORRUPT_ID))).toBeNull();
  });

  it('keeps the 1.0.0 subject identifier stable through import migration', () => {
    const imported = importSubjectFromJson(readFixture('subject-1.0.0-migration-defaults.json'));

    expect(imported.dungeon.dungeonId).toBe(MIGRATION_ID);
    expect(imported.rooms[imported.dungeon.rootRoomId]).toBeDefined();
  });

  it('does not use the synthetic fixture as a real subject or learner record', () => {
    const imported = importSubjectFromJson(readFixture('subject-1.1.0-full-unknown-fields.json'));

    expect(imported.dungeon.subjectName).toBe('Synthetic Phase 0 Full 1.1 Subject');
    expect(imported.dungeon.subjectName).toMatch(/^Synthetic /);
  });
});
