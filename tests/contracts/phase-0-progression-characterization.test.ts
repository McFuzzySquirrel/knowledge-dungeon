import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/persistence/progression');
const ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';
const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
const FIXED_NOW = '2026-09-24T12:34:56.789Z';

type ProgressionStoreModule = typeof import('@/store/progressionStore');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

async function loadProgressionStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  return import('@/store/progressionStore');
}

async function hydrate(
  fixtureName: string,
  activeSubjectId: string | null = null,
): Promise<ProgressionStoreModule> {
  if (activeSubjectId !== null) {
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, activeSubjectId);
  }
  window.localStorage.setItem(PROGRESSION_KEY, readFixture(fixtureName));
  const mod = await loadProgressionStore();
  // Phase 4: hydration is an explicit step owned by the application bootstrap,
  // not a module-load side effect. These two calls are exactly what the bootstrap
  // performs for the legacy repository, so the characterization below still
  // exercises the real hydration path with every assertion intact.
  mod.useProgressionStore.getState().hydrateProgression(mod.readPersistedProgressionPayload());
  return mod;
}

describe('Phase 0 progression hydration characterization', () => {
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
    vi.resetModules();
  });

  it('hydrates and normalizes the unversioned v1 flat shape', async () => {
    const { useProgressionStore } = await hydrate(
      'progression-v1-flat.json',
      'subject-phase0-v1',
    );
    const state = useProgressionStore.getState();

    expect(state.activeSubjectId).toBe('subject-phase0-v1');
    expect(Object.keys(state.bySubject)).toEqual(['subject-phase0-v1']);
    expect(state.xpTotal).toBe(315);
    expect(state.rank).toBe('Scholar');
    expect(state.badges).toEqual(['synthetic-v1-badge']);
    expect(state.inventory).toHaveLength(1);
    expect(state.inventory[0]).toMatchObject({
      id: 'loot-phase0-v1-synthetic',
      name: 'Synthetic Legacy Relic',
      rarity: 'rare',
    });
    expect(state.collectedNotes).toHaveLength(1);
    expect(state.fishCollection).toHaveLength(1);
    expect(state.equippedItems).toEqual([]);
    expect(state.streakCount).toBe(0);
    expect(state.subjectsMastered).toBe(0);
    expect(state.roomsCleared).toBe(0);
    expect(state.reviewPasses).toBe(0);
    expect(state.artifacts).toBe(0);
    expect(state.bossesDefeated).toBe(0);
    expect(state.crossSubjectAchievements).toEqual([]);
  });

  it('uses the current __legacy__ bucket when a v1 record has no active subject', async () => {
    const { useProgressionStore } = await hydrate('progression-v1-flat.json');
    const state = useProgressionStore.getState();

    expect(state.activeSubjectId).toBe('__legacy__');
    expect(state.bySubject.__legacy__?.xpTotal).toBe(315);
    expect(state.bySubject.__legacy__?.rank).toBe('Scholar');
  });

  it('hydrates v2 by-subject records and normalizes the active subject', async () => {
    const { useProgressionStore } = await hydrate(
      'progression-v2-by-subject.json',
      'subject-phase0-v2',
    );
    const state = useProgressionStore.getState();

    expect(state.activeSubjectId).toBe('subject-phase0-v2');
    expect(Object.keys(state.bySubject).sort()).toEqual([
      'subject-phase0-v2',
      'subject-phase0-v2-empty',
    ]);
    expect(state.xpTotal).toBe(805);
    expect(state.rank).toBe('Master');
    expect(state.badges).toEqual(['synthetic-v2-badge']);
    expect(state.inventory[0]?.id).toBe('loot-phase0-v2-synthetic');
    expect(state.collectedNotes).toHaveLength(1);
    expect(state.fishCollection[0]?.name).toBe('Synthetic V2 Fish');
    expect(state.bySubject['subject-phase0-v2-empty']).toMatchObject({
      xpTotal: 0,
      rank: 'Novice',
      badges: [],
      inventory: [],
      collectedNotes: [],
      fishCollection: [],
    });
    expect(state.crossSubjectAchievements).toEqual([]);
  });

  it('hydrates the current v3 shape, filters achievements, and scopes collected notes', async () => {
    const { useProgressionStore } = await hydrate(
      'progression-v3-current-full.json',
      'subject-phase0-v3',
    );
    const state = useProgressionStore.getState();

    expect(state.activeSubjectId).toBe('subject-phase0-v3');
    expect(Object.keys(state.bySubject).sort()).toEqual([
      'subject-phase0-v3',
      'subject-phase0-v3-secondary',
    ]);
    expect(state.xpTotal).toBe(980);
    expect(state.rank).toBe('Master');
    expect(state.badges).toEqual([
      'synthetic-v3-badge',
      'another-synthetic-badge',
    ]);
    expect(state.crossSubjectAchievements).toEqual([
      'meta-subjects-5',
      'meta-notes-50',
    ]);
    expect(state.collectedNotes).toHaveLength(1);
    expect(state.collectedNotes[0]?.dungeonId).toBe('subject-phase0-v3');
    expect(state.equippedItems[0]).toMatchObject({
      id: 'gear-phase0-v3-synthetic',
      equipSlot: 'accessory',
      equipped: true,
      qualityBonus: 1,
      xpMultiplier: 1.1,
    });
    expect(state.bySubject['subject-phase0-v3']?.collectedNotes).toHaveLength(2);
  });

  it('normalizes malformed v1 fields deterministically and filters invalid records', async () => {
    const { useProgressionStore } = await hydrate(
      'progression-v1-flat-malformed.json',
      'subject-phase0-v1-malformed',
    );
    const state = useProgressionStore.getState();

    expect(state.xpTotal).toBe(0);
    expect(state.rank).toBe('Novice');
    expect(state.badges).toEqual(['synthetic-valid-badge']);
    expect(state.inventory).toEqual([
      {
        id: 'loot-4fzzzx',
        name: 'Synthetic Item Without Identifier',
        description: 'Synthetic malformed item.',
        rarity: 'common',
        acquiredAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(state.equippedItems[0]).toMatchObject({
      id: 'gear-4fzzzx',
      name: 'Synthetic Gear Without Identifier',
      rarity: 'common',
      equipSlot: 'accessory',
      equipped: false,
      acquiredAt: '1970-01-01T00:00:00.000Z',
    });
    expect(state.collectedNotes).toEqual([]);
    expect(state.fishCollection).toEqual([
      {
        id: 'fish-phase0-v1-malformed',
        name: 'Synthetic Fish Missing Rarity',
        rarity: 'common',
        subjectId: 'subject-phase0-v1-malformed',
        subjectName: 'Synthetic V1 Subject',
        caughtAt: '2026-02-02T05:00:00.000Z',
      },
    ]);
    expect(state.streakCount).toBe(0);
    expect(state.subjectsMastered).toBe(0);
    expect(state.roomsCleared).toBe(2);
    expect(state.reviewPasses).toBe(0);
    expect(state.artifacts).toBe(0);
    expect(state.bossesDefeated).toBe(0);
  });

  it('falls back to flat normalization when a v2 bySubject member is null', async () => {
    const { useProgressionStore } = await hydrate(
      'progression-v2-malformed-by-subject.json',
      'subject-phase0-v2-fallback',
    );
    const state = useProgressionStore.getState();

    expect(Object.keys(state.bySubject)).toEqual(['subject-phase0-v2-fallback']);
    expect(state.xpTotal).toBe(325);
    expect(state.rank).toBe('Scholar');
    expect(state.badges).toEqual(['synthetic-v2-fallback-badge']);
    expect(state.inventory).toEqual([]);
    expect(state.crossSubjectAchievements).toEqual([]);
  });

  it('normalizes malformed v3 values without retaining non-string achievements', async () => {
    const { useProgressionStore } = await hydrate(
      'progression-v3-malformed-values.json',
      'subject-phase0-v3-malformed',
    );
    const state = useProgressionStore.getState();

    expect(state.xpTotal).toBe(0);
    expect(state.rank).toBe('Novice');
    expect(state.badges).toEqual(['synthetic-v3-valid']);
    expect(state.inventory).toEqual([]);
    expect(state.equippedItems[0]?.id).toBe('gear-4fzzzx');
    expect(state.collectedNotes).toEqual([]);
    expect(state.fishCollection[0]?.rarity).toBe('common');
    expect(state.crossSubjectAchievements).toEqual([]);
  });

  it('returns an empty in-memory progression when the raw persisted JSON is corrupt', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, readFixture('progression-invalid-syntax.txt'));
    const { useProgressionStore } = await loadProgressionStore();
    const state = useProgressionStore.getState();

    expect(state.activeSubjectId).toBeNull();
    expect(state.bySubject).toEqual({});
    expect(state.xpTotal).toBe(0);
    expect(state.rank).toBe('Novice');
    expect(state.crossSubjectAchievements).toEqual([]);
  });
});
