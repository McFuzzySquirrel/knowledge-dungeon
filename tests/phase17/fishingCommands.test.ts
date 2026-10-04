/**
 * Phase 17: the fishing application layer.
 *
 * `tests/phase17/catchRewards.test.ts` proves the transaction and
 * `tests/phase17/fishingStateMachine.test.ts` the machine. This file is about the two
 * things only this layer can be wrong about:
 *
 * 1. **One subject context, enforced.** Plan 5.3's "fishing eligibility, recall
 *    selection, and persistence may use different subject contexts" has three
 *    derivations today; here there is one, and a step that re-derives a different one
 *    is a **typed refusal** rather than a warning. That is the property that most of
 *    this file exists to pin.
 * 2. **Release mutates nothing.** Not "awards nothing" - *mutates nothing*, proved by
 *    diffing the whole progression value across the command.
 *
 * The ports are in-memory fakes with call counters, so a command that reaches for
 * something it was not asked for is visible. The store binding itself is proved
 * separately in `fishingCommandStoreBinding.test.ts`.
 *
 * Every fixture is obviously synthetic; no learner content appears in any assertion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFishingController,
  resolveOutcome,
  type CatchCommitOutcome,
  type FishingCommandDeps,
  type FishingController,
  type FishingSessionPort,
  type FishingSubjectPort,
} from '@/application/fishingCommands';
import { createFishingContext, type FishingContext } from '@/core/fishing/fishingContext';
import {
  CATCH_REWARD_LEDGER_KEY,
  catchXpFor,
  readCatchRewardLedgerFromFields,
  toCatchRewardIdentity,
  type CatchOutcome,
  type CatchResolution,
} from '@/core/fishing/catchRewards';
import { FISH_CATALOG, type FishCatalogEntry } from '@/core/fishing/fishingTypes';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SUBJECT_ID = 'synthetic-fishing-subject';
const SUBJECT_NAME = 'Synthetic Fishing Subject';
const OTHER_SUBJECT_ID = 'synthetic-other-subject';
const POND_ID = 'synthetic-pond';
const CONTEXT_ID = 'synthetic-pond-session';
const ROOM_A = 'synthetic-fishing-room-a';
const ROOM_B = 'synthetic-fishing-room-b';
const NOW = '2026-09-09T09:09:09.000Z';

const CARP = FISH_CATALOG.find((entry) => entry.id === 'moss-carp')!;
const KOI = FISH_CATALOG.find((entry) => entry.id === 'gilded-koi')!;

/** A one-room, fully cleared dungeon. */
function clearedSnapshot(subjectId = SUBJECT_ID): SubjectSnapshot {
  const room = (roomId: string): RoomMetadata => ({
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
  });
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: subjectId,
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

/** A dungeon whose rooms are all uncleared, so there is no recall material. */
function unclearedSnapshot(subjectId = SUBJECT_ID): SubjectSnapshot {
  const snapshot = clearedSnapshot(subjectId);
  return { dungeon: snapshot.dungeon, rooms: {} };
}

/** The context a begun session holds. */
function contextFor(subjectId = SUBJECT_ID, roomId: string | null = null): FishingContext {
  return createFishingContext({
    contextId: CONTEXT_ID,
    pondId: POND_ID,
    enteredAt: NOW,
    subjectId,
    subjectName: SUBJECT_NAME,
    roomId,
  });
}

/** A fake world: what the ports were asked for, and what they were told to write. */
function fakeWorld(options: { snapshot?: SubjectSnapshot | null } = {}) {
  const session: { context: FishingContext | null } = { context: null };
  let preservedFields: Record<string, unknown> | undefined = undefined;

  const calls = {
    readSession: 0,
    readSnapshot: [] as string[],
    readPreservedFields: [] as string[],
    commitCatch: [] as Parameters<FishingCommandDeps['progression']['commitCatch']>[0][],
  };

  const sessionPort: FishingSessionPort = {
    readSession: () => {
      calls.readSession += 1;
      return session.context;
    },
  };

  const subjectPort: FishingSubjectPort = {
    readSnapshot: (subjectId) => {
      calls.readSnapshot.push(subjectId);
      return options.snapshot === undefined ? clearedSnapshot() : options.snapshot;
    },
  };

  const deps: FishingCommandDeps = {
    session: sessionPort,
    subject: subjectPort,
    progression: {
      readPreservedFields: (subjectId) => {
        calls.readPreservedFields.push(subjectId);
        return preservedFields;
      },
      commitCatch: (input): CatchCommitOutcome => {
        calls.commitCatch.push(input);
        const identity = toCatchRewardIdentity({
          contextId: input.identity.contextId,
          catalogId: input.identity.catalogId,
          castNumber: input.identity.castNumber,
        });
        const declined = input.outcome === 'released' || input.outcome === 'answered-incorrect';
        if (declined) {
          return {
            awarded: false,
            duplicate: false,
            xpGained: 0,
            newRank: null,
            rankChanged: false,
            unlockedBadges: [],
            fishEntryId: null,
          };
        }
        const already = readCatchRewardLedgerFromFields(preservedFields).entries.some(
          (row) => row.catchIdentity === identity.catchIdentity,
        );
        if (already) {
          return {
            awarded: false,
            duplicate: true,
            xpGained: 0,
            newRank: null,
            rankChanged: false,
            unlockedBadges: [],
            fishEntryId: null,
          };
        }
        // The fake applies the *real* XP rule rather than a hardcoded number, so the
        // command-layer assertions about XP are checking the policy rather than the
        // fake. Narrowed by an explicit predicate rather than a cast, so the fake
        // cannot quietly accept a resolution the ledger would decline.
        const isWriting = (value: CatchResolution): value is CatchOutcome =>
          value === 'answered-correct' || value === 'kept-without-recall';
        if (!isWriting(input.outcome)) {
          throw new Error('the declined branch should have returned before this point');
        }
        const outcome = input.outcome;
        const xpAwarded = catchXpFor(outcome, input.catalogEntry.rarity);
        const entry = {
          contextId: identity.contextId,
          catalogId: identity.catalogId,
          castNumber: identity.castNumber,
          rarity: input.catalogEntry.rarity,
          catchIdentity: identity.catchIdentity,
          outcome,
          xpAwarded,
          fishEntryId: `${input.catalogEntry.id}:synthetic-suffix`,
          recallRoomId: input.recallRoomId,
          awardedAt: NOW,
        };
        preservedFields = {
          ...(preservedFields ?? {}),
          [CATCH_REWARD_LEDGER_KEY]: {
            version: 1,
            entries: [entry, ...readCatchRewardLedgerFromFields(preservedFields).entries],
          },
        };
        return {
          awarded: true,
          duplicate: false,
          xpGained: xpAwarded,
          newRank: 'Novice',
          rankChanged: false,
          // The fish is kept and badged either way, so the badge list does not depend on the XP.
          unlockedBadges: ['FshFirstCatch'],
          fishEntryId: entry.fishEntryId,
        };
      },
    },
    nowIso: () => NOW,
    mintSessionId: () => CONTEXT_ID,
  };

  return {
    deps,
    calls,
    session,
    /** The preserved fields as they stand, for the "wrote nothing" assertions. */
    fields: (): Record<string, unknown> | undefined => preservedFields,
    controller: createFishingController(deps),
  };
}

/** A begun session, with its context installed in the fake world. */
function begun(options: { snapshot?: SubjectSnapshot | null } = {}): ReturnType<typeof fakeWorld> {
  const world = fakeWorld(options);
  world.session.context = contextFor();
  return world;
}

/** A begun session whose learner answered a recall question correctly. */
const CORRECT_RECALL = { kind: 'answered-correct', roomId: ROOM_A } as const;
const INCORRECT_RECALL = { kind: 'answered-incorrect', roomId: ROOM_A } as const;
const NO_RECALL = { kind: 'kept-without-recall' } as const;

/**
 * A source file with every comment stripped.
 *
 * The layer-boundary checks below are about what the modules *reach for*, and every
 * one of these modules documents in prose that it does not reach for a renderer, a
 * clock, or a console. Checking the raw text would fail on the documentation that
 * states the rule, so the comments go first.
 */
async function readCode(path: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(path, 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// ── session-begin ────────────────────────────────────────────────────────────

describe('fishing/session-begin', () => {
  it('mints one context and reports eligibility from the context\'s own subject', () => {
    const world = fakeWorld();
    const result = world.controller.sessionBegin({
      pondId: POND_ID,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a session');
    expect(result.value.context).toMatchObject({
      contextId: CONTEXT_ID,
      pondId: POND_ID,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
      catalogId: null,
      rarity: null,
    });
    expect(result.value.eligible).toBe(true);
    expect(result.value.clearedRoomCount).toBe(2);
    // Entering a pond awards nothing and writes nothing.
    expect(result.value.progression).toBeNull();
    expect(world.calls.commitCatch).toHaveLength(0);
  });

  it('reads the named subject, not the active one', () => {
    const world = fakeWorld();
    world.controller.sessionBegin({
      pondId: POND_ID,
      subjectId: OTHER_SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });
    expect(world.calls.readSnapshot).toEqual([OTHER_SUBJECT_ID]);
  });

  it('reports ineligibility from the context\'s subject\'s own cleared rooms', () => {
    const world = fakeWorld({ snapshot: unclearedSnapshot() });
    const result = world.controller.sessionBegin({
      pondId: POND_ID,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });
    expect(result.ok && result.value.eligible).toBe(false);
    expect(result.ok && result.value.clearedRoomCount).toBe(0);
  });

  it('refuses an empty subject id rather than minting a context with no subject', () => {
    const world = fakeWorld();
    const result = world.controller.sessionBegin({
      pondId: POND_ID,
      subjectId: '   ',
      subjectName: SUBJECT_NAME,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('INVALID_SESSION_CONTEXT');
  });

  it('refuses an empty pond id', () => {
    const world = fakeWorld();
    expect(
      world.controller.sessionBegin({ pondId: '', subjectId: SUBJECT_ID, subjectName: SUBJECT_NAME })
        .ok,
    ).toBe(false);
  });

  it('refuses every other command until a session is begun', () => {
    const world = fakeWorld();
    const context = contextFor();
    for (const call of [
      () => world.controller.castComplete({ subject: context, castNumber: 1, catalogId: CARP.id, fishDirection: 'right' }),
      () =>
        world.controller.biteResolve({
          subject: context,
          castNumber: 1,
          resolution: 'hooked',
          catalogId: CARP.id,
        }),
      () =>
        world.controller.catchKeep({
          subject: context,
          castNumber: 1,
          catalogId: CARP.id,
          recall: CORRECT_RECALL,
        }),
      () =>
        world.controller.catchRelease({
          subject: context,
          castNumber: 1,
          catalogId: CARP.id,
        }),
      () => world.controller.stateRead({}),
    ]) {
      const result = call();
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error.code).toBe('NO_OPEN_SESSION');
    }
    expect(world.calls.commitCatch).toHaveLength(0);
  });
});

// ── The subject-context enforcement point ────────────────────────────────────

describe('fishing subject context - the enforcement point', () => {
  it('refuses a keep whose context names a different subject', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: { subjectId: OTHER_SUBJECT_ID, subjectName: SUBJECT_NAME, roomId: null },
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('SUBJECT_CONTEXT_MISMATCH');
    // The mismatch is reported, not merely warned about: nothing was committed.
    expect(world.calls.commitCatch).toHaveLength(0);
    expect(world.fields()).toBeUndefined();
  });

  it('refuses a keep whose context names the right subject under a different name', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: {
        subjectId: SUBJECT_ID,
        // Same subject id, different display text: a re-derived context, and therefore
        // not the same context.
        subjectName: 'Some Other Display Name',
        roomId: null,
      },
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SUBJECT_CONTEXT_MISMATCH');
    expect(world.calls.commitCatch).toHaveLength(0);
  });

  it('refuses a keep whose context names a different room', () => {
    // The context was opened from `ROOM_A`; committing against `ROOM_B` is a different
    // recall, and the room travels with the context for exactly this reason.
    const world = begun();
    world.session.context = contextFor(SUBJECT_ID, ROOM_A);

    const result = world.controller.catchKeep({
      subject: { subjectId: SUBJECT_ID, subjectName: SUBJECT_NAME, roomId: ROOM_B },
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SUBJECT_CONTEXT_MISMATCH');
  });

  it('accepts a context that omits the room, which is not an assertion of one', () => {
    const world = begun();
    world.session.context = contextFor(SUBJECT_ID, ROOM_A);

    const result = world.controller.catchKeep({
      subject: { subjectId: SUBJECT_ID, subjectName: SUBJECT_NAME },
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(result.ok).toBe(true);
  });

  it('enforces the mismatch on every subject-bearing command, not just keep', () => {
    const world = begun();
    const other = { subjectId: OTHER_SUBJECT_ID, subjectName: SUBJECT_NAME, roomId: null };
    for (const call of [
      () => world.controller.castComplete({ subject: other, castNumber: 1, catalogId: CARP.id, fishDirection: 'right' }),
      () => world.controller.biteResolve({ subject: other, castNumber: 1, resolution: 'hooked', catalogId: CARP.id }),
      () => world.controller.catchRelease({ subject: other, castNumber: 1, catalogId: CARP.id }),
      () => world.controller.stateRead({ subject: other }),
    ]) {
      const result = call();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SUBJECT_CONTEXT_MISMATCH');
    }
    expect(world.calls.commitCatch).toHaveLength(0);
  });

  it('commits the fish under the SESSION\'s subject, not the caller\'s and not activeSubjectId', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(result.ok).toBe(true);
    expect(world.calls.commitCatch).toHaveLength(1);
    const commit = world.calls.commitCatch[0];
    expect(commit.subjectId).toBe(SUBJECT_ID);
    // The snapshot it read came from the same subject, never the caller's - which is
    // why a caller cannot redirect the recall material either.
    expect(new Set(world.calls.readSnapshot)).toEqual(new Set([SUBJECT_ID]));
  });

  it('reads the preserved fields for the session\'s subject, on the read path', () => {
    // `fishing/state-read` is the only command that reads the ledger directly, and it
    // must read the session's subject's ledger rather than the active subject's. The
    // store's own `readProgressionPreservedFields` takes no argument and reads the
    // *active* subject, which is the trap this test exists to catch.
    const world = begun();
    world.controller.stateRead({});
    expect(world.calls.readPreservedFields).toEqual([SUBJECT_ID]);
  });

  it('commits the subject NAME from the context, not from a store lookup', () => {
    const world = begun();
    world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(world.calls.commitCatch[0].subjectName).toBe(SUBJECT_NAME);
  });

  it('refuses an incomplete session context before anything is minted', () => {
    const world = begun();
    // A context missing its subject id, which is what a hand-built slot could hold.
    world.session.context = { ...contextFor(), subjectId: '' };
    const result = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SESSION_CONTEXT');
    expect(world.calls.commitCatch).toHaveLength(0);
  });
});

// ── cast-complete and bite-resolve ───────────────────────────────────────────

describe('fishing/cast-complete', () => {
  it('reports the rolled fish without writing anything', () => {
    const world = begun();
    const result = world.controller.castComplete({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      fishDirection: 'bottom',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a cast');
    expect(result.value.catalogEntry).toEqual(CARP);
    expect(result.value.fishDirection).toBe('bottom');
    expect(result.value.castNumber).toBe(1);
    expect(result.value.progression).toBeNull();
    // The context gains the fish's identity so the surface has one value to carry.
    expect(result.value.context.catalogId).toBe(CARP.id);
    expect(result.value.context.rarity).toBe(CARP.rarity);
    // And the subject half is untouched, which is what keeps the mismatch check honest.
    expect(result.value.context.subjectId).toBe(SUBJECT_ID);
    expect(world.calls.commitCatch).toHaveLength(0);
  });

  it('refuses a catalog id that is not in the catalog', () => {
    const world = begun();
    const result = world.controller.castComplete({
      subject: contextFor(),
      castNumber: 1,
      catalogId: 'synthetic-not-a-fish',
      fishDirection: 'right',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_CATALOG_ID');
  });

  it('refuses a cast number below 1', () => {
    const world = begun();
    expect(
      world.controller.castComplete({
        subject: contextFor(),
        castNumber: 0,
        catalogId: CARP.id,
        fishDirection: 'right',
      }).ok,
    ).toBe(false);
  });
});

describe('fishing/bite-resolve', () => {
  it('reports a hooked catch with its identity and the context\'s recall material', () => {
    const world = begun();
    const result = world.controller.biteResolve({
      subject: contextFor(),
      castNumber: 2,
      resolution: 'hooked',
      catalogId: KOI.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a hook');
    expect(result.value.resolution).toBe('hooked');
    expect(result.value.catch).not.toBeNull();
    expect(result.value.catch!.catalogEntry.id).toBe(KOI.id);
    expect(result.value.catch!.castNumber).toBe(2);
    expect(result.value.catch!.identity).toEqual(
      toCatchRewardIdentity({ contextId: CONTEXT_ID, catalogId: KOI.id, castNumber: 2 }),
    );
    // The recall question names a room of the **context's** subject.
    expect([ROOM_A, ROOM_B]).toContain(result.value.catch!.recall!.roomId);
    expect(result.value.progression).toBeNull();
    expect(world.calls.commitCatch).toHaveLength(0);
  });

  it('reports a miss with no catch at all, so a caller cannot award on it', () => {
    const world = begun();
    const result = world.controller.biteResolve({
      subject: contextFor(),
      castNumber: 2,
      resolution: 'missed',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a miss');
    expect(result.value.resolution).toBe('missed');
    expect(result.value.catch).toBeNull();
    expect(result.value.progression).toBeNull();
  });

  it('reports no recall material for a subject with no cleared rooms', () => {
    const world = begun({ snapshot: unclearedSnapshot() });
    const result = world.controller.biteResolve({
      subject: contextFor(),
      castNumber: 1,
      resolution: 'hooked',
      catalogId: CARP.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a hook');
    // The fish is still caught; there is simply nothing to ask about. This is the case
    // that used to be recorded as a correct answer.
    expect(result.value.catch).not.toBeNull();
    expect(result.value.catch!.recall).toBeNull();
  });

  it('refuses a hook with no catalog id', () => {
    const world = begun();
    const result = world.controller.biteResolve({
      subject: contextFor(),
      castNumber: 1,
      resolution: 'hooked',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CAST_STATE_INVALID');
  });
});

// ── catch-keep ───────────────────────────────────────────────────────────────

describe('fishing/catch-keep', () => {
  it('awards once and reports the outcome', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a keep');
    expect(result.value.outcome).toBe('answered-correct');
    expect(result.value.progression?.awarded).toBe(true);
    expect(result.value.progression?.xpGained).toBe(5);
  });

  it('records kept-without-recall as its own outcome, distinct from a correct answer', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: NO_RECALL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a keep');
    // Not `'correct'`. The distinction is the phase's scope line, and it is in the type.
    expect(result.value.outcome).toBe('kept-without-recall');
    expect(result.value.outcome).not.toBe('answered-correct');
    expect(world.calls.commitCatch[0].outcome).toBe('kept-without-recall');
    // The rule itself decides the XP; the command layer does not second-guess it.
    expect(result.value.progression?.xpGained).toBe(0);
  });

  it('records no recall room for a keep with no recall', () => {
    const world = begun();
    world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: NO_RECALL,
    });
    expect(world.calls.commitCatch[0].recallRoomId).toBeNull();
  });

  it('records the recall room for an answered question', () => {
    const world = begun();
    world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: { kind: 'answered-correct', roomId: `  ${ROOM_B}  ` },
    });
    expect(world.calls.commitCatch[0].recallRoomId).toBe(ROOM_B);
  });

  it('reports no progression for a failed recall, and asks the store to decline', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: INCORRECT_RECALL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a keep');
    expect(result.value.outcome).toBe('answered-incorrect');
    // `null` is the type's way of saying nothing was written.
    expect(result.value.progression).toBeNull();
    // And the store was told, rather than the command layer deciding on its own.
    expect(world.calls.commitCatch[0].outcome).toBe('answered-incorrect');
    expect(world.fields()).toBeUndefined();
  });

  it('suppresses a repeat of the same catch, leaving xpTotal byte-identical', () => {
    const world = begun();
    const payload = {
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    } as const;

    expect(world.controller.catchKeep(payload).ok).toBe(true);
    const afterFirst = JSON.stringify(world.fields());

    const repeat = world.controller.catchKeep(payload);
    expect(repeat.ok && repeat.value.progression?.duplicate).toBe(true);
    expect(repeat.ok && repeat.value.progression?.awarded).toBe(false);
    expect(repeat.ok && repeat.value.progression?.xpGained).toBe(0);
    expect(JSON.stringify(world.fields())).toBe(afterFirst);
  });

  it('awards a different cast of the same species again', () => {
    const world = begun();
    world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    const second = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 2,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(second.ok && second.value.progression?.awarded).toBe(true);
    expect(world.fields()).toHaveProperty(CATCH_REWARD_LEDGER_KEY);
    expect(readCatchRewardLedgerFromFields(world.fields()).entries).toHaveLength(2);
  });

  it('refuses a catalog id that is not in the catalog', () => {
    const world = begun();
    const result = world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: 'synthetic-not-a-fish',
      recall: CORRECT_RECALL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_CATALOG_ID');
  });
});

// ── resolveOutcome ───────────────────────────────────────────────────────────

describe('resolveOutcome', () => {
  it('maps each recall member to its ledger code, passing the bare keep through', () => {
    expect(resolveOutcome(CORRECT_RECALL)).toBe('answered-correct');
    expect(resolveOutcome(INCORRECT_RECALL)).toBe('answered-incorrect');
    // Not inferred from a missing question: it is passed through as itself.
    expect(resolveOutcome(NO_RECALL)).toBe('kept-without-recall');
  });
});

// ── catch-release ────────────────────────────────────────────────────────────

describe('fishing/catch-release', () => {
  it('mutates nothing: not one port is called', () => {
    const world = begun();
    const before = world.fields();

    const result = world.controller.catchRelease({
      subject: contextFor(),
      castNumber: 1,
      catalogId: KOI.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a release');
    expect(result.value.catalogEntry).toEqual(KOI);
    // "Released, and nothing happened" is in the type.
    expect(result.value.progression).toBeNull();
    // No commit and no preserved-field read: a release has no reward to decide and no
    // ledger to consult.
    expect(world.calls.commitCatch).toHaveLength(0);
    expect(world.calls.readPreservedFields).toHaveLength(0);
    // The session snapshot *is* read, because the session lookup shares one
    // precondition helper with the other five commands and that helper resolves the
    // snapshot. That is a read of the session's own subject and nothing more.
    expect(world.calls.readSnapshot).toEqual([SUBJECT_ID]);
    expect(world.fields()).toBe(before);
  });

  it('mutates nothing even for the most valuable fish in the catalog', () => {
    const world = begun();
    world.controller.catchRelease({ subject: contextFor(), castNumber: 1, catalogId: KOI.id });
    expect(world.calls.commitCatch).toHaveLength(0);
    expect(world.fields()).toBeUndefined();
  });

  it('does not even mint an identity for a released fish', () => {
    const world = begun();
    const result = world.controller.catchRelease({
      subject: contextFor(),
      castNumber: 5,
      catalogId: CARP.id,
    });
    // Nothing to suppress later either: a released catch has no ledger row, so nothing
    // in the record could ever grow from it.
    expect(result.ok).toBe(true);
    expect(world.fields()).toBeUndefined();
  });
});

// ── state-read ───────────────────────────────────────────────────────────────

describe('fishing/state-read', () => {
  it('reports the context, eligibility, and ledger count without writing', () => {
    const world = begun();
    world.controller.catchKeep({
      subject: contextFor(),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    const result = world.controller.stateRead({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a read');
    expect(result.value.eligibility).toEqual({ eligible: true, clearedRoomCount: 2 });
    expect(result.value.hasRecallMaterial).toBe(true);
    expect(result.value.recordedCatches).toBe(1);
    expect(result.value.progression).toBeNull();
    expect(world.calls.commitCatch).toHaveLength(1);
  });

  it('distinguishes eligibility from having recall material', () => {
    // A learner may fish with one cleared room and get a question, or with none at all -
    // in which case they are not eligible either, because the gate needs one cleared
    // room. Both answers are reported so a surface can explain itself.
    const world = begun({ snapshot: unclearedSnapshot() });
    const result = world.controller.stateRead({});
    expect(result.ok && result.value.eligibility).toEqual({ eligible: false, clearedRoomCount: 0 });
    expect(result.ok && result.value.hasRecallMaterial).toBe(false);
  });

  it('enforces a supplied context but does not require one', () => {
    const world = begun();
    expect(world.controller.stateRead({}).ok).toBe(true);
    const wrong = world.controller.stateRead({
      subject: { subjectId: OTHER_SUBJECT_ID, subjectName: SUBJECT_NAME, roomId: null },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('SUBJECT_CONTEXT_MISMATCH');
  });
});

// ── Dispatch ─────────────────────────────────────────────────────────────────

describe('fishingController.dispatch', () => {
  it('reaches the same runner as the named methods, for every command', () => {
    const world = begun();
    const context = contextFor();
    const cases = [
      { type: 'fishing/session-begin', payload: { pondId: POND_ID, subjectId: SUBJECT_ID, subjectName: SUBJECT_NAME } },
      { type: 'fishing/cast-complete', payload: { subject: context, castNumber: 1, catalogId: CARP.id, fishDirection: 'right' as const } },
      { type: 'fishing/bite-resolve', payload: { subject: context, castNumber: 1, resolution: 'missed' as const } },
      { type: 'fishing/catch-keep', payload: { subject: context, castNumber: 1, catalogId: CARP.id, recall: CORRECT_RECALL } },
      { type: 'fishing/catch-release', payload: { subject: context, castNumber: 1, catalogId: CARP.id } },
      { type: 'fishing/state-read', payload: {} },
    ] as const;

    for (const command of cases) {
      const result = world.controller.dispatch(command);
      expect(result.ok).toBe(true);
      // Each outcome names the command it came from, so a dispatched call is
      // indistinguishable from a named one.
      expect(result.ok && result.value.command).toBe(command.type);
    }
  });

  it('reaches the same refusal through dispatch as through the named method', () => {
    const world = fakeWorld();
    const result = world.controller.dispatch({
      type: 'fishing/catch-release',
      payload: { subject: contextFor(), castNumber: 1, catalogId: CARP.id },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_OPEN_SESSION');
  });
});

// ── Layer boundaries ─────────────────────────────────────────────────────────

describe('fishingCommands - the layer boundary', () => {
  it('imports no renderer, React, DOM, or store module', async () => {
    // A source-level check, because the constraint is about what the module *reaches*
    // for rather than about how it happens to behave in a test.
    //
    // The **comment bodies are stripped** first, and that matters: this module's header
    // names `Math.random`, `new Date(`, and `console.` several times, precisely to say
    // it does not call them. A naive substring check over the whole file would fail on
    // its own documentation, and stripping comments first is what makes the check
    // about code.
    const source = await readCode('src/application/fishingCommands.ts');
    for (const forbidden of [
      'from \'phaser',
      'from \'pixi',
      'from \'react',
      '@/game/',
      '@/renderers/',
      '@/ui/',
      '@/store/',
      'Math.random',
      'new Date(',
      'console.',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('imports no renderer from either core module either', async () => {
    for (const file of [
      'src/core/fishing/fishingStateMachine.ts',
      'src/core/fishing/catchRewards.ts',
      'src/store/fishingCommands.ts',
    ]) {
      const source = await readCode(file);
      for (const forbidden of [
        'from \'phaser',
        'from \'pixi',
        'from \'react',
        '@/game/',
        '@/renderers/',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('reads no real clock and no real randomness in the state machine or the ledger', async () => {
    for (const file of [
      'src/core/fishing/fishingStateMachine.ts',
      'src/core/fishing/catchRewards.ts',
    ]) {
      const source = await readCode(file);
      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('new Date(');
      // The clock is injected, so neither module mints one either.
      expect(source).not.toContain('Date.now(');
    }
  });

  it('logs nothing on any catch path', async () => {
    for (const file of [
      'src/application/fishingCommands.ts',
      'src/core/fishing/catchRewards.ts',
      'src/core/fishing/fishingStateMachine.ts',
      'src/store/fishingCommands.ts',
    ]) {
      expect(await readCode(file)).not.toContain('console.');
    }
    // And the store's new action has no fishing log line. `VillageScreen`'s
    // `console.log` on every catch is untouched, because `src/ui/**` is out of scope for
    // this phase - see the report.
    expect(await readCode('src/store/progressionStore.ts')).not.toMatch(
      /console\.(log|info|warn)\(\s*`\[Fishing\]/,
    );
  });
});

// ── A whole cast, end to end, through the command layer ──────────────────────

describe('fishingCommands - a whole cast, start to finish', () => {
  it('walks begin, cast, bite, keep, and read without a browser', () => {
    const world = fakeWorld();
    const controller: FishingController = world.controller;

    const begunResult = controller.sessionBegin({
      pondId: POND_ID,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });
    expect(begunResult.ok).toBe(true);
    if (!begunResult.ok) throw new Error('expected a session');
    world.session.context = begunResult.value.context;
    expect(begunResult.value.eligible).toBe(true);

    const context = begunResult.value.context;

    const cast = controller.castComplete({
      subject: context,
      castNumber: 1,
      catalogId: CARP.id,
      fishDirection: 'right',
    });
    expect(cast.ok && cast.value.progression).toBeNull();

    const bite = controller.biteResolve({
      subject: context,
      castNumber: cast.ok ? cast.value.castNumber : 1,
      resolution: 'hooked',
      catalogId: CARP.id,
    });
    expect(bite.ok && bite.value.catch?.recall).not.toBeNull();

    const kept = controller.catchKeep({
      subject: context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });
    expect(kept.ok && kept.value.progression?.awarded).toBe(true);

    const read = controller.stateRead({});
    expect(read.ok && read.value.recordedCatches).toBe(1);

    // Nothing anywhere in that sequence wrote a learner value.
    const serialised = JSON.stringify(world.fields());
    expect(serialised).not.toContain(SUBJECT_NAME);
    expect(serialised).not.toContain(CARP.name);
  });

  it('lets a second subject keep its own catch with no interference', () => {
    const world = fakeWorld();
    world.controller.sessionBegin({
      pondId: POND_ID,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
    });
    world.session.context = contextFor(SUBJECT_ID);
    world.controller.catchKeep({
      subject: contextFor(SUBJECT_ID),
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    // A second subject, its own context, the same cast number and species. Distinct
    // session ids keep them apart - which is the component that makes the ledger
    // per-subject safe rather than merely scoped.
    world.session.context = { ...contextFor(OTHER_SUBJECT_ID), contextId: 'synthetic-second-session' };
    const other = world.controller.catchKeep({
      subject: world.session.context,
      castNumber: 1,
      catalogId: CARP.id,
      recall: CORRECT_RECALL,
    });

    expect(other.ok && other.value.progression?.awarded).toBe(true);
    expect(world.calls.commitCatch.map((call) => call.subjectId)).toEqual([
      SUBJECT_ID,
      OTHER_SUBJECT_ID,
    ]);
  });

  it('persists a failure by letting it propagate, rather than typing it as a result', () => {
    const world = fakeWorld();
    world.session.context = contextFor();
    const failing = vi.fn(() => {
      throw new Error('synthetic persistence failure');
    });
    world.deps.progression.commitCatch = failing;

    expect(() =>
      world.controller.catchKeep({
        subject: contextFor(),
        castNumber: 1,
        catalogId: CARP.id,
        recall: CORRECT_RECALL,
      }),
    ).toThrow('synthetic persistence failure');
  });
});

// ── A catalogue-wide sanity check on the two identity fields ────────────────

describe('fishingCommands - canonical catalog identity', () => {
  it('accepts every catalog entry by its canonical id', () => {
    const world = begun();
    for (const entry of FISH_CATALOG as readonly FishCatalogEntry[]) {
      const result = world.controller.castComplete({
        subject: contextFor(),
        castNumber: 1,
        catalogId: entry.id,
        fishDirection: 'right',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`refused ${entry.id}`);
      expect(result.value.catalogEntry.id).toBe(entry.id);
    }
  });
});

beforeEach(() => {
  window.localStorage.clear();
});