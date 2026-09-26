/**
 * Regression: the flagged build's progression *write* path was unversioned, so the
 * round trip was not a fixed point.
 *
 * ── History: this file was QA's registered red reproduction, not a passing test ──
 *
 * Every test in it was written while the defect was live, and the two `BLOCKER:`
 * tests were *expected red*. It is kept as-is in structure, with the framing
 * dropped, because the sequence of assertions is the finding: a red reproduction
 * that is rewritten to pass in one line loses the record of what was wrong.
 *
 * `progressionStore.savePersistedBySubject` handed the storage-v2 writer
 *
 * ```ts
 * publishProgressionToActiveGeneration(repository, { bySubject, crossSubjectAchievements }, now)
 * ```
 *
 * — an object with **no `version`**. `publishProgressionToActiveGeneration` runs
 * that through `normalizeProgressionRecord`, and the normaliser decides between
 * "a map of per-subject records" and "one flat record" by reading
 * `envelope.version`. With no marker the payload is read as a v1 flat record, so
 * the whole `bySubject` map is filed as ONE record under the legacy bucket
 * (`__legacy__`, because the writer passes no active subject) with every real
 * per-subject value buried in that record's `extraFields`.
 *
 * `putRecords` merges rather than replaces, so that `__legacy__` record is never
 * removed: it is permanent for the life of the generation, and every later reload
 * of the flagged build hydrates a phantom zeroed subject.
 *
 * The read side was fixed for exactly this hazard first —
 * `readPersistedProgressionPayload` stamps `version: CANONICAL_PROGRESSION_VERSION`
 * and says why. The write side was not, and the consequence was worse than state
 * pollution.
 *
 * ── Severity: blocker, not should-fix ──────────────────────────────────────
 *
 * The per-subject records kept the snapshot the *migration* staged, because the
 * post-action state never reached a readable position in any record. So in the
 * flagged build **no progression earned after the migration was ever durable in
 * the authoritative store**:
 *
 *   in memory  → the badge is there (the store updated correctly)
 *   generation → one zeroed `__legacy__` record, the real map nested in
 *                `extraFields.bySubject`, per-subject records still pre-action
 *   reload     → the badge is gone
 *   legacy key → the badge is there, so a default/rollback build shows it
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 *
 * `publishProgressionToActiveGeneration` now stamps
 * `version: CANONICAL_PROGRESSION_VERSION` itself, before normalising, because its
 * parameter is `unknown` and it is therefore the only place that can guarantee the
 * payload is read as the shape it is. `progressionStore.savePersistedBySubject`
 * stamps it too, deliberately, so the two cannot drift apart about the contract.
 *
 * That is silent, learner-visible loss of every progression action in the flagged
 * build, plus divergence between the two modes: the same learner, the same action,
 * a different answer depending on which build reads the data. It is the exact
 * failure the read-side fix describes ("silent, learner-visible loss on every
 * flagged-build reload"); the read path was repaired but the write path still
 * manufactures the same corruption.
 *
 * What the boundary test still asserts is worth keeping: the staged snapshot and
 * the legacy mirror survive *any* write. An earlier draft of that test read as
 * "the learner's data is not lost", which was true only because it inspected the
 * pre-action values — it is written here to state exactly what survives and what
 * does not, so it cannot be misread as reassurance either way.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SUBJECT_ID, NOW, ROOT_ROOM_ID, openRepo, dropRepo, seedLegacyKeys, syntheticSnapshot, legacyKeySet, PROGRESSION_KEY } from './support/phase4Support';

import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import { readAppStateFromLegacy, readAppStateFromStorageV2 } from '@/services/persistence/v2/appState';
import { resetRepositorySelection, selectStorageV2Repository } from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports } from '@/services/persistence/v2/dualWrite';
import { useProgressionStore } from '@/store/progressionStore';
import {
  CANONICAL_PROGRESSION_VERSION,
  normalizeProgressionRecord,
} from '@/core/progression/canonicalProgression';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const SECOND_ID = 'subject-phase4-second';
const GENERATION_ID = 'gen-phase4-write-path';

let repository: StorageV2Repository | null = null;

async function flaggedDevice(): Promise<StorageV2Repository> {
  const repo = await openRepo('write-path');
  repository = repo;
  const outcome = await migrateLegacyState({
    repository: repo,
    generationId: GENERATION_ID,
    now: NOW,
    clock: { now: () => NOW },
  });
  expect(outcome.report.status).toBe('migrated');
  selectStorageV2Repository(repo);
  return repo;
}

function twoSubjects(): void {
  window.localStorage.clear();
  seedLegacyKeys();
  const base = syntheticSnapshot();
  window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_ID, SECOND_ID]));
  window.localStorage.setItem(
    `knowledge-dungeon:v1:subject:${SECOND_ID}`,
    JSON.stringify(syntheticSnapshot({ dungeon: { ...base.dungeon, dungeonId: SECOND_ID } } as never)),
  );
  const record = (xpTotal: number, badges: string[]) => ({
    xpTotal,
    rank: 'Novice',
    badges,
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
  window.localStorage.setItem(
    PROGRESSION_KEY,
    JSON.stringify({
      version: 3,
      bySubject: { [SUBJECT_ID]: record(17, ['synthetic-phase4-seed-badge']), [SECOND_ID]: record(5, ['synthetic-phase4-second-badge']) },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    }),
  );
}

async function reloadFlagged(repo: StorageV2Repository): Promise<void> {
  const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
  useProgressionStore.getState().hydrateProgression(state.progression);
}

/**
 * Wait for the legacy mirror to reflect the award.
 *
 * This is the settle signal for the write path as a whole: the mirror is written
 * on every save, buggy or fixed, so waiting on it never turns a fix into a
 * timeout — unlike waiting for the badge to appear in the generation, which is
 * precisely what the defect prevents and therefore cannot be used as a wait.
 */
async function waitForAwardedBadgeInMirror(_repo: StorageV2Repository, badge: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const raw = window.localStorage.getItem(PROGRESSION_KEY);
    if (raw !== null) {
      const payload = JSON.parse(raw) as {
        bySubject: Record<string, { badges?: readonly string[] }>;
      };
      if ((payload.bySubject[SUBJECT_ID]?.badges ?? []).includes(badge)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the awarded badge ${badge} never reached the legacy mirror`);
}

beforeEach(() => {
  twoSubjects();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  await dropRepo('write-path');
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

describe('the flagged build keeps every subject\'s own progression slice on every write', () => {
  it('one ordinary learner action adds no phantom and loses no badge', async () => {
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    expect(Object.keys(useProgressionStore.getState().bySubject).sort()).toEqual([
      SUBJECT_ID,
      SECOND_ID,
    ]);

    // The most ordinary progression write there is.
    useProgressionStore.getState().awardBadge('synthetic-phase4-awarded-badge');
    // Settle on the mirror, not the generation: the defect is precisely that the
    // generation never receives the badge, so waiting for it there would report a
    // timeout instead of the pollution this test exists to show.
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-awarded-badge');
    const records = (await repo.readRecords(GENERATION_ID)).records.progression;

    // Expected: one record per real subject, and no bucket record.
    expect(records.map((envelope) => envelope.recordId).sort()).toEqual([SUBJECT_ID, SECOND_ID]);
  });

  it('repeated writes never accumulate a bucket record', async () => {
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    useProgressionStore.getState().awardBadge('synthetic-phase4-awarded-badge');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-awarded-badge');
    useProgressionStore.getState().awardBadge('synthetic-phase4-second-award');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-second-award');
    useProgressionStore.getState().awardBadge('synthetic-phase4-third-award');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-third-award');
    // `putRecords` merges, so nothing removes the stray record, however many
    // writes follow it.
    const records = (await repo.readRecords(GENERATION_ID)).records.progression;
    expect(records.map((envelope) => envelope.recordId)).not.toContain('__legacy__');
  });

  it('the next reload hydrates the two real subjects and no phantom', async () => {
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    useProgressionStore.getState().awardBadge('synthetic-phase4-awarded-badge');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-awarded-badge');

    await reloadFlagged(repo);
    const keys = Object.keys(useProgressionStore.getState().bySubject).sort();
    // Expected: the two real subjects, unchanged in value.
    expect(keys).toEqual([SUBJECT_ID, SECOND_ID]);
    // And the phantom is visible to any consumer that enumerates the map, with
    // zeroed values that are not the learner's.
    expect(useProgressionStore.getState().bySubject['__legacy__']).toBeUndefined();
  });

  it('the writer canonicalises an unversioned payload, so the shapes cannot disagree', () => {
    // The precise shape mismatch, isolated from any storage: the reader emits a
    // versioned envelope, the writer hands the normaliser an unversioned object.
    const store = useProgressionStore.getState();
    const asTheWriterSendsIt = {
      bySubject: { [SUBJECT_ID]: store.bySubject[SUBJECT_ID], [SECOND_ID]: store.bySubject[SECOND_ID] },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    };
    const asTheReaderEmitsIt = {
      version: 3,
      bySubject: { ...asTheWriterSendsIt.bySubject },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    };
    const fromWriter = normalizeProgressionRecord(asTheWriterSendsIt, {
      createId: (p: 'loot' | 'gear') => `${p}-x`,
    });
    const fromReader = normalizeProgressionRecord(asTheReaderEmitsIt, {
      createId: (p: 'loot' | 'gear') => `${p}-x`,
    });
    // The versioned one is recognised as the by-subject map.
    expect(Object.keys(fromReader.bySubject).sort()).toEqual([SUBJECT_ID, SECOND_ID]);
    expect(fromReader.bySubject[SUBJECT_ID]?.xpTotal).toBe(17);
    // Handed the unversioned object, the normaliser reads it as one flat bucket
    // record. That is the hazard, stated on its own: it is why the writer may not
    // pass its input through unchanged.
    expect(fromWriter.sourceVersion).toBe(0);
    expect(Object.keys(fromWriter.bySubject)).toEqual(['__legacy__']);
    // And it is why the writer stamps: with the version added, the *same* object
    // normalises to the by-subject map. Stamping is the whole fix.
    const stamped = { ...asTheWriterSendsIt, version: CANONICAL_PROGRESSION_VERSION };
    const afterStamping = normalizeProgressionRecord(stamped, {
      createId: (p: 'loot' | 'gear') => `${p}-x`,
    });
    expect(Object.keys(afterStamping.bySubject).sort()).toEqual([SUBJECT_ID, SECOND_ID]);
    expect(afterStamping.bySubject[SUBJECT_ID]?.xpTotal).toBe(17);
    expect(Object.keys(afterStamping.bySubject)).not.toContain('__legacy__');
  });

  it('what survives and what does not: the pre-action snapshot and the mirror', async () => {
    // Stated as a boundary rather than as reassurance, because the distinction is
    // the whole finding. Survives: the per-subject records the migration staged,
    // and the legacy mirror the write path also updates. Does not survive: the
    // post-action state, in the authoritative store — see the two tests below.
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    useProgressionStore.getState().awardBadge('synthetic-phase4-awarded-badge');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-awarded-badge');

    const records = (await repo.readRecords(GENERATION_ID)).records.progression;
    const byId = new Map(
      records.map((envelope) => [envelope.recordId, envelope.value as { bySubject: Record<string, { xpTotal: number }> }]),
    );
    // The staged snapshot is intact: the migration's own values are untouched.
    expect(byId.get(SUBJECT_ID)?.bySubject[SUBJECT_ID]?.xpTotal).toBe(17);
    expect(byId.get(SECOND_ID)?.bySubject[SECOND_ID]?.xpTotal).toBe(5);

    const legacy = readAppStateFromLegacy();
    const legacyProgression = JSON.parse(
      window.localStorage.getItem(PROGRESSION_KEY) as string,
    ) as { bySubject: Record<string, { badges: string[] }> };
    expect(Object.keys(legacyProgression.bySubject).sort()).toEqual([SUBJECT_ID, SECOND_ID]);
    expect(legacyProgression.bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
      'synthetic-phase4-awarded-badge',
    ]);
    // The generation validating is not sufficient evidence of correctness: the
    // counts match because `putRecords` recomputed them, so the phantom record is
    // *counted* correctly and only the read reveals it.
    expect((await repo.validateGeneration(GENERATION_ID)).ok).toBe(true);
    expect(legacy.subjects.map((entry) => entry.id).sort()).toEqual([SUBJECT_ID, SECOND_ID]);
  });

  it('an earned badge is durable in the flagged build', async () => {
    // The learner-visible consequence, stated as the plain claim a learner would
    // make: earn a badge, reload, still have it.
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    useProgressionStore.getState().awardBadge('synthetic-phase4-awarded-badge');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-awarded-badge');

    // In memory it is there, so the store did its job.
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.badges).toContain(
      'synthetic-phase4-awarded-badge',
    );

    await reloadFlagged(repo);
    // After a reload from the authoritative store, it is not.
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
      'synthetic-phase4-awarded-badge',
    ]);
  });

  it('the two builds agree about what the learner earned', async () => {
    // Same store action, same seeded data, two builds, two different answers.
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    useProgressionStore.getState().awardBadge('synthetic-phase4-awarded-badge');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-awarded-badge');

    // What the flagged build — which reads the generation — reports after a reload.
    await reloadFlagged(repo);
    const flaggedBadges = useProgressionStore.getState().bySubject[SUBJECT_ID]?.badges ?? [];

    // What a default/rollback build — which reads the legacy key — reports for the
    // same moment. A single badge, two truths.
    resetRepositorySelection();
    const defaultBadges = (
      readAppStateFromLegacy().progression as { bySubject: Record<string, { badges: string[] }> }
    ).bySubject[SUBJECT_ID]?.badges ?? [];

    expect(defaultBadges).toEqual(flaggedBadges);
  });

  it('the default build is unaffected', async () => {
    // No handle, so the write path stops at the legacy key and the generation is
    // never touched. The same store action, with no pollution anywhere.
    const repo = await flaggedDevice();
    await reloadFlagged(repo);
    resetRepositorySelection();
    useProgressionStore.getState().awardBadge('synthetic-phase4-flag-off-badge');
    await waitForAwardedBadgeInMirror(repo, 'synthetic-phase4-flag-off-badge');
    const legacy = JSON.parse(window.localStorage.getItem(PROGRESSION_KEY) as string) as {
      bySubject: Record<string, { badges: string[] }>;
    };
    expect(legacy.bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
      'synthetic-phase4-flag-off-badge',
    ]);
    expect(legacyKeySet()['knowledge-dungeon:v1:subjects']).toBe(
      JSON.stringify([SUBJECT_ID, SECOND_ID]),
    );
    // The generation is still exactly what the migration staged.
    const records = (await repo.readRecords(GENERATION_ID)).records.progression;
    expect(records.map((envelope) => envelope.recordId).sort()).toEqual([SUBJECT_ID, SECOND_ID]);
    void ROOT_ROOM_ID;
  });
});
