/**
 * Phase 4 fix verification: each reported fix, held open by a test that fails if
 * it is reverted.
 *
 * One block per reported fix, in the order the fixes were made:
 *
 * 1. the progression envelope carries the shared canonical version
 * 2. custom-sprite records are keyed by (kind, spritePath)
 * 3. preferences are published to the active generation
 * 4. both repositories hydrate shortcuts in one order
 * 5. a payload the subject index does not name is preserved as a recovery record
 * 6. a marker-only device reports `no-source-data`
 *
 * Every test in this file was checked for *sensitivity*: each was written first,
 * the corresponding production change was reverted in a scratch copy of the tree,
 * and the test was confirmed to go red. The revert procedure and its results are
 * recorded in `tests/phase4/FIX-REVERT-LOG.md`.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUBJECT_ID,
  NOW,
  ROOT_ROOM_ID,
  openRepo,
  dropRepo,
  seedLegacyKeys,
  syntheticSnapshot,
  legacyKeySet,
  PROGRESSION_KEY,
  PREFERENCES_KEY,
  SHORTCUTS_KEY,
} from './support/phase4Support';

import { migrateLegacyState, buildMigratedRecords } from '@/services/persistence/v2/migrations';
import { readLegacyAppState, hasNoLearnerContent, isEmptyLegacyAppState } from '@/services/persistence/v2/legacyReader';
import {
  readAppStateFromLegacy,
  readAppStateFromStorageV2,
  progressionEnvelopeFrom,
} from '@/services/persistence/v2/appState';
import { customSpriteRecordId, CUSTOM_SPRITE_KIND_PREFIX } from '@/services/persistence/v2/validation';
import { resetRepositorySelection, selectStorageV2Repository } from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports, dualWriteReports } from '@/services/persistence/v2/dualWrite';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useShortcutStore, canonicalShortcutBindings, readPersistedShortcuts } from '@/store/shortcutStore';
import { useProgressionStore } from '@/store/progressionStore';
import { normalizeProgressionRecord } from '@/core/progression/canonicalProgression';
import { CANONICAL_PROGRESSION_VERSION } from '@/core/progression/canonicalProgression';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { ProgressionRecordValue, SubjectRecordValue } from '@/services/persistence/v2/schema';

type Database = Record<string, string>;

const handles: StorageV2Repository[] = [];
const dbNames: string[] = [];

async function openTracked(suffix: string): Promise<StorageV2Repository> {
  dbNames.push(suffix);
  const repo = await openRepo(suffix);
  handles.push(repo);
  return repo;
}

async function waitFor(read: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function write(keys: Database): void {
  window.localStorage.clear();
  for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
}

/** A legacy device with one subject, a second subject, and real progression. */
function twoSubjectDevice(): Database {
  const secondId = 'subject-phase4-second';
  const second = syntheticSnapshot({
    dungeon: {
      ...syntheticSnapshot().dungeon,
      dungeonId: secondId,
      subjectName: 'Phase4 Independent Second Synthetic Subject',
    },
  } as never);
  return {
    'knowledge-dungeon:v1:subjects': JSON.stringify([SUBJECT_ID, secondId]),
    [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: JSON.stringify(syntheticSnapshot()),
    [`knowledge-dungeon:v1:subject:${secondId}`]: JSON.stringify(second),
    'knowledge-dungeon:v1:activeSubjectId': SUBJECT_ID,
    [PROGRESSION_KEY]: JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: 17,
          rank: 'Novice',
          badges: ['synthetic-phase4-seed-badge'],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 2,
          subjectsMastered: 0,
          roomsCleared: 3,
          reviewPasses: 0,
          artifacts: 1,
          bossesDefeated: 0,
          fishCollection: [],
          // An unknown app-owned field, which the legacy reader preserves.
          qaUnknownProgressionField: 'retained-value',
        },
        [secondId]: {
          xpTotal: 5,
          rank: 'Novice',
          badges: ['synthetic-phase4-second-badge'],
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
        },
      },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    }),
    [PREFERENCES_KEY]: JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'dark', activeSpritePack: null }),
    [SHORTCUTS_KEY]: JSON.stringify([
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'm', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Info Panel', labelKey: 'shortcuts.toggleInfoPanel', defaultKey: 'i', key: 'i', ctrlKey: false, shiftKey: false },
    ]),
    'knowledge-dungeon:v1:sessions': JSON.stringify([
      {
        sessionId: 'session-phase4-seed',
        subjectId: SUBJECT_ID,
        subjectName: 'Phase4 Independent Synthetic Subject',
        startedAt: '2026-01-04T03:00:00.000Z',
        endedAt: '2026-01-04T03:30:00.000Z',
        roomsVisited: [ROOT_ROOM_ID],
        notesSubmitted: 1,
        reviewsCompleted: 0,
        xpEarned: 17,
      },
    ]),
  };
}

/** One progression record per subject, in the shape the reader consumes. */
function progressionRecords(): ProgressionRecordValue[] {
  return [
    {
      subjectId: SUBJECT_ID,
      sourceVersion: 3,
      rank: 'Novice',
      xpTotal: 17,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: 17,
          rank: 'Novice',
          badges: ['synthetic-phase4-seed-badge'],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 2,
          subjectsMastered: 0,
          roomsCleared: 3,
          reviewPasses: 0,
          artifacts: 1,
          bossesDefeated: 0,
          fishCollection: [],
          qaUnknownProgressionField: 'retained-value',
        },
      },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    },
    {
      subjectId: 'subject-phase4-second',
      sourceVersion: 3,
      rank: 'Novice',
      xpTotal: 5,
      bySubject: {
        'subject-phase4-second': {
          xpTotal: 5,
          rank: 'Novice',
          badges: ['synthetic-phase4-second-badge'],
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
        },
      },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    },
  ];
}

/** Read the raw `bySubject` map the store hydrated, without the store's own view. */
function hydratedBySubject(): Record<string, { xpTotal: number; badges: string[] }> {
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(useProgressionStore.getState().bySubject).map(([id, record]) => [
          id,
          { xpTotal: record.xpTotal, badges: record.badges },
        ]),
      ),
    ),
  ) as Record<string, { xpTotal: number; badges: string[] }>;
}

beforeEach(() => {
  window.localStorage.clear();
  seedLegacyKeys();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const suffix of dbNames.splice(0)) await dropRepo(suffix);
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

// ── 1. the progression envelope ────────────────────────────────────────────

describe('Fix 1: the progression envelope carries the shared canonical version', () => {
  it('emits the shared constant, not a literal', () => {
    // The value must come from the one declaration, so a future envelope change
    // is a one-line change. A literal `3` here would still pass a value check.
    const source = readFileSyncIfPresent('src/services/persistence/v2/appState.ts');
    expect(source).toContain('version: CANONICAL_PROGRESSION_VERSION,');
    expect(source).toMatch(/import \{ CANONICAL_PROGRESSION_VERSION \} from '@\/core\/progression\/canonicalProgression';/);
    expect(source).not.toMatch(/version:\s*3\b/);
    expect(CANONICAL_PROGRESSION_VERSION).toBe(3);
  });

  it('keeps every per-subject record, and the cross-subject achievements', () => {
    const envelope = progressionEnvelopeFrom(progressionRecords());
    expect(envelope.version).toBe(CANONICAL_PROGRESSION_VERSION);
    const canonical = normalizeProgressionRecord(envelope, { activeSubjectId: SUBJECT_ID });
    expect(canonical.sourceVersion).toBe(3);
    expect(Object.keys(canonical.bySubject).sort()).toEqual([
      SUBJECT_ID,
      'subject-phase4-second',
    ]);
    expect(canonical.bySubject[SUBJECT_ID]?.badges).toEqual(['synthetic-phase4-seed-badge']);
    expect(canonical.bySubject['subject-phase4-second']?.xpTotal).toBe(5);
    expect(canonical.crossSubjectAchievements).toEqual(['synthetic-phase4-cross-achievement']);
  });

  it('is a fixed point: reading and hydrating twice changes nothing', async () => {
    // The read side. A payload the reader emits must be a payload the normaliser
    // leaves unchanged, so hydration is idempotent: a missing version marker
    // breaks exactly here, because the second read classifies the envelope
    // differently from the first.
    //
    // The *write* side of the round trip is a separate property and is not green:
    // see `progressionWritePathDefect.test.ts`, which holds that open.
    write(twoSubjectDevice());
    const repo = await openTracked('fixed-point');
    expect(
      (await migrateLegacyState({
        repository: repo,
        generationId: 'gen-phase4-fixed-point',
        now: NOW,
        clock: { now: () => NOW },
      })).report.status,
    ).toBe('migrated');
    selectStorageV2Repository(repo);

    const first = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    useProgressionStore.getState().hydrateProgression(first.progression);
    const hydratedOnce = hydratedBySubject();
    expect(hydratedOnce).toEqual({
      [SUBJECT_ID]: { xpTotal: 17, badges: ['synthetic-phase4-seed-badge'] },
      'subject-phase4-second': { xpTotal: 5, badges: ['synthetic-phase4-second-badge'] },
    });

    // Read again, hydrate again, and compare. No drift, in the store...
    const second = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    expect(JSON.stringify(second.progression)).toBe(JSON.stringify(first.progression));
    useProgressionStore.getState().hydrateProgression(second.progression);
    expect(hydratedBySubject()).toEqual(hydratedOnce);
    // ...and in the envelope itself, which a third read would need.
    const third = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    expect(JSON.stringify(third.progression)).toBe(JSON.stringify(second.progression));
    // The unknown app-owned field survived the whole read.
    expect(JSON.stringify(third.progression)).toContain('qaUnknownProgressionField');
    // And the cross-subject achievement list is still there, deduped and sorted.
    expect(third.progression).toMatchObject({
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    });
  });

  it('a v1-migrated record and a clean v3 record both survive the round trip', async () => {
    // A device whose progression is the v1 flat shape: the migration buckets it
    // under the active subject, and the reader must hand back something the
    // normaliser still reads as a per-subject map.
    const keys = twoSubjectDevice();
    keys[PROGRESSION_KEY] = JSON.stringify({
      xpTotal: 31,
      rank: 'Novice',
      badges: ['synthetic-phase4-v1-badge'],
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
    });
    write(keys);
    const repo = await openTracked('v1-round-trip');
    expect(
      (await migrateLegacyState({
        repository: repo,
        generationId: 'gen-phase4-v1-round-trip',
        now: NOW,
        clock: { now: () => NOW },
      })).report.status,
    ).toBe('migrated');
    selectStorageV2Repository(repo);
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    useProgressionStore.getState().hydrateProgression(state.progression);
    expect(hydratedBySubject()[SUBJECT_ID]?.badges).toEqual(['synthetic-phase4-v1-badge']);
    expect(hydratedBySubject()[SUBJECT_ID]?.xpTotal).toBe(31);
    // And the second read is identical to the first.
    const again = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    expect(JSON.stringify(again.progression)).toBe(JSON.stringify(state.progression));
  });

  it('the legacy mirror is no longer overwritten with a loss', async () => {
    write(twoSubjectDevice());
    const repo = await openTracked('mirror-not-loss');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-mirror-not-loss',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    useProgressionStore.getState().hydrateProgression(state.progression);
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-post-reload-badge');
    await waitFor(
      () =>
        (
          (JSON.parse(window.localStorage.getItem(PROGRESSION_KEY) as string) as {
            bySubject: Record<string, { badges: string[] }>;
          }).bySubject[SUBJECT_ID]?.badges ?? []
        ).includes('synthetic-phase4-post-reload-badge'),
      'the mirrored progression write',
    );
    const mirrored = JSON.parse(window.localStorage.getItem(PROGRESSION_KEY) as string) as {
      version: number;
      bySubject: Record<string, { badges: string[]; xpTotal: number }>;
      crossSubjectAchievements: string[];
    };
    // The pre-existing badge, the new one, the XP, and the achievement list are
    // all still there. Before the fix this write replaced the record with one
    // holding only the new badge and zero XP.
    expect(mirrored.version).toBe(3);
    expect(mirrored.bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
      'synthetic-phase4-post-reload-badge',
    ]);
    expect(mirrored.bySubject[SUBJECT_ID]?.xpTotal).toBe(17);
    expect(mirrored.bySubject['subject-phase4-second']?.xpTotal).toBe(5);
    expect(mirrored.crossSubjectAchievements).toEqual(['synthetic-phase4-cross-achievement']);
  });
});

// ── 2. custom sprites ──────────────────────────────────────────────────────

describe('Fix 2: custom-sprite records are keyed by (kind, spritePath)', () => {
  const SPRITE_PATHS = ['player-hero', 'npc-scribe.svg', 'objects/chest.svg'];
  const KINDS = ['override', 'anim', 'original'] as const;

  function spriteDevice(paths: readonly string[], kinds: readonly string[]): Database {
    const keys: Database = { ...seedTwoSubjectMinimal() };
    for (const path of paths) {
      for (const kind of kinds) {
        const key =
          kind === 'original' ? 'originals' : kind === 'override' ? 'override' : 'anim';
        keys[`knowledge-dungeon:custom-sprites:${key}:${path}`] =
          `<svg data-probe="${kind}" data-path="${path}" />`;
      }
    }
    return keys;
  }

  it('the record id is kind-qualified and collision-free', () => {
    const ids = new Set<string>();
    for (const path of SPRITE_PATHS) {
      for (const kind of KINDS) {
        const id = customSpriteRecordId(path, kind);
        expect(id.startsWith(`${CUSTOM_SPRITE_KIND_PREFIX}${kind}:`)).toBe(true);
        expect(id).toContain(path);
        ids.add(id);
      }
    }
    // Nine records, nine ids. Keying by path alone would have produced three.
    expect(ids.size).toBe(9);
    // Stable: the same inputs always give the same id, so a re-stage supersedes.
    expect(customSpriteRecordId('player-hero', 'anim')).toBe(customSpriteRecordId('player-hero', 'anim'));
  });

  it('three kinds for one path migrate, activate, and validate', async () => {
    write(spriteDevice(['player-hero'], KINDS));
    const before = legacyKeySet();
    const repo = await openTracked('sprite-three-kinds');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-sprite-three',
      now: NOW,
      clock: { now: () => NOW },
    });

    // The whole point: the run activates rather than reporting a count mismatch.
    expect(outcome.report.recovery).toBeNull();
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-sprite-three');
    const validation = await repo.validateGeneration('gen-phase4-sprite-three');
    expect(validation.ok, JSON.stringify(validation.problems)).toBe(true);
    expect(validation.countDeltas.customSprites).toBe(0);

    // All three kinds survive, with their bytes, keyed so none overwrote another.
    const records = (await repo.readRecords('gen-phase4-sprite-three')).records.customSprites;
    expect(
      records
        .map((envelope) => (envelope.value as { kind: string; content: string; spritePath: string }))
        .map((value) => `${value.spritePath}:${value.kind}:${value.content}`)
        .sort(),
    ).toEqual([
      'player-hero:anim:<svg data-probe="anim" data-path="player-hero" />',
      'player-hero:original:<svg data-probe="original" data-path="player-hero" />',
      'player-hero:override:<svg data-probe="override" data-path="player-hero" />',
    ]);
    // The record id is the kind-qualified one, and the value still addresses the
    // sprite by its own path.
    expect(records.map((envelope) => envelope.recordId).sort()).toEqual(
      KINDS.map((kind) => customSpriteRecordId('player-hero', kind)).sort(),
    );
    for (const envelope of records) {
      expect((envelope.value as { spritePath: string }).spritePath).toBe('player-hero');
    }
    // The legacy device is untouched.
    expect(legacyKeySet()).toEqual(before);
  });

  it('several paths with mixed kinds migrate completely', async () => {
    write(spriteDevice(SPRITE_PATHS, KINDS));
    const repo = await openTracked('sprite-matrix');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-sprite-matrix',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(outcome.report.status).toBe('migrated');
    const records = (await repo.readRecords('gen-phase4-sprite-matrix')).records.customSprites;
    // Nine records for three paths and three kinds.
    expect(records).toHaveLength(9);
    expect(new Set(records.map((envelope) => envelope.recordId)).size).toBe(9);
    expect(await repo.validateGeneration('gen-phase4-sprite-matrix')).toMatchObject({ ok: true });
    // A re-read is a fixed point: the ids do not move.
    const again = (await repo.readRecords('gen-phase4-sprite-matrix')).records.customSprites;
    expect(again.map((envelope) => envelope.recordId).sort()).toEqual(
      records.map((envelope) => envelope.recordId).sort(),
    );
  });

  it('a direct re-stage with a subset is still the documented upsert-only follow-up', async () => {
    // Phase 3 recorded that `stageGeneration` only upserts, so a direct caller
    // re-staging with a subset leaves a stale record. The migration discards
    // first, so the migration path is unaffected. This pins the *known* behaviour
    // rather than a silent change to it.
    write(spriteDevice(['player-hero'], ['override']));
    const repo = await openTracked('sprite-restage');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-sprite-restage',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect((await repo.readRecords('gen-phase4-sprite-restage')).records.customSprites).toHaveLength(1);

    // A direct re-stage of the same generation is refused while it is active,
    // so the only way to reach the upsert path is through a staged generation.
    const staged = await openTracked('sprite-restage-subset');
    await staged.stageGeneration({
      generationId: 'gen-phase4-restage-subset',
      source: 'local-edit',
      records: {
        customSprites: [
          { spritePath: 'player-hero', kind: 'override', content: '<svg data-probe="override" />', updatedAt: NOW },
        ],
      },
    });
    await staged.stageGeneration({
      generationId: 'gen-phase4-restage-subset',
      source: 'local-edit',
      records: {
        customSprites: [
          { spritePath: 'player-hero', kind: 'anim', content: '<svg data-probe="anim" />', updatedAt: NOW },
        ],
      },
    });
    // The second upsert added a record rather than replacing the set, and the
    // descriptor count matches what is stored because each kind has its own id.
    const records = (await staged.readRecords('gen-phase4-restage-subset')).records.customSprites;
    expect(records.map((envelope) => envelope.recordId).sort()).toEqual(
      [customSpriteRecordId('player-hero', 'anim'), customSpriteRecordId('player-hero', 'override')].sort(),
    );
    // The still-open follow-up: the superseded record is *not* removed, so a
    // caller that meant to replace a set cannot. Recorded, not fixed.
    expect(records).toHaveLength(2);
  });
});

function seedTwoSubjectMinimal(): Database {
  return {
    'knowledge-dungeon:v1:subjects': JSON.stringify([SUBJECT_ID]),
    [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: JSON.stringify(syntheticSnapshot()),
    'knowledge-dungeon:v1:activeSubjectId': SUBJECT_ID,
  };
}

// ── 3. preferences ─────────────────────────────────────────────────────────

describe('Fix 3: a preference change reaches the active generation', () => {
  it('survives a reload on the flagged build', async () => {
    write(twoSubjectDevice());
    const repo = await openTracked('prefs-round-trip');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-prefs',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);

    const reload = async (): Promise<void> => {
      const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
      usePreferencesStore.getState().hydratePreferences(state.preferences);
    };
    await reload();
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');

    usePreferencesStore.getState().setColorTheme('colorful');
    usePreferencesStore.getState().setActiveSpritePack('synthetic-pack');
    await waitFor(
      () => dualWriteReports().some((entry) => entry.operation === 'preferences' && entry.outcome === 'written'),
      'the preference to reach the generation',
    );
    await reload();
    expect(usePreferencesStore.getState().colorTheme).toBe('colorful');
    expect(usePreferencesStore.getState().activeSpritePack).toBe('synthetic-pack');
  });

  it('writes the legacy key first and synchronously', () => {
    // No storage-v2 selected at all, so the write is the legacy path only, and it
    // must be complete by the time the synchronous action returns.
    resetRepositorySelection();
    usePreferencesStore.getState().setColorTheme('aurora');
    const raw = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) as string) as {
      colorTheme: string;
    };
    expect(raw.colorTheme).toBe('aurora');
  });

  it('a failed generation write leaves the legacy key holding the change, and reports it', async () => {
    write(twoSubjectDevice());
    const repo = await openTracked('prefs-failure');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-prefs-failure',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    // The generation write cannot even be attempted: the record adapter's import
    // is made to reject, which is what a closed or corrupt database looks like.
    const putRecords = vi
      .spyOn(repo, 'putRecords')
      .mockRejectedValue(new Error('qa generation write failure'));

    usePreferencesStore.getState().setColorTheme('colorful');
    // Synchronously, before any await: the legacy key already has it.
    expect(
      (JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) as string) as { colorTheme: string })
        .colorTheme,
    ).toBe('colorful');
    await waitFor(
      () => dualWriteReports().some((entry) => entry.outcome === 'primary-failed'),
      'the failed preference write to be reported',
    );
    putRecords.mockRestore();

    // Reported with a code, and the learner's change is still in the mirror a
    // rollback build reads.
    const failure = dualWriteReports().find((entry) => entry.outcome === 'primary-failed');
    expect(failure?.operation).toBe('preferences');
    expect(failure?.code).toBe('STORAGE_V2_WRITE_FAILED');
    expect(
      (JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) as string) as { colorTheme: string })
        .colorTheme,
    ).toBe('colorful');
    // And a successful write is reported too, so the two counters are independent.
    usePreferencesStore.getState().setColorTheme('dark');
    await waitFor(
      () => dualWriteReports().some((entry) => entry.outcome === 'written' && entry.operation === 'preferences'),
      'a successful preference write to be reported',
    );
  });
});

// ── 4. shortcut order ──────────────────────────────────────────────────────

describe('Fix 4: both repositories hydrate shortcuts in one order', () => {
  it('the flagged and legacy hydrations produce the identical order', async () => {
    write(twoSubjectDevice());
    const repo = await openTracked('shortcut-order');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-shortcut-order',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    useShortcutStore.getState().hydrateShortcuts(state.shortcuts);
    const flaggedOrder = useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey);

    resetRepositorySelection();
    useShortcutStore.getState().hydrateShortcuts(readPersistedShortcuts());
    const legacyOrder = useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey);

    expect(flaggedOrder).toEqual(legacyOrder);
    // The order is the one the app itself declares, not an alphabetical accident.
    expect(flaggedOrder).toEqual([...canonicalShortcutBindings]);
  });

  it('index 1 means the same action in both repositories', () => {
    write(twoSubjectDevice());
    const flaggedInput = [
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'm', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Info Panel', labelKey: 'shortcuts.toggleInfoPanel', defaultKey: 'i', key: 'i', ctrlKey: false, shiftKey: false },
    ];
    // The storage-v2 reader hands the same set over in a deliberately different
    // order, because a generation stores shortcuts as an unordered set.
    const shuffled = [flaggedInput[2], flaggedInput[0], flaggedInput[1]];

    useShortcutStore.getState().hydrateShortcuts(flaggedInput);
    const fromLegacy = useShortcutStore.getState().shortcuts;
    useShortcutStore.getState().hydrateShortcuts(shuffled);
    const fromStorageV2 = useShortcutStore.getState().shortcuts;

    expect(fromStorageV2[1]?.labelKey).toBe(fromLegacy[1]?.labelKey);
    expect(fromStorageV2[1]?.labelKey).toBe('shortcuts.toggleMap');
    // And the identity-based setter hits the same action from either order.
    useShortcutStore.getState().setShortcutForAction('shortcuts.toggleMap', 'v');
    expect(
      useShortcutStore.getState().shortcuts.find((binding) => binding.labelKey === 'shortcuts.toggleMap')?.key,
    ).toBe('v');
  });

  it('an unknown labelKey is preserved, in a stable order, and never dropped', () => {
    const payload = [
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'm', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Info Panel', labelKey: 'shortcuts.toggleInfoPanel', defaultKey: 'i', key: 'i', ctrlKey: false, shiftKey: false },
      // A binding from a build this one has never heard of.
      { label: 'Open Journal', labelKey: 'shortcuts.openJournal', defaultKey: 'j', key: 'J', ctrlKey: false, shiftKey: true },
      { label: 'Open Atlas', labelKey: 'shortcuts.openAtlas', defaultKey: 'a', key: 'a', ctrlKey: false, shiftKey: false },
    ];
    useShortcutStore.getState().hydrateShortcuts(payload);
    const hydrated = useShortcutStore.getState().shortcuts;
    // Nothing is dropped.
    expect(hydrated).toHaveLength(5);
    expect(hydrated.map((binding) => binding.labelKey)).toEqual([
      'shortcuts.toggleHelp',
      'shortcuts.toggleMap',
      'shortcuts.toggleInfoPanel',
      // The unknown ones follow, sorted, so a reload cannot reshuffle them.
      'shortcuts.openAtlas',
      'shortcuts.openJournal',
    ]);
    // The known order is still the app's, not alphabetical: the known set is
    // `toggleHelp, toggleMap, toggleInfoPanel`, which is *not* sorted.
    expect(canonicalShortcutBindings).toEqual([
      'shortcuts.toggleHelp',
      'shortcuts.toggleMap',
      'shortcuts.toggleInfoPanel',
    ]);
    // Hydrating the same payload in a different input order gives the same output.
    useShortcutStore.getState().hydrateShortcuts([...payload].reverse());
    expect(useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey)).toEqual(
      hydrated.map((binding) => binding.labelKey),
    );
  });
});

// ── 5. the unindexed payload ───────────────────────────────────────────────

describe('Fix 5: a payload the subject index does not name is preserved, not shown', () => {
  const ORPHAN_ID = 'subject-phase4-unindexed';

  function unindexedDevice(): Database {
    const orphan = syntheticSnapshot({
      dungeon: {
        ...syntheticSnapshot().dungeon,
        dungeonId: ORPHAN_ID,
        subjectName: 'Phase4 Independent Unindexed Synthetic Subject',
      },
    } as never);
    return {
      ...seedTwoSubjectMinimal(),
      // The index names only the first subject; the second payload exists and the
      // app has never heard of it.
      [`knowledge-dungeon:v1:subject:${ORPHAN_ID}`]: JSON.stringify(orphan),
    };
  }

  it('the bytes are preserved verbatim in a recovery record', async () => {
    const keys = unindexedDevice();
    write(keys);
    const rawValue = keys[`knowledge-dungeon:v1:subject:${ORPHAN_ID}`] as string;
    const repo = await openTracked('unindexed');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-unindexed',
      now: NOW,
      clock: { now: () => NOW },
    });

    expect(outcome.report.status).toBe('migrated');
    // The generation's subject set is the index's, so both repositories agree.
    const records = (await repo.readRecords('gen-phase4-unindexed')).records;
    expect(records.subjects.map((envelope) => envelope.recordId)).toEqual([SUBJECT_ID]);
    // The payload is not gone: it is a recovery record, byte for byte.
    const unindexed = records.recovery.filter(
      (envelope) => (envelope.value as { kind: string }).kind === 'unindexed-subject',
    );
    expect(unindexed).toHaveLength(1);
    const value = unindexed[0]?.value as { kind: string; subjectId: string; raw: string };
    expect(value.subjectId).toBe(ORPHAN_ID);
    // Read raw and compared to the legacy key's own string, not to a re-parse.
    expect(value.raw).toBe(rawValue);
    expect(JSON.parse(value.raw).dungeon.subjectName).toBe('Phase4 Independent Unindexed Synthetic Subject');
    // And it is disclosed, not silently swallowed.
    const disclosure = outcome.report.problems.filter(
      (problem) => problem.code === 'unindexed-subject-payload',
    );
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]?.severity).toBe('warning');
    expect(disclosure[0]?.count).toBe(1);
    // The generation still validates with the new recovery kind.
    expect((await repo.validateGeneration('gen-phase4-unindexed')).ok).toBe(true);
    // And the legacy device is untouched.
    expect(legacyKeySet()).toEqual(keys);
  });

  it('a rollback build and the flagged build agree on the subject list', async () => {
    const keys = unindexedDevice();
    write(keys);
    const repo = await openTracked('unindexed-agree');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-unindexed-agree',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const flagged = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    const legacy = readAppStateFromLegacy();

    expect(flagged.subjects.map((entry) => entry.id)).toEqual(
      legacy.subjects.map((entry) => entry.id),
    );
    expect(flagged.subjects.map((entry) => entry.id)).toEqual([SUBJECT_ID]);
    // The bytes are still on the device for a rollback build, which is what makes
    // the preservation useful rather than merely tidy.
    expect(window.localStorage.getItem(`knowledge-dungeon:v1:subject:${ORPHAN_ID}`)).toBe(
      keys[`knowledge-dungeon:v1:subject:${ORPHAN_ID}`],
    );
  });

  it('a device with no index key at all still carries every payload, and the divergence is declared', () => {
    // The deliberate remaining asymmetry: with no index there is no list to
    // enforce, so every payload is carried. Dropping them would lose data, and the
    // phase chose preservation. Both halves are asserted here so the tradeoff
    // cannot drift silently.
    const keys = unindexedDevice();
    delete keys['knowledge-dungeon:v1:subjects'];
    const state = readLegacyAppState({ storage: keysToStorage(keys) });
    expect(state.indexedSubjectIds).toBeUndefined();
    const built = buildMigratedRecords(state, { now: NOW, generationId: 'gen-phase4-no-index' });
    const builtSubjects = built.records.subjects ?? [];
    expect(builtSubjects.map((record) => record.subjectId).sort()).toEqual(
      [ORPHAN_ID, SUBJECT_ID].sort(),
    );
    expect(built.records.recovery).toEqual([]);
    // The app-shaped legacy reader, which follows the index, sees neither. Read
    // from the same keys, not from whatever `localStorage` happens to hold.
    write(keys);
    expect(readAppStateFromLegacy().subjects).toEqual([]);
    // And the reader said so itself: with no index key there is no list to
    // enforce, which is the documented reason the payloads are carried.
    expect(state.indexedSubjectIds).toBeUndefined();
  });
});

function keysToStorage(keys: Database): Storage {
  return {
    get length() {
      return Object.keys(keys).length;
    },
    key: (index: number) => Object.keys(keys)[index] ?? null,
    getItem: (key: string) => keys[key] ?? null,
  } as Storage;
}

// ── 6. hasNoLearnerContent ─────────────────────────────────────────────────

describe('Fix 6: a marker-only device reports no-source-data', () => {
  interface Case {
    readonly label: string;
    readonly keys: Database;
    readonly expected: 'migrated' | 'no-source-data';
  }

  const CASES: Case[] = [
    { label: 'a locale-only device', keys: { 'knowledge-dungeon:locale': 'en' }, expected: 'no-source-data' },
    {
      label: 'a markers-only device',
      keys: {
        'knowledge-dungeon:locale': 'en',
        'kd-quest-step': '3',
        'kd-village-spawn': '{"gridX":1,"gridY":2}',
        'knowledge-dungeon:ui:touch-hint:v1': '1',
      },
      expected: 'no-source-data',
    },
    {
      label: 'a sprite-packs-only device',
      keys: {
        'knowledge-dungeon:locale': 'en',
        'knowledge-dungeon:custom-sprites:packs': JSON.stringify(['synthetic-pack']),
      },
      expected: 'no-source-data',
    },
    {
      label: 'a device with only the default shortcuts',
      keys: {
        'knowledge-dungeon:locale': 'en',
        [SHORTCUTS_KEY]: JSON.stringify(
          canonicalShortcutBindings.map((labelKey) => ({
            label: 'Synthetic default',
            labelKey,
            defaultKey: 'x',
            key: { 'shortcuts.toggleHelp': '/', 'shortcuts.toggleMap': 'm', 'shortcuts.toggleInfoPanel': 'i' }[labelKey] ?? 'x',
            ctrlKey: false,
            shiftKey: false,
          })),
        ),
      },
      expected: 'no-source-data',
    },
    {
      label: 'a preferences-only device',
      keys: {
        'knowledge-dungeon:locale': 'en',
        [PREFERENCES_KEY]: JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'colorful' }),
      },
      // Preferences are content by decision: the presence of the key means a
      // learner deliberately chose a theme.
      expected: 'migrated',
    },
    {
      label: 'a recovery-record-only device',
      keys: {
        'knowledge-dungeon:locale': 'en',
        'knowledge-dungeon:corrupt:subject-phase4-quarantined': '{"dungeon":',
      },
      expected: 'migrated',
    },
    { label: 'a device with one subject', keys: seedTwoSubjectMinimal(), expected: 'migrated' },
    {
      label: 'a device with an unindexed subject payload only',
      keys: {
        'knowledge-dungeon:locale': 'en',
        [`knowledge-dungeon:v1:subject:${'subject-phase4-unindexed'}`]: JSON.stringify(
          syntheticSnapshot({
            dungeon: {
              ...syntheticSnapshot().dungeon,
              dungeonId: 'subject-phase4-unindexed',
              subjectName: 'Phase4 Independent Unindexed Synthetic Subject',
            },
          } as never),
        ),
      },
      // A payload is content, and it is disclosed as unindexed.
      expected: 'migrated',
    },
    {
      label: 'a device with non-default shortcuts',
      keys: {
        'knowledge-dungeon:locale': 'en',
        [SHORTCUTS_KEY]: JSON.stringify([
          { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: 'q', ctrlKey: false, shiftKey: false },
        ]),
      },
      expected: 'migrated',
    },
    {
      label: 'a device with a single custom sprite override',
      keys: {
        'knowledge-dungeon:locale': 'en',
        'knowledge-dungeon:custom-sprites:override:player-hero': '<svg data-probe="override" />',
      },
      expected: 'migrated',
    },
    { label: 'a completely empty device', keys: {}, expected: 'no-source-data' },
  ];

  for (const testCase of CASES) {
    it(`classifies ${testCase.label} as ${testCase.expected}`, async () => {
      write(testCase.keys);
      const state = readLegacyAppState({ storage: keysToStorage(testCase.keys) });
      // The predicate itself, and the two questions it must keep apart.
      expect(hasNoLearnerContent(state), 'hasNoLearnerContent').toBe(testCase.expected === 'no-source-data');
      // A markers-only device is *not* an empty device, and must not be reported
      // as one: the keys are still there and the report still accounts for them.
      if (testCase.expected === 'no-source-data' && Object.keys(testCase.keys).length > 0) {
        expect(isEmptyLegacyAppState(state), 'isEmptyLegacyAppState').toBe(false);
      }
      // And the migration agrees with the predicate.
      const repo = await openTracked(`content-${testCase.expected}`);
      const outcome = await migrateLegacyState({
        repository: repo,
        generationId: 'gen-phase4-content',
        now: NOW,
        clock: { now: () => NOW },
      });
      expect(outcome.report.status, testCase.label).toBe(testCase.expected);
      if (testCase.expected === 'no-source-data') {
        // Nothing was staged, no receipt exists, and the pointer never moved.
        expect(outcome.stagedGenerationId).toBeNull();
        expect(await repo.listMigrationReceipts()).toEqual([]);
        expect(await repo.readActiveGenerationId()).toBeNull();
        // The report still accounts for the keys it read: counts only.
        expect(outcome.report.legacyKeys).toEqual(
          expect.objectContaining({ present: expect.any(Number) }),
        );
        for (const value of Object.values(outcome.report.legacyKeys)) {
          expect(typeof value).toBe('number');
        }
      } else {
        expect(outcome.report.activated).toBe(true);
        expect(await repo.listMigrationReceipts()).toHaveLength(1);
      }
      // And the legacy device is byte-identical whatever the classification.
      expect(legacyKeySet()).toEqual(testCase.keys);
    });
  }

  it('a legitimate learner device still migrates every kind of content', async () => {
    // The over-correction risk: a predicate that is too eager would report
    // `no-source-data` for a device that has real data, and the learner would lose
    // the migration while the app looked healthy.
    const device: Database = {
      ...twoSubjectDevice(),
      'knowledge-dungeon:locale': 'en',
      'kd-quest-step': '2',
      'knowledge-dungeon:custom-sprites:override:player-hero': '<svg data-probe="override" />',
      'knowledge-dungeon:corrupt:subject-phase4-quarantined': '{"dungeon":',
      'knowledge-dungeon:custom-sprites:packs': JSON.stringify(['synthetic-pack']),
    };
    write(device);
    const state = readLegacyAppState({ storage: keysToStorage(device) });
    expect(hasNoLearnerContent(state)).toBe(false);
    const repo = await openTracked('learner-device');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-learner-device',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(outcome.report.status).toBe('migrated');
    const records = (await repo.readRecords('gen-phase4-learner-device')).records;
    expect(records.subjects).toHaveLength(2);
    expect(records.sessions.length).toBeGreaterThan(0);
    expect(records.customSprites.length).toBeGreaterThan(0);
    expect(records.recovery.length).toBeGreaterThan(0);
    expect(outcome.report.legacyKeys.present).toBeGreaterThanOrEqual(8);
  });

  it('a first real write after no-source-data creates the initial generation', async () => {
    // The other half of the fix: reporting `no-source-data` must not leave the
    // device unable to be written to.
    write({ 'knowledge-dungeon:locale': 'en' });
    const repo = await openTracked('first-write');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-migration',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(outcome.report.status).toBe('no-source-data');
    expect(await repo.readActiveGenerationId()).toBeNull();

    // The bootstrap's own answer for a device with nothing to migrate.
    const { ensureInitialGeneration, INITIAL_GENERATION_ID } = await import(
      '@/services/persistence/v2/appState'
    );
    const created = await ensureInitialGeneration(repo, {
      generationId: INITIAL_GENERATION_ID,
      now: NOW,
    });
    expect(created).toBe(INITIAL_GENERATION_ID);
    expect(await repo.readActiveGenerationId()).toBe(INITIAL_GENERATION_ID);

    // And a real write lands in it.
    selectStorageV2Repository(repo);
    const { writeSubjectToActiveGeneration } = await import('@/services/persistence/v2/appRepository');
    await writeSubjectToActiveGeneration(repo, SUBJECT_ID, syntheticSnapshot(), NOW);
    const records = (await repo.readRecords(INITIAL_GENERATION_ID)).records;
    expect(records.subjects.map((envelope) => envelope.recordId)).toEqual([SUBJECT_ID]);
    expect((await repo.validateGeneration(INITIAL_GENERATION_ID)).ok).toBe(true);
    // Idempotent: a second call does not create a second generation.
    expect(
      await ensureInitialGeneration(repo, { generationId: INITIAL_GENERATION_ID, now: NOW }),
    ).toBe(INITIAL_GENERATION_ID);
  });
});

// ── helpers that read a source file without importing it ───────────────────

function readFileSyncIfPresent(relativePath: string): string {
  // Read from disk at call time, so the "no literal" assertion is about the
  // *current* source rather than about what was compiled into this module.
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

/** A `SubjectRecordValue`-shaped value, for the record-id assertions. */
export type { SubjectRecordValue };
