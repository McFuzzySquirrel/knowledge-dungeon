/**
 * The legacy `localStorage` progression write shape.
 *
 * Phase 3 is not a storage cutover. The store still writes the key the default
 * Phaser build reads, so the payload must stay exactly what the pre-phase build
 * wrote: Phase 3's rollback is a source revert, and data written by this phase
 * must be indistinguishable from data the reverted build would write.
 *
 * These tests pin the written bytes, not a subset of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import {
  LEGACY_V3_SUBJECT_PROGRESSION_KEYS,
  canonicalProgressionToRecord,
  toLegacyV3ProgressionRecord,
} from '@/core/progression/canonicalProgression';

const PROGRESSION_KEY = STORAGE_KEYS.progression;
const ACTIVE_SUBJECT_KEY = STORAGE_KEYS.activeSubjectId;

/** The exact per-subject record the pre-phase build wrote, in its key order. */
const PRE_PHASE_SUBJECT_KEYS = [
  'xpTotal',
  'rank',
  'badges',
  'inventory',
  'equippedItems',
  'collectedNotes',
  'streakCount',
  'subjectsMastered',
  'roomsCleared',
  'reviewPasses',
  'artifacts',
  'bossesDefeated',
  'fishCollection',
];

/** Keys that exist only in the canonical/storage-v2 form. */
const CANONICAL_ONLY_ENVELOPE_KEYS = [
  'kind',
  'sourceVersion',
  'activeSubjectId',
  'legacyBucketSubjectId',
  'extraFields',
];

/** The literal string the pre-phase build wrote for a fresh subject. */
const PRE_PHASE_FRESH_SUBJECT_PAYLOAD =
  '{"version":3,"bySubject":{"subject-scratch-new":{"xpTotal":0,"rank":"Novice","badges":[],"inventory":[],"equippedItems":[],"collectedNotes":[],"streakCount":0,"subjectsMastered":0,"roomsCleared":0,"reviewPasses":0,"artifacts":0,"bossesDefeated":0,"fishCollection":[]}},"crossSubjectAchievements":[]}';

type ProgressionStoreModule = typeof import('@/store/progressionStore');

async function loadStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  return import('@/store/progressionStore');
}

function readRawProgression(): string {
  const raw = window.localStorage.getItem(PROGRESSION_KEY);
  if (raw === null) throw new Error('the store wrote nothing to the progression key');
  return raw;
}

function readParsedProgression(): Record<string, unknown> {
  return JSON.parse(readRawProgression()) as Record<string, unknown>;
}

describe('legacy progression write shape', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes the exact pre-phase payload for a subject with no stored record', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-scratch-new');

    const raw = readRawProgression();
    const payload = readParsedProgression();

    // Full key set on the envelope, not a subset.
    expect(Object.keys(payload).sort()).toEqual(['bySubject', 'crossSubjectAchievements', 'version']);
    expect(payload.version).toBe(3);
    expect(Object.keys(payload.bySubject as Record<string, unknown>)).toEqual(['subject-scratch-new']);

    // Full key set on the record, in the pre-phase order, and no `subjectId`.
    const record = (payload.bySubject as Record<string, Record<string, unknown>>)['subject-scratch-new'];
    expect(Object.keys(record)).toEqual(PRE_PHASE_SUBJECT_KEYS);
    expect(record).not.toHaveProperty('subjectId');
    expect(record).not.toHaveProperty('extraFields');

    // Byte-identical to the pre-phase payload, which is what makes the Phase 3
    // rollback a data-level no-op.
    expect(raw).toBe(PRE_PHASE_FRESH_SUBJECT_PAYLOAD);
  });

  it('never stores a foreign subjectId in a new subject record', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-scratch-new');

    const inMemory = useProgressionStore.getState().bySubject['subject-scratch-new'];
    expect(inMemory).not.toHaveProperty('subjectId');

    // Repeated writes must not accumulate an identity either.
    useProgressionStore.getState().awardBadge('synthetic-badge');
    useProgressionStore.getState().awardRoomClear({
      qualityBonus: 5,
      totalRooms: 2,
      creatorMappedRooms: 2,
      scribeClearedRooms: 1,
      archaeologistFullReviewPasses: 0,
    });

    const record = (readParsedProgression().bySubject as Record<string, Record<string, unknown>>)[
      'subject-scratch-new'
    ];
    expect(Object.keys(record)).toEqual(PRE_PHASE_SUBJECT_KEYS);
    expect(record).not.toHaveProperty('subjectId');
  });

  it('flattens a preserved unknown app-owned field and keeps canonical-only keys off the key', async () => {
    window.localStorage.setItem(
      PROGRESSION_KEY,
      JSON.stringify({
        version: 3,
        bySubject: {
          'subject-unknown-fields': {
            xpTotal: 320,
            rank: 'Stale Rank',
            badges: ['synthetic-badge'],
            inventory: [],
            equippedItems: [],
            collectedNotes: [],
            streakCount: 0,
            subjectsMastered: 0,
            roomsCleared: 1,
            reviewPasses: 0,
            artifacts: 0,
            bossesDefeated: 0,
            fishCollection: [],
            fixtureUnknownField: { marker: 'synthetic-unknown-field' },
          },
        },
        crossSubjectAchievements: [],
      }),
    );
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-unknown-fields');

    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-unknown-fields');
    useProgressionStore.getState().awardBadge('synthetic-second-badge');

    const payload = readParsedProgression();
    for (const key of CANONICAL_ONLY_ENVELOPE_KEYS) {
      expect(payload, key).not.toHaveProperty(key);
    }
    expect(Object.keys(payload).sort()).toEqual(['bySubject', 'crossSubjectAchievements', 'version']);

    const record = (payload.bySubject as Record<string, Record<string, unknown>>)['subject-unknown-fields'];
    // The unknown field is flattened into the record, not wrapped.
    expect(record.fixtureUnknownField).toEqual({ marker: 'synthetic-unknown-field' });
    expect(record).not.toHaveProperty('extraFields');
    expect(record).not.toHaveProperty('subjectId');
    // The known key set is the pre-phase set plus exactly the unknown field.
    expect(Object.keys(record).sort()).toEqual([...PRE_PHASE_SUBJECT_KEYS, 'fixtureUnknownField'].sort());
    // The derived rank replaces the stale stored one, as it always did.
    expect(record.rank).toBe('Scholar');
    expect(record.xpTotal).toBe(320);
  });

  it('round-trips through the store without changing the in-memory state', async () => {
    window.localStorage.setItem(
      PROGRESSION_KEY,
      JSON.stringify({
        version: 3,
        bySubject: {
          'subject-round-trip': {
            xpTotal: 900,
            rank: 'Master',
            badges: ['synthetic-badge'],
            inventory: [
              { id: 'loot-synthetic', name: 'Synthetic Relic', description: 'Synthetic.', rarity: 'rare', acquiredAt: '2026-01-01T00:00:00.000Z' },
            ],
            equippedItems: [
              { id: 'gear-synthetic', name: 'Synthetic Gear', description: 'Synthetic.', rarity: 'common', acquiredAt: '2026-01-01T00:00:00.000Z', equipSlot: 'accessory', equipped: true },
            ],
            collectedNotes: [],
            streakCount: 2,
            subjectsMastered: 1,
            roomsCleared: 4,
            reviewPasses: 3,
            artifacts: 2,
            bossesDefeated: 1,
            fishCollection: [
              { id: 'moss-carp:rt-1', name: 'Moss Carp', rarity: 'common', subjectId: 'subject-round-trip', subjectName: 'Synthetic', caughtAt: '2026-01-01T00:00:00.000Z' },
            ],
            fixtureUnknownField: 7,
          },
        },
        crossSubjectAchievements: ['meta-subjects-5'],
      }),
    );
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-round-trip');

    const first = await loadStore();
    first.useProgressionStore.getState().setActiveSubject('subject-round-trip');
    const beforeWrite = first.useProgressionStore.getState().bySubject['subject-round-trip'];
    const rawAfterWrite = readRawProgression();

    // Re-read from storage with a fresh module instance.
    const second = await loadStore();
    const afterReload = second.useProgressionStore.getState().bySubject['subject-round-trip'];

    expect(afterReload).toEqual(beforeWrite);
    expect(second.useProgressionStore.getState().crossSubjectAchievements).toEqual(['meta-subjects-5']);
    expect(second.useProgressionStore.getState().xpTotal).toBe(900);
    expect(second.useProgressionStore.getState().rank).toBe('Master');
    // The unknown field survived the write/read cycle, flattened.
    expect(afterReload).toHaveProperty('extraFields.fixtureUnknownField', 7);
    expect(readRawProgression()).toBe(rawAfterWrite);
  });

  it('keeps the two serializers separate: the legacy mirror and storage-v2 differ by design', () => {
    const record = {
      xpTotal: 10,
      rank: 'Novice' as const,
      badges: [],
      inventory: [],
      equippedItems: [],
      collectedNotes: [],
      streakCount: 0,
      subjectsMastered: 0,
      roomsCleared: 0,
      reviewPasses: 0,
      artifacts: 0,
      bossesDefeated: 0,
      fishCollection: [],
      extraFields: { fixtureUnknownField: 1 },
    };

    const legacy = toLegacyV3ProgressionRecord({
      bySubject: { 'subject-a': record },
      crossSubjectAchievements: [],
    });
    const storageV2 = canonicalProgressionToRecord({
      sourceVersion: 3 as const,
      activeSubjectId: null,
      legacyBucketSubjectId: null,
      bySubject: { 'subject-a': record },
      crossSubjectAchievements: [],
      extraFields: {},
    });

    expect(Object.keys(legacy)).toEqual(['version', 'bySubject', 'crossSubjectAchievements']);
    expect(legacy.version).toBe(3);
    expect(Object.keys(storageV2)).toContain('kind');
    expect(Object.keys(legacy.bySubject['subject-a']!)).toEqual([
      ...PRE_PHASE_SUBJECT_KEYS,
      'fixtureUnknownField',
    ]);
    expect(Object.keys(legacy.bySubject['subject-a']!)).toEqual([...LEGACY_V3_SUBJECT_PROGRESSION_KEYS, 'fixtureUnknownField']);
  });
});
