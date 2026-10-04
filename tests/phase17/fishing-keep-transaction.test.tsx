/**
 * The catch transaction as the DOM drives it: four outcomes, one commit, and no console output.
 *
 * ## The four defects this file exists to pin
 *
 * `VillageScreen.handleKeepFish` was the whole catch transaction, and it was wrong in ways the
 * layer that owns the domain could not fix from outside `src/ui/**`:
 *
 * 1. **A keep with no recall material was a correct answer.** The recall dialog's no-question
 *    branch rendered a "Keep Fish" button wired to `onSelfEvaluate('correct')`, which reached
 *    this handler and paid `FSH_XP_PER_CORRECT_ANSWER`. Phase 17's scope: "Record a distinct
 *    outcome when a fish is kept without recall material rather than treating it as a correct
 *    answer." Here that is the `kept-without-recall` outcome: the fish is kept, the XP is zero.
 * 2. **A failed recall awarded nothing by accident, not by rule.** The handler cleared the
 *    catch state and that was it. Here it commits `answered-incorrect`, and the assertion is a
 *    **byte-identical diff of the whole progression value** - not "XP did not change", which a
 *    badge unlock or a ledger row could satisfy while something else moved.
 * 3. **The subject was insertion order.** `Object.keys(bySubject)[length - 1]`, described in its
 *    own comment as "the most recently active one", is the last *key* of an object, with a
 *    literal `'village'` as the fallback. Here the subject is the **session's** subject, and the
 *    test creates two subjects so that "last created" and "the one the learner is fishing" are
 *    different values - which is the only way a fix to this is distinguishable from the defect.
 * 4. **Two `console.log`s printed the XP, the rank, and the joined badge ids** on every catch.
 *    Asserted as an absence over the screen's source *and* over this module's: a `console.log`
 *    in a child's application is a leak, and a `console.error` would be the same defect wearing
 *    a different word.
 *
 * ## Why the three "writes nothing" outcomes are diffed separately
 *
 * `answered-incorrect` and `released` must both leave progression byte-identical, and
 * `kept-without-recall` must leave *everything except the fish entry and the badges* identical -
 * it pays no XP but it is a real catch. A single assertion over all four could not tell those
 * apart, so each is its own diff.
 *
 * Hermeticity: no renderer, no network, no real clock in the transaction itself. The stores are
 * re-imported per test because hydration is explicit in Phase 4.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { FISH_CATALOG } from '@/core/fishing/fishingTypes';
import { FISHING_RECALL_CHOICES } from '@/ui/components/FishingRecallModal';

const SUBJECT_ID = 'synthetic-dom-fishing-subject';
const SUBJECT_NAME = 'Synthetic DOM Fishing Subject';
const OTHER_SUBJECT_ID = 'synthetic-dom-other-subject';
const POND_ID = 'synthetic-dom-pond';
const ROOM_A = 'synthetic-dom-room-a';
const NOW = '2026-11-11T11:11:11.000Z';

const CARP = FISH_CATALOG.find((entry) => entry.id === 'moss-carp')!;

/**
 * A one-room, fully cleared dungeon.
 *
 * Cleared, so `pullRecallQuestion` has material and the "answered" outcomes are reachable; the
 * no-question path is exercised by the dialog's own tests and by `resolveRecallOutcome` below,
 * which is where "there was no question" is *decided*.
 */
function snapshot(): SubjectSnapshot {
  const room = (roomId: string): RoomMetadata => ({
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
  });
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM_A,
    rooms: [{ roomId: ROOM_A, topic: `synthetic-topic-${ROOM_A}`, status: 'ArtifactCollected' }],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM_A]: room(ROOM_A) } };
}

/**
 * The transaction module, freshly imported.
 *
 * **Not** a static import, and the reason is the module graph rather than style.
 * `src/ui/fishing/fishingSession.ts` closes over `fishingSessionSlot` from
 * `src/store/fishingCommands.ts` at *its own* module load. `vi.resetModules()` - which a store
 * reload needs, because hydration is explicit in Phase 4 - would hand the test a **new** store
 * module while the statically-imported transaction still held the **old** one, so the slot it
 * writes would not be the slot the test set. Two module instances, one test, and every
 * transaction would refuse with `NO_OPEN_SESSION` for reasons that have nothing to do with the
 * behaviour under test.
 */
type TransactionModule = typeof import('@/ui/fishing/fishingSession');

/**
 * A begun session, in the real module-level slot.
 *
 * Two subject records are created deliberately: `OTHER_SUBJECT_ID` first, so its key sorts
 * *before* the fishing subject's, and the pre-Phase-17 `Object.keys(bySubject)[length - 1]`
 * would have picked it if insertion order were preserved - making "the session's subject" and
 * "the last record" different values in this fixture rather than accidentally equal.
 */
async function begunSession(): Promise<{
  progression: typeof import('@/store/progressionStore').useProgressionStore;
  tx: TransactionModule;
}> {
  vi.resetModules();
  const subjectMod = await import('@/store/subjectStore');
  const progressionMod = await import('@/store/progressionStore');
  const binding = await import('@/store/fishingCommands');

  // The other subject's record exists *first*.
  progressionMod.useProgressionStore.setState({
    bySubject: {
      [OTHER_SUBJECT_ID]: {
        xpTotal: 10,
        rank: 'Novice',
        badges: [],
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
        extraFields: {},
      },
    },
    activeSubjectId: OTHER_SUBJECT_ID,
  });
  subjectMod.useSubjectStore.getState().setSnapshot(snapshot());
  progressionMod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
  binding.fishingSessionSlot.current = null;

  const begun = binding.fishingController.sessionBegin({
    pondId: POND_ID,
    subjectId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
    roomId: ROOM_A,
  });
  if (!begun.ok) throw new Error('expected a session to begin');
  binding.fishingSessionSlot.current = begun.value.context;
  return {
    progression: progressionMod.useProgressionStore,
    tx: await import('@/ui/fishing/fishingSession'),
  };
}

/**
 * The whole progression value, as bytes.
 *
 * `unknown` rather than `Record<string, unknown>`: the store's state is an interface, and an
 * interface without an index signature is not assignable to one - so the honest element type is
 * `unknown` and the caller reads through the store's own getters.
 */
function progressionBytes(store: {
  getState(): ReturnType<typeof structuredClone> extends never ? never : unknown;
}): string {
  return JSON.stringify(store.getState());
}

beforeEach(() => {
  window.localStorage.clear();
});

// The two pure helpers, imported at module scope. They take no session and read no store, so
// there is no reason to reach them through a reset module graph.
const { resolveRecallOutcome, fishingRewardSentence } = await import('@/ui/fishing/fishingSession');

describe('the catch decision vocabulary', () => {
  it('has exactly three choices, and the two-value vocabulary is gone', () => {
    expect([...FISHING_RECALL_CHOICES].sort()).toEqual([
      'answered-correct',
      'answered-incorrect',
      'kept-without-recall',
    ]);
    expect(FISHING_RECALL_CHOICES.has('correct' as never)).toBe(false);
    expect(FISHING_RECALL_CHOICES.has('incorrect' as never)).toBe(false);
  });

  it('an answered outcome with no room is structurally impossible, and resolves to kept-without-recall', () => {
    // `FishingRecallOutcome` has `roomId` only on the two answered members, so "answered
    // correctly with no room" cannot be constructed. This is where that is relied upon: a caller
    // claiming to have answered something with no question behind it commits the third outcome,
    // which pays no XP.
    expect(resolveRecallOutcome('answered-correct', null)).toEqual({ kind: 'kept-without-recall' });
    expect(resolveRecallOutcome('answered-correct', '   ')).toEqual({ kind: 'kept-without-recall' });
    expect(resolveRecallOutcome('answered-correct', ROOM_A)).toEqual({
      kind: 'answered-correct',
      roomId: ROOM_A,
    });
    expect(resolveRecallOutcome('answered-incorrect', ROOM_A)).toEqual({
      kind: 'answered-incorrect',
      roomId: ROOM_A,
    });
    expect(resolveRecallOutcome('kept-without-recall', ROOM_A)).toEqual({
      kind: 'kept-without-recall',
    });
  });
});

describe('a keep with no recall material', () => {
  it('keeps the fish and pays no experience', async () => {
    const { progression, tx } = await begunSession();
    const report = tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'kept-without-recall',
      null,
    );

    expect(report.ok).toBe(true);
    expect(report.outcome).toBe('kept-without-recall');
    // The defect: this used to pay `FSH_XP_PER_CORRECT_ANSWER`.
    expect(report.xpGained).toBe(0);
    // And the fish is still a real catch - it is in the collection.
    const collection = progression.getState().bySubject[SUBJECT_ID].fishCollection;
    expect(collection).toHaveLength(1);
    expect(collection[0]?.catalogId).toBe(CARP.id);
  });

  it('is not recorded as a correct answer anywhere in the ledger', async () => {
    const { progression, tx } = await begunSession();
    tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'kept-without-recall',
      null,
    );
    const fields = progression.getState().bySubject[SUBJECT_ID].extraFields as Record<string, unknown>;
    const ledger = JSON.stringify(fields);
    // The identity is recorded - it is a real catch, and it must be idempotent - but the
    // outcome is the third one, never the first.
    expect(ledger).toContain('kept-without-recall');
    expect(ledger).not.toContain('"outcome":"answered-correct"');
  });
});

describe('a failed recall', () => {
  it('commits the declined outcome rather than clearing state and awarding nothing by accident', async () => {
    const { tx } = await begunSession();
    const report = tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'answered-incorrect',
      ROOM_A,
    );
    // A rule now, not an omission: the transaction itself reports the refusal.
    expect(report.ok).toBe(true);
    expect(report.outcome).toBe('answered-incorrect');
    expect(report.awarded).toBe(false);
    expect(report.xpGained).toBe(0);
  });

  it('leaves the ENTIRE progression value byte-identical', async () => {
    const { progression, tx } = await begunSession();
    const before = progressionBytes(progression);
    tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'answered-incorrect',
      ROOM_A,
    );
    const after = progressionBytes(progression);
    // Not "XP did not change" - not a badge unlock, not a ledger row, not a rank nudge.
    expect(after).toBe(before);
  });
});

describe('a release', () => {
  it('leaves the ENTIRE progression value byte-identical', async () => {
    const { progression, tx } = await begunSession();
    const before = progressionBytes(progression);
    const report = tx.releaseFishingCatch({ catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 });
    expect(report.ok).toBe(true);
    expect(report.outcome).toBe('released');
    expect(report.awarded).toBe(false);
    expect(progressionBytes(progression)).toBe(before);
  });
});

describe('a correct answer', () => {
  it('pays experience, keeps the fish, and reports the amount', async () => {
    const { progression, tx } = await begunSession();
    const report = tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'answered-correct',
      ROOM_A,
    );
    expect(report.ok).toBe(true);
    expect(report.outcome).toBe('answered-correct');
    expect(report.awarded).toBe(true);
    expect(report.xpGained).toBeGreaterThan(0);
    expect(progression.getState().bySubject[SUBJECT_ID].fishCollection).toHaveLength(1);
  });

  it('awards exactly once for the same cast, and says it was a repeat', async () => {
    const { progression, tx } = await begunSession();
    const context = { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 };
    const first = tx.keepFishingCatch(context, 'answered-correct', ROOM_A);
    const second = tx.keepFishingCatch(context, 'answered-correct', ROOM_A);

    expect(first.awarded).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.xpGained).toBe(0);
    // The fish is in the collection once.
    expect(progression.getState().bySubject[SUBJECT_ID].fishCollection).toHaveLength(1);
    // And the learner is told it was a repeat rather than being shown a second reward.
    expect(tx.fishingRewardSentence(second)).toMatch(/already recorded/i);
  });

  it('two casts of the same species are two fish, not one deduplicated catch', async () => {
    // The cast number is half of the catch identity. A constant would collapse these into one
    // and the second fish would vanish, which is why the lane mints a monotonic fallback for
    // the lane that reports no cast number.
    const { progression, tx } = await begunSession();
    tx.keepFishingCatch({ catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 }, 'answered-correct', ROOM_A);
    tx.keepFishingCatch({ catalogId: CARP.id, rarity: CARP.rarity, castNumber: 2 }, 'answered-correct', ROOM_A);
    expect(progression.getState().bySubject[SUBJECT_ID].fishCollection).toHaveLength(2);
  });
});

describe('the subject the fish is filed under', () => {
  it('is the session’s subject, not the last record and not the string "village"', async () => {
    const { progression, tx } = await begunSession();
    tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'answered-correct',
      ROOM_A,
    );
    const state = progression.getState();
    // The other subject's record exists and was created first, so the pre-Phase-17
    // `Object.keys(bySubject)[length - 1]` would have written here.
    expect(state.bySubject[OTHER_SUBJECT_ID].fishCollection).toHaveLength(0);
    expect(state.bySubject[SUBJECT_ID].fishCollection).toHaveLength(1);
    expect(state.bySubject[SUBJECT_ID].fishCollection[0]?.subjectId).toBe(SUBJECT_ID);
    // And never the literal fallback.
    expect(state.bySubject['village']).toBeUndefined();
  });
});

describe('no session', () => {
  it('refuses a keep, in a sentence, rather than writing against a guessed subject', async () => {
    const { tx } = await begunSession();
    const binding = await import('@/store/fishingCommands');
    binding.fishingSessionSlot.current = null;

    const report = tx.keepFishingCatch(
      { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 },
      'answered-correct',
      ROOM_A,
    );
    expect(report.ok).toBe(false);
    expect(report.awarded).toBe(false);
    expect(report.message).toMatch(/no longer open/i);
    expect(fishingRewardSentence(report)).toBe(report.message);
  });
});

describe('no console output', () => {
  it('the screen no longer logs the XP, the rank, or the badge ids on a catch', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/ui/screens/VillageScreen.tsx'),
      'utf8',
    );
    // The exact pre-Phase-17 statements, which printed `[Fishing] XP gained:` and
    // `[Fishing] New badges earned:` on every single catch. The screen's own header still *names*
    // them in prose, which is why the absence is asserted against a **call**, not the word: a
    // documentation-only mention of `console.log` is this file explaining the defect.
    expect(source).not.toContain('[Fishing] XP gained:');
    expect(source).not.toContain('[Fishing] New badges earned:');
    // And no call of any kind: a `console.error` would be the same defect in a different word.
    expect(source).not.toMatch(/\bconsole\.(log|error|warn|info|debug)\s*\(/);
  });

  it('nor does the transaction module', () => {
    for (const path of [
      'src/ui/fishing/fishingSession.ts',
      'src/ui/fishing/fishingRecallNavigation.ts',
      'src/ui/components/FishingRecallModal.tsx',
      'src/ui/components/FishStandPanel.tsx',
      'src/ui/fishing/FishingHud.tsx',
      'src/ui/fishing/FishingCatchPanel.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source, `${path} must not log`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)\s*\(/);
    }
  });

  it('a catch produces no console output at run time either', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { progression, tx } = await begunSession();
      const context = { catalogId: CARP.id, rarity: CARP.rarity, castNumber: 1 };
      tx.keepFishingCatch(context, 'answered-correct', ROOM_A);
      tx.keepFishingCatch(context, 'answered-incorrect', ROOM_A);
      tx.releaseFishingCatch(context);
      expect(progression.getState().bySubject[SUBJECT_ID].fishCollection.length).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('the reward sentence', () => {
  it('says something for every outcome, and never nothing', () => {
    const cases = [
      { ok: true, awarded: true, duplicate: false, xpGained: 12, outcome: 'answered-correct' as const, message: null },
      { ok: true, awarded: true, duplicate: false, xpGained: 0, outcome: 'kept-without-recall' as const, message: null },
      { ok: true, awarded: false, duplicate: false, xpGained: 0, outcome: 'answered-incorrect' as const, message: null },
      { ok: true, awarded: false, duplicate: false, xpGained: 0, outcome: 'released' as const, message: null },
      {
        ok: false,
        awarded: false,
        duplicate: false,
        xpGained: 0,
        outcome: null,
        message: 'This catch could not be saved because the fishing session is no longer open.',
      },
      // A refusal with no message of its own still gets a sentence: `fishingRewardSentence`
      // falls back rather than rendering an empty live region, which is a silent no-op.
      { ok: false, awarded: false, duplicate: false, xpGained: 0, outcome: null, message: null },
    ];
    for (const report of cases) {
      const sentence = fishingRewardSentence(report);
      expect(sentence.length, `${String(report.outcome)} has no sentence`).toBeGreaterThan(10);
      expect(sentence.endsWith('.'), `${String(report.outcome)}: "${sentence}"`).toBe(true);
    }
  });

  it('tells a learner that a question-less keep earned nothing, rather than implying a reward', () => {
    const sentence = fishingRewardSentence({
      ok: true,
      awarded: true,
      duplicate: false,
      xpGained: 0,
      outcome: 'kept-without-recall',
      message: null,
    });
    expect(sentence).toMatch(/no experience/i);
  });
});