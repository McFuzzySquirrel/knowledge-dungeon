/**
 * The progression *write* path, pinned as a fixed point.
 *
 * The read side was repaired first: `progressionEnvelopeFrom` and
 * `readPersistedProgressionPayload` both stamp
 * `version: CANONICAL_PROGRESSION_VERSION`, so a canonical envelope is recognised
 * as the by-subject shape instead of being read as an unversioned v1 flat record.
 * The write side shipped unversioned, and
 * `tests/phase4/progressionWritePath.test.ts` is QA's reproduction of the
 * consequence. This file covers the same ground at the layer that owns the
 * contract — the record adapter — so the guarantee does not rest on one
 * reproduction and one store call site.
 *
 * What the adapter must guarantee, and why each one matters:
 *
 * 1. An unversioned payload is canonicalised, not passed through. The parameter is
 *    `unknown`, so the adapter is the only place that can enforce the shape.
 * 2. `putRecords` merges, so a write is idempotent: replaying the same payload
 *    cannot duplicate or drift a record. This is what makes a retried, a
 *    StrictMode double-invoke, and an interrupted flow safe.
 * 3. Every subject keeps its own slice. A payload with several subjects must not
 *    collapse onto one record.
 * 4. The generation and the legacy mirror must agree after the same write, because
 *    they are the same fact in two repositories and a rollback build reads the
 *    other one.
 *
 * Privacy: every value here is synthetic, and no assertion carries record content
 * into a failure message beyond ids and counts already used by the phase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dropRepo, openRepo } from './support/phase4Support';
import {
  now as FIXED_NOW,
  seedTwoSubjectDevice,
  syntheticFlatV1Payload,
} from './support/progressionWriteSupport';

import { publishProgressionToActiveGeneration } from '@/services/persistence/v2/appRepository';
import { bootstrapApplication, createDefaultBootstrapDeps, resetBootstrap } from '@/application/bootstrap';
import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import { readAppStateFromStorageV2 } from '@/services/persistence/v2/appState';
import {
  clearDualWriteReports,
  dualWriteReports,
} from '@/services/persistence/v2/dualWrite';
import { resetRepositorySelection, selectStorageV2Repository } from '@/services/persistence/v2/repositorySelection';
import { CANONICAL_PROGRESSION_VERSION, normalizeProgressionRecord } from '@/core/progression/canonicalProgression';
import { useProgressionStore } from '@/store/progressionStore';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const GENERATION_ID = 'gen-progression-write';
const REPO = 'progression-write-adapter';
let repository: StorageV2Repository | null = null;

/** Per-subject records of the active generation, keyed by subject id. */
async function progressionRecords(
  repo: StorageV2Repository,
  generationId = GENERATION_ID,
): Promise<Record<string, { bySubject: Record<string, { badges: string[]; xpTotal: number }>; crossSubjectAchievements: string[]; sourceVersion: number }>> {
  const active = (await repo.readActiveGenerationId()) ?? generationId;
  const records = (await repo.readRecords(active)).records.progression;
  const byId: Record<string, { bySubject: Record<string, { badges: string[]; xpTotal: number }>; crossSubjectAchievements: string[]; sourceVersion: number }> = {};
  for (const envelope of records) {
    byId[envelope.recordId] = envelope.value as never;
  }
  return byId;
}

beforeEach(async () => {
  seedTwoSubjectDevice();
  const repo = await openRepo(REPO);
  repository = repo;
  const outcome = await migrateLegacyState({
    repository: repo,
    generationId: GENERATION_ID,
    now: FIXED_NOW,
    clock: { now: () => FIXED_NOW },
  });
  expect(outcome.report.status).toBe('migrated');
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  await dropRepo(REPO);
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

describe('the progression writer canonicalises whatever it is handed', () => {
  it('an unversioned by-subject payload becomes one record per subject, with no bucket record', async () => {
    // The defect, at the layer that owns it. No `version` on the input: exactly
    // what the store used to pass. Handed straight through, the normaliser reads
    // it as a v1 flat record, files the whole map under `__legacy__`, and buries
    // the real per-subject values in that record's `extraFields` - where no reader
    // looks, and which `putRecords` then keeps forever.
    const repo = repository as StorageV2Repository;
    await publishProgressionToActiveGeneration(
      repo,
      {
        bySubject: {
          'subject-write-a': { xpTotal: 40, badges: ['synthetic-write-badge'] },
          'subject-write-b': { xpTotal: 7, badges: [] },
        },
        crossSubjectAchievements: ['synthetic-write-cross'],
      },
      FIXED_NOW,
    );

    const byId = await progressionRecords(repo);
    expect(Object.keys(byId).sort()).toEqual(['subject-write-a', 'subject-write-b']);
    // The values landed in the per-subject record, which is the only place a
    // reader looks.
    expect(byId['subject-write-a']?.bySubject['subject-write-a']?.xpTotal).toBe(40);
    expect(byId['subject-write-a']?.bySubject['subject-write-a']?.badges).toEqual(['synthetic-write-badge']);
  });

  it('no `__legacy__` bucket record is created, and the real values are not nested in extraFields', async () => {
    // The pollution was permanent for the life of the generation, because
    // `putRecords` merges: a stray record is never removed by a later write. So
    // the assertion is that no such record exists *at all*, and that the values
    // are not merely present somewhere unreadable.
    const repo = repository as StorageV2Repository;
    await publishProgressionToActiveGeneration(
      repo,
      { bySubject: { 'subject-write-a': { xpTotal: 12, badges: ['synthetic-extra-check'] } } },
      FIXED_NOW,
    );

    const records = (await repo.readRecords((await repo.readActiveGenerationId()) as string)).records.progression;
    expect(records.map((envelope) => envelope.recordId)).not.toContain('__legacy__');
    const written = records.find((envelope) => envelope.recordId === 'subject-write-a');
    const value = written?.value as { bySubject: Record<string, { xpTotal: number; extraFields?: unknown }> };
    expect(Object.keys(value.bySubject)).toEqual(['subject-write-a']);
    // `extraFields` is the reserved key the pre-phase reader flattens unknown
    // fields into. A real value must not be hiding in it.
    expect(value.bySubject['subject-write-a']?.xpTotal).toBe(12);
    expect(JSON.stringify(value.bySubject['subject-write-a']?.extraFields ?? {})).toBe('{}');
  });

  it('a generation with several subjects keeps every subject\'s own slice', async () => {
    // Distinct values per subject, because a merged record would still hold *a*
    // record per subject while silently conflating the values.
    const repo = repository as StorageV2Repository;
    await publishProgressionToActiveGeneration(
      repo,
      {
        bySubject: {
          'subject-write-a': { xpTotal: 40, badges: ['synthetic-a-badge'] },
          'subject-write-b': { xpTotal: 7, badges: ['synthetic-b-badge'] },
          'subject-write-c': { xpTotal: 99, badges: [] },
        },
      },
      FIXED_NOW,
    );

    const byId = await progressionRecords(repo);
    expect(Object.keys(byId).sort()).toEqual(['subject-write-a', 'subject-write-b', 'subject-write-c']);
    for (const [subjectId, expected] of [
      ['subject-write-a', 40],
      ['subject-write-b', 7],
      ['subject-write-c', 99],
    ] as const) {
      // One record, holding exactly one subject's slice, holding that subject's
      // value.
      expect(Object.keys(byId[subjectId]?.bySubject ?? {}), subjectId).toEqual([subjectId]);
      expect(byId[subjectId]?.bySubject[subjectId]?.xpTotal, subjectId).toBe(expected);
    }
  });

  it('crossSubjectAchievements survives a write and reload round trip', async () => {
    const repo = repository as StorageV2Repository;
    await publishProgressionToActiveGeneration(
      repo,
      {
        bySubject: { 'subject-write-a': { xpTotal: 1 } },
        crossSubjectAchievements: ['synthetic-write-cross', 'synthetic-write-cross-2'],
      },
      FIXED_NOW,
    );

    // The record the writer produced carries exactly the list it was given.
    const written = (await progressionRecords(repo))['subject-write-a'];
    expect(written?.crossSubjectAchievements).toEqual([
      'synthetic-write-cross',
      'synthetic-write-cross-2',
    ]);

    // Read back through the real reader, the way a reload does. The reader unions
    // the per-subject records, so the seeded subjects' own list is present too:
    // the point is that everything written is still there, not that a merge
    // replaced what other records already held.
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: 'subject-write-a' });
    const progression = state.progression as { crossSubjectAchievements: string[]; version?: number };
    expect(progression.crossSubjectAchievements).toEqual(
      expect.arrayContaining(['synthetic-write-cross', 'synthetic-write-cross-2']),
    );
    // And the reader's own envelope is versioned, so hydrating it is idempotent.
    expect(progression.version).toBe(CANONICAL_PROGRESSION_VERSION);
  });

  it('a repeated write with an unchanged payload is idempotent', async () => {
    // `putRecords` merges, so a replayed write is a no-op rather than a duplicate
    // or a drift. This is what makes a retried write, a StrictMode double-invoke,
    // and an interrupted flow safe.
    const repo = repository as StorageV2Repository;
    const payload = {
      bySubject: { 'subject-write-a': { xpTotal: 21, badges: ['synthetic-idem'] } },
      crossSubjectAchievements: ['synthetic-idem-cross'],
    };

    await publishProgressionToActiveGeneration(repo, payload, FIXED_NOW);
    const first = await progressionRecords(repo);
    await publishProgressionToActiveGeneration(repo, payload, FIXED_NOW);
    await publishProgressionToActiveGeneration(repo, { ...payload }, FIXED_NOW);
    const third = await progressionRecords(repo);

    expect(Object.keys(third).sort()).toEqual(Object.keys(first).sort());
    expect(third['subject-write-a']?.bySubject['subject-write-a']?.xpTotal).toBe(21);
    expect(third['subject-write-a']?.bySubject['subject-write-a']?.badges).toEqual(['synthetic-idem']);
    // The badge list did not grow either: a replay is not an append.
    expect(third['subject-write-a']?.bySubject['subject-write-a']?.badges).toHaveLength(1);
    // And the generation still validates, so the merge left it internally
    // consistent rather than merely readable.
    const active = (await repo.readActiveGenerationId()) as string;
    expect((await repo.validateGeneration(active)).ok).toBe(true);
  });

  it('a v1 flat record round-trips without being re-classified as flat', async () => {
    // A v1 payload is migrated into a per-subject record once, and from then on it
    // is a by-subject record like any other. Re-persisting it must not read it as
    // flat again and re-create the bucket.
    const repo = repository as StorageV2Repository;
    const flat = syntheticFlatV1Payload();
    // The migration's own view: a v1 payload is one record, filed under the legacy
    // bucket, because that is what a flat record *is*.
    const migrated = normalizeProgressionRecord(flat, { activeSubjectId: null });
    expect(migrated.sourceVersion).toBe(0);
    expect(Object.keys(migrated.bySubject)).toEqual(['__legacy__']);

    await publishProgressionToActiveGeneration(repo, migrated, FIXED_NOW);
    const byId = await progressionRecords(repo);

    // Persisted as the bucket subject it genuinely is - not as a new flat reading
    // of a per-subject map, which is the defect.
    expect(Object.keys(byId['__legacy__']?.bySubject ?? {})).toEqual(['__legacy__']);
    expect(byId['__legacy__']?.bySubject['__legacy__']?.xpTotal).toBe(flat.xpTotal);
    // The provenance says the shape that was just persisted, which is current.
    expect(byId['__legacy__']?.sourceVersion).toBe(CANONICAL_PROGRESSION_VERSION);
    // And it merged rather than replacing: the two real subjects the migration
    // staged are still there with their own values, so re-persisting a v1 record
    // changed nothing about them.
    expect(byId['subject-write-a']?.bySubject['subject-write-a']?.xpTotal).toBe(17);
    expect(byId['subject-write-b']?.bySubject['subject-write-b']?.xpTotal).toBe(5);
  });

  it('the generation and the legacy mirror agree after the same write', async () => {
    // One fact, two repositories. A rollback build reads the mirror, so a
    // disagreement means the same learner, the same action, two different answers.
    const repo = repository as StorageV2Repository;
    const envelope = {
      bySubject: { 'subject-write-a': { xpTotal: 55, badges: ['synthetic-agree'] } },
      crossSubjectAchievements: ['synthetic-agree-cross'],
    };
    await publishProgressionToActiveGeneration(repo, envelope, FIXED_NOW);

    // The flag on, so the store's own write reaches the generation as well as the
    // mirror. With it off the store writes the mirror only, which is the
    // documented default-build behaviour and not what this test is about.
    selectStorageV2Repository(repo);

    // The mirror the store writes for the same payload, through the same values.
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: 'subject-write-a' });
    useProgressionStore.getState().hydrateProgression(state.progression);
    useProgressionStore.getState().setActiveSubject('subject-write-a');
    useProgressionStore.getState().awardBadge('synthetic-agree-mirror');
    await vi.waitFor(() =>
      expect(
        (
          JSON.parse(window.localStorage.getItem('knowledge-dungeon:v1:progression') as string) as {
            bySubject: Record<string, { badges: string[] }>;
          }
        ).bySubject['subject-write-a']?.badges,
      ).toContain('synthetic-agree-mirror'),
    );

    // Whatever the mirror now says, the generation must say the same.
    const byId = await progressionRecords(repo);
    const mirror = (
      JSON.parse(window.localStorage.getItem('knowledge-dungeon:v1:progression') as string) as {
        bySubject: Record<string, { badges: string[]; xpTotal: number }>;
        crossSubjectAchievements: string[];
      }
    );
    const fromGeneration = byId['subject-write-a']?.bySubject['subject-write-a'];
    expect(fromGeneration?.badges).toEqual(mirror.bySubject['subject-write-a']?.badges);
    expect(fromGeneration?.xpTotal).toBe(mirror.bySubject['subject-write-a']?.xpTotal);
    expect(byId['subject-write-a']?.crossSubjectAchievements).toEqual(
      mirror.crossSubjectAchievements,
    );
    // And no failure was reported along the way.
    expect(dualWriteReports().filter((report) => report.outcome !== 'written')).toEqual([]);
  });

  it('progression earned after a write is still there after a reload through the real bootstrap', async () => {
    // The learner-visible claim, through the real entry path rather than a
    // hand-assembled read: earn a badge, reload, still have it.
    const repo = repository as StorageV2Repository;
    selectStorageV2Repository(repo);
    await readAppStateFromStorageV2(repo, { activeSubjectId: 'subject-write-a' }).then((state) => {
      useProgressionStore.getState().hydrateProgression(state.progression);
    });
    useProgressionStore.getState().setActiveSubject('subject-write-a');
    useProgressionStore.getState().awardBadge('synthetic-reload-durable');
    await vi.waitFor(() => {
      const mirror = (
        JSON.parse(window.localStorage.getItem('knowledge-dungeon:v1:progression') as string) as {
          bySubject: Record<string, { badges: string[] }>;
        }
      ).bySubject['subject-write-a']?.badges;
      expect(mirror ?? []).toContain('synthetic-reload-durable');
    });

    // The real bootstrap, on the flagged repository, with the real stores.
    resetBootstrap();
    const result = await bootstrapApplication(
      createDefaultBootstrapDeps({ repository: 'v2', generationId: GENERATION_ID }),
    );
    expect(result.repository).toBe('v2');

    expect(useProgressionStore.getState().bySubject['subject-write-a']?.badges).toContain(
      'synthetic-reload-durable',
    );
    // And no phantom appeared on the way.
    expect(Object.keys(useProgressionStore.getState().bySubject)).not.toContain('__legacy__');
  });
});

describe('sourceVersion on a written record', () => {
  it('is the current shape, even for a record that arrived as v1', async () => {
    // The decision, pinned. `sourceVersion` is provenance: the shape the writer
    // *read*. The writer stamps the current version before normalising, so what it
    // read is always current-shaped, and reporting the current version is the
    // truthful answer. Overwriting the original is not a loss of history: the
    // migration recorded the arriving shape once, in
    // `report.progressionSourceVersions`, which is where provenance belongs.
    const repo = repository as StorageV2Repository;
    const migrated = normalizeProgressionRecord(syntheticFlatV1Payload(), { activeSubjectId: null });
    expect(migrated.sourceVersion).toBe(0);

    await publishProgressionToActiveGeneration(repo, migrated, FIXED_NOW);
    const byId = await progressionRecords(repo);
    expect(byId['__legacy__']?.sourceVersion).toBe(CANONICAL_PROGRESSION_VERSION);
  });

  it('the migration is where the arriving shape is recorded', async () => {
    // The other half of the decision: the original version is not thrown away, it
    // is recorded once by the run that read the source.
    const repo = repository as StorageV2Repository;
    window.localStorage.setItem('knowledge-dungeon:v1:progression', JSON.stringify(syntheticFlatV1Payload()));
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-progression-write-v1',
      now: FIXED_NOW,
      clock: { now: () => FIXED_NOW },
    });

    // A v1 payload was read, and the receipt says so.
    expect(outcome.report.progressionSourceVersions).toEqual({ 0: 1 });
    const records = (await repo.readRecords('gen-progression-write-v1')).records.progression;
    expect(records[0]?.value.sourceVersion).toBe(0);
  });
});
