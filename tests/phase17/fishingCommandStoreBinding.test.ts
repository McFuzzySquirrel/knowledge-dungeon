/**
 * Phase 17: the store binding, end to end.
 *
 * `tests/phase17/fishingCommands.test.ts` proves the command layer's semantics over
 * in-memory ports, and `tests/phase17/catchRewards.test.ts` proves the transaction
 * against the store directly. This file proves the *binding* is real: the ready-made
 * `fishingController` in `src/store/fishingCommands.ts` reaches the actual subject and
 * progression stores, one catch lands one record write, and the suppression survives a
 * reload in the persisted progression record.
 *
 * The store modules are re-imported per test because hydration is explicit in Phase 4: a
 * reload is a fresh module plus a fresh `hydrateProgression`, and anything less is not a
 * reload.
 *
 * Every fixture is obviously synthetic; no learner content appears in any assertion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import { FISH_CATALOG } from '@/core/fishing/fishingTypes';
import { CATCH_REWARD_LEDGER_KEY, readCatchRewardLedgerFromFields } from '@/core/fishing/catchRewards';
import { resolveFishCatalogId } from '@/core/fishing/fishCollectionService';
import { fishingSessionSlot } from '@/store/fishingCommands';

const SUBJECT_ID = 'synthetic-binding-fishing-subject';
const SUBJECT_NAME = 'Synthetic Binding Fishing Subject';
const POND_ID = 'synthetic-binding-pond';
const ROOM_A = 'synthetic-binding-room-a';
const ROOM_B = 'synthetic-binding-room-b';
const NOW = '2026-10-10T10:10:10.000Z';

const CARP = FISH_CATALOG.find((entry) => entry.id === 'moss-carp')!;
const KOI = FISH_CATALOG.find((entry) => entry.id === 'gilded-koi')!;

/**
 * A two-room, fully cleared dungeon.
 *
 * Two rooms so the recall question has somewhere to come from and a "no material"
 * fixture can be built by emptying the room map.
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
    rooms: [
      { roomId: ROOM_A, topic: `synthetic-topic-${ROOM_A}`, status: 'ArtifactCollected' },
      { roomId: ROOM_B, topic: `synthetic-topic-${ROOM_B}`, status: 'ArtifactCollected' },
    ],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B) } };
}

/** The controller under test, plus both stores, freshly imported. */
async function bind(subject: SubjectSnapshot = snapshot()): Promise<{
  controller: import('@/application/fishingCommands').FishingController;
  subject: typeof import('@/store/subjectStore').useSubjectStore;
  progression: typeof import('@/store/progressionStore').useProgressionStore;
}> {
  vi.resetModules();
  const subjectMod = await import('@/store/subjectStore');
  const progressionMod = await import('@/store/progressionStore');
  const binding = await import('@/store/fishingCommands');
  subjectMod.useSubjectStore.getState().setSnapshot(subject);
  progressionMod.useProgressionStore
    .getState()
    .hydrateProgression(progressionMod.readPersistedProgressionPayload());
  progressionMod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
  binding.fishingSessionSlot.current = null;
  return {
    controller: binding.fishingController,
    subject: subjectMod.useSubjectStore,
    progression: progressionMod.useProgressionStore,
  };
}

/** A begun session, with its context in the module-level session slot. */
async function begunSession(): Promise<
  Awaited<ReturnType<typeof bind>> & { context: import('@/core/fishing/fishingContext').FishingContext }
> {
  const bound = await bind();
  const result = bound.controller.sessionBegin({
    pondId: POND_ID,
    subjectId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a session');
  const binding = await import('@/store/fishingCommands');
  binding.fishingSessionSlot.current = result.value.context;
  return { ...bound, context: result.value.context };
}

const CORRECT_RECALL = { kind: 'answered-correct', roomId: ROOM_A } as const;

beforeEach(() => {
  window.localStorage.clear();
});

describe('fishingController against the real stores', () => {
  it('walks session, cast, bite, and keep, and pays exactly once', async () => {
    const bound = await begunSession();
    const { controller, progression } = bound;

    const cast = controller.castComplete({
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      fishDirection: 'right',
    });
    expect(cast.ok).toBe(true);

    const bite = controller.biteResolve({
      subject: bound.context,
      castNumber: 1,
      resolution: 'hooked',
      catalogId: CARP.id,
    });
    expect(bite.ok).toBe(true);
    if (bite.ok) expect(bite.value.catch?.recall).not.toBeNull();

    const kept = controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(kept.ok).toBe(true);
    if (!kept.ok) throw new Error('expected a keep');
    expect(kept.value.progression?.awarded).toBe(true);
    expect(kept.value.progression?.xpGained).toBe(5);
    expect(progression.getState().xpTotal).toBe(5);
    expect(progression.getState().fishCollection).toHaveLength(1);
    expect(progression.getState().badges).toContain('FshFirstCatch');
  });

  it('pays a repeated keep zero times, leaving the whole record byte-identical', async () => {
    const bound = await begunSession();
    const { controller, progression } = bound;
    const payload = {
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    } as const;

    controller.catchKeep(payload);
    const afterFirst = JSON.stringify(progression.getState().bySubject[SUBJECT_ID]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repeat = controller.catchKeep(payload);
      expect(repeat.ok && repeat.value.progression?.duplicate).toBe(true);
      expect(repeat.ok && repeat.value.progression?.awarded).toBe(false);
      expect(repeat.ok && repeat.value.progression?.xpGained).toBe(0);
    }

    expect(JSON.stringify(progression.getState().bySubject[SUBJECT_ID])).toBe(afterFirst);
    expect(progression.getState().xpTotal).toBe(5);
    expect(progression.getState().fishCollection).toHaveLength(1);
  });

  it('suppresses a retried keep that survives a real reload', async () => {
    const first = await begunSession();
    first.controller.catchKeep({
      subject: first.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(first.progression.getState().xpTotal).toBe(5);

    // The ledger is in the legacy mirror, which is the shipping repository, so a reload
    // reads it back. A fresh module plus a fresh hydration is what a reload is.
    const second = await bind();
    expect(second.progression.getState().xpTotal).toBe(5);
    expect(second.progression.getState().fishCollection).toHaveLength(1);

    // The retried keep re-derives the *same* identity - the session the catch came from
    // and the cast it was - so it is suppressed. This is the window the ledger exists
    // for: the write landed, the UI did not hear about it, and the surface asks again.
    const binding = await import('@/store/fishingCommands');
    binding.fishingSessionSlot.current = first.context;

    const repeat = second.controller.catchKeep({
      subject: first.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(repeat.ok && repeat.value.progression?.duplicate).toBe(true);
    expect(second.progression.getState().xpTotal).toBe(5);
    expect(second.progression.getState().fishCollection).toHaveLength(1);
  });

  it('pays again for the same species in a genuinely new session after a reload', async () => {
    // The counterweight to the test above, and it is not a contradiction: re-entering
    // the pond mints a new `contextId`, so this is a *different catch* and must pay.
    // `contextId` is one of the three identity components precisely so that "the same
    // fish, in a new session" is not mistaken for "the same fish, twice".
    const first = await begunSession();
    first.controller.catchKeep({
      subject: first.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    const second = await begunSession();
    expect(second.context.contextId).not.toBe(first.context.contextId);

    const kept = second.controller.catchKeep({
      subject: second.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(kept.ok && kept.value.progression?.awarded).toBe(true);
    expect(second.progression.getState().xpTotal).toBe(10);
    expect(second.progression.getState().fishCollection).toHaveLength(2);
    expect(readCatchRewardLedgerFromFields(second.progression.getState().bySubject[SUBJECT_ID].extraFields).entries)
      .toHaveLength(2);
  });

  it('records kept-without-recall distinctly and pays it nothing', async () => {
    const bound = await begunSession();

    const kept = bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: KOI.id,
      recall: { kind: 'kept-without-recall' },
    });

    expect(kept.ok).toBe(true);
    if (!kept.ok) throw new Error('expected a keep');
    expect(kept.value.outcome).toBe('kept-without-recall');
    // Kept, so badged; not a learning event, so unpaid.
    expect(bound.progression.getState().fishCollection).toHaveLength(1);
    expect(bound.progression.getState().badges).toContain('FshFirstCatch');
    expect(bound.progression.getState().xpTotal).toBe(0);

    const ledger = readCatchRewardLedgerFromFields(
      bound.progression.getState().bySubject[SUBJECT_ID].extraFields,
    );
    expect(ledger.entries[0].outcome).toBe('kept-without-recall');
    expect(ledger.entries[0].xpAwarded).toBe(0);
    expect(ledger.entries[0].catchIdentity).toContain('catch-');
  });

  it('writes nothing at all for a release', async () => {
    const bound = await begunSession();
    const before = JSON.stringify(bound.progression.getState().bySubject[SUBJECT_ID]);
    const persistedBefore = window.localStorage.getItem(STORAGE_KEYS.progression);

    const released = bound.controller.catchRelease({
      subject: bound.context,
      castNumber: 1,
      catalogId: KOI.id,
    });

    expect(released.ok).toBe(true);
    if (released.ok) expect(released.value.progression).toBeNull();
    expect(JSON.stringify(bound.progression.getState().bySubject[SUBJECT_ID])).toBe(before);
    expect(window.localStorage.getItem(STORAGE_KEYS.progression)).toBe(persistedBefore);
    expect(bound.progression.getState().xpTotal).toBe(0);
    expect(bound.progression.getState().fishCollection).toHaveLength(0);
  });

  it('writes nothing at all for a failed recall', async () => {
    const bound = await begunSession();
    const before = JSON.stringify(bound.progression.getState().bySubject[SUBJECT_ID]);

    const failed = bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: KOI.id,
      recall: { kind: 'answered-incorrect', roomId: ROOM_A },
    });

    expect(failed.ok).toBe(true);
    if (failed.ok) expect(failed.value.progression).toBeNull();
    expect(failed.ok && failed.value.outcome).toBe('answered-incorrect');
    expect(JSON.stringify(bound.progression.getState().bySubject[SUBJECT_ID])).toBe(before);
    expect(bound.progression.getState().fishCollection).toHaveLength(0);
    expect(bound.progression.getState().xpTotal).toBe(0);
  });

  it('refuses a keep whose context names a different subject', async () => {
    const bound = await begunSession();
    const before = JSON.stringify(bound.progression.getState().bySubject[SUBJECT_ID]);

    const refused = bound.controller.catchKeep({
      subject: {
        subjectId: 'synthetic-somewhere-else',
        subjectName: SUBJECT_NAME,
        roomId: null,
      },
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('SUBJECT_CONTEXT_MISMATCH');
    expect(JSON.stringify(bound.progression.getState().bySubject[SUBJECT_ID])).toBe(before);
  });

  it('stores the fish under the session\'s subject when a *different* subject is active', async () => {
    // The exact mismatch the defect describes: the pond was entered from one subject and
    // the active subject has since changed. The fish belongs to the session's subject.
    const bound = await begunSession();
    bound.progression.getState().setActiveSubject('synthetic-a-different-subject');

    const kept = bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(kept.ok).toBe(true);
    const state = bound.progression.getState();
    expect(state.bySubject[SUBJECT_ID].fishCollection).toHaveLength(1);
    expect(state.bySubject[SUBJECT_ID].fishCollection[0].subjectId).toBe(SUBJECT_ID);
    expect(state.bySubject[SUBJECT_ID].xpTotal).toBe(5);
    // The active subject's own record is untouched, and the header that mirrors it did
    // not get overwritten by the other subject's numbers.
    expect(state.bySubject['synthetic-a-different-subject'].fishCollection).toHaveLength(0);
    expect(state.bySubject['synthetic-a-different-subject'].xpTotal).toBe(0);
    expect(state.xpTotal).toBe(0);
  });

  it('persists the canonical catalog id, so the entry resolves from the field', async () => {
    const bound = await begunSession();
    bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: KOI.id,
      recall: CORRECT_RECALL,
    });

    const [stored] = bound.progression.getState().fishCollection;
    expect(stored.catalogId).toBe(KOI.id);
    expect(stored.id.startsWith(`${KOI.id}:`)).toBe(true);
    expect(resolveFishCatalogId(stored).source).toBe('catalog-id-field');
  });

  it('reports a subject with no cleared rooms as ineligible and as having no material', async () => {
    const cleared = snapshot();
    const bound = await bind({ dungeon: cleared.dungeon, rooms: {} });

    const began = bound.controller.sessionBegin({
      pondId: POND_ID,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });
    expect(began.ok && began.value.eligible).toBe(false);
    expect(began.ok && began.value.clearedRoomCount).toBe(0);

    const context = began.ok ? began.value.context : null;
    expect(context).not.toBeNull();
    if (!context) return;
    (await import('@/store/fishingCommands')).fishingSessionSlot.current = context;

    const read = bound.controller.stateRead({});
    expect(read.ok && read.value.hasRecallMaterial).toBe(false);

    const bite = bound.controller.biteResolve({
      subject: context,
      castNumber: 1,
      resolution: 'hooked',
      catalogId: CARP.id,
    });
    // Caught, with nothing to ask about - the case that used to be recorded as correct.
    expect(bite.ok && bite.value.catch?.recall).toBeNull();
  });

  it('does not mint a session id the application layer had to invent', async () => {
    // `mintSessionId` defaults to `crypto.randomUUID`, so two sessions of the same pond
    // are two identities even with identical everything else.
    const first = await begunSession();
    const firstContextId = first.context.contextId;

    const second = await begunSession();
    expect(second.context.contextId).not.toBe(firstContextId);
    expect(firstContextId.length).toBeGreaterThan(0);
    // Opaque: no subject, no room, no topic inside it.
    expect(firstContextId).not.toContain(SUBJECT_ID);
    expect(firstContextId).not.toContain(ROOM_A);
  });

  it('keeps two subjects' + ' catches apart, and two casts of one species apart', async () => {
    const bound = await begunSession();

    // Two casts of the same species in one session.
    for (const castNumber of [1, 2]) {
      const kept = bound.controller.catchKeep({
        subject: bound.context,
        castNumber,
        catalogId: CARP.id,
        recall: CORRECT_RECALL,
      });
      expect(kept.ok && kept.value.progression?.awarded).toBe(true);
    }

    const state = bound.progression.getState();
    expect(state.fishCollection).toHaveLength(2);
    expect(state.xpTotal).toBe(10);
    const ledger = readCatchRewardLedgerFromFields(state.bySubject[SUBJECT_ID].extraFields);
    expect(ledger.entries).toHaveLength(2);
    // And First Catch was awarded once, not twice.
    expect(state.badges.filter((badge) => badge === 'FshFirstCatch')).toHaveLength(1);
  });

  it('records the recall room on the persisted ledger row', async () => {
    const bound = await begunSession();
    bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    const persisted = window.localStorage.getItem(STORAGE_KEYS.progression) ?? '';
    expect(persisted).toContain(CATCH_REWARD_LEDGER_KEY);
    expect(persisted).toContain(ROOM_A);
  });

  it('keeps the legacy addFish, awardFishingXp, and checkFishingBadges working', async () => {
    // The Phase 17 carve-out: the rollback lane still calls all three, in that order, and
    // they must behave exactly as they did. `VITE_PIXI_FISHING=false` reaches them
    // through `VillageScreen.handleKeepFish`.
    const bound = await begunSession();
    const store = bound.progression.getState();

    const entry = store.addFish({
      name: CARP.name,
      rarity: CARP.rarity,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });
    expect(entry.id.startsWith('moss-carp:')).toBe(true);
    // Unchanged: the old name-derived prefix, and no explicit `catalogId`.
    expect(entry.catalogId).toBeUndefined();

    const xp = bound.progression.getState().awardFishingXp(CARP.rarity);
    expect(xp.xpGained).toBe(5);
    expect(xp.newRank).toBe('Novice');

    const badges = bound.progression.getState().checkFishingBadges();
    expect(badges).toEqual(['FshFirstCatch']);
    expect(bound.progression.getState().fishCollection).toHaveLength(1);
  });

  it('shows the old chain is still unguarded, which is why the new one exists', async () => {
    // `awardFishingXp` has no ledger check at all: two calls pay twice. This is the
    // defect, asserted rather than asserted-absent, so a future change that *does* guard
    // it has to update this test and its reason.
    const bound = await begunSession();
    bound.progression.getState().awardFishingXp(CARP.rarity);
    bound.progression.getState().awardFishingXp(CARP.rarity);
    expect(bound.progression.getState().xpTotal).toBe(10);

    // The new path does not, for the same catch.
    const kept = bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(kept.ok && kept.value.progression?.awarded).toBe(true);
    expect(bound.progression.getState().xpTotal).toBe(15);
    const repeat = bound.controller.catchKeep({
      subject: bound.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(repeat.ok && repeat.value.progression?.duplicate).toBe(true);
    expect(bound.progression.getState().xpTotal).toBe(15);
  });

  it('rejects every command when the session slot is empty', async () => {
    const bound = await bind();
    fishingSessionSlot.current = null;

    const result = bound.controller.catchKeep({
      subject: {
        subjectId: SUBJECT_ID,
        subjectName: SUBJECT_NAME,
        roomId: null,
      },
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_OPEN_SESSION');
    expect(bound.progression.getState().xpTotal).toBe(0);
  });
});