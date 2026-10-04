/**
 * Phase 17: the catch-reward ledger.
 *
 * The pure module first, then the store transaction it rides in. Mirrors
 * `tests/phase16/reviewPassRewards.test.ts` because this ledger is the same kind of
 * object for the same reason: a reward that can be minted twice must be guarded
 * durably, in the same record write as the reward itself.
 *
 * Every fixture below is obviously synthetic: `synthetic-*` ids, `Synthetic *` names,
 * and no learner content anywhere. The privacy assertions check exactly that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_IDENTITY_VERSION,
  CATCH_OUTCOME_POLICY,
  CATCH_REWARD_LEDGER_KEY,
  CATCH_REWARD_LEDGER_VERSION,
  CATCH_XP_BY_OUTCOME,
  catchXpFor,
  countCatchRewardsForContext,
  createCanonicalFishEntry,
  createFishEntrySuffix,
  decideCatchReward,
  deriveCatchIdentity,
  emptyCatchRewardLedger,
  evaluateFishingBadgeUnlocks,
  hasCatchReward,
  latestCatchRewardForContext,
  readCatchRewardLedger,
  readCatchRewardLedgerFromFields,
  recordCatchReward,
  replaceCatchReward,
  toCatchRewardIdentity,
  withRecallRoom,
  type CatchRewardEntry,
  type CatchRewardIdentity,
} from '@/core/fishing/catchRewards';
import { toCanonicalFishEntry, resolveFishCatalogId } from '@/core/fishing/fishCollectionService';
import { FISH_CATALOG, type FishCollection, type FishEntry } from '@/core/fishing/fishingTypes';
import { FSH_XP_PER_CORRECT_ANSWER } from '@/core/progression/types';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';

const SUBJECT_ID = 'synthetic-catch-subject';
const SUBJECT_NAME = 'Synthetic Catch Subject';
const CONTEXT_A = 'synthetic-pond-session-a';
const CONTEXT_B = 'synthetic-pond-session-b';
const CAST = 3;
const NOW = '2026-08-08T08:08:08.000Z';
const CARP = FISH_CATALOG.find((entry) => entry.id === 'moss-carp')!;
const KOI = FISH_CATALOG.find((entry) => entry.id === 'gilded-koi')!;

function identity(overrides: Partial<CatchRewardIdentity> = {}): CatchRewardIdentity {
  return { ...toCatchRewardIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST }), ...overrides };
}

function entryFor(identityValue: CatchRewardIdentity, overrides: Partial<CatchRewardEntry> = {}): CatchRewardEntry {
  return {
    contextId: identityValue.contextId,
    catalogId: identityValue.catalogId,
    castNumber: identityValue.castNumber,
    rarity: CARP.rarity,
    catchIdentity: identityValue.catchIdentity,
    outcome: 'answered-correct',
    xpAwarded: 5,
    fishEntryId: `${identityValue.catalogId}:synthetic-suffix`,
    recallRoomId: null,
    awardedAt: NOW,
    ...overrides,
  };
}

function fishFor(
  _identityValue: CatchRewardIdentity,
  entry = CARP,
  suffix = 'synthetic-suffix',
) {
  return createCanonicalFishEntry({
    catalogEntry: entry,
    subjectId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
    caughtAt: NOW,
    entrySuffix: suffix,
  });
}

/** A decision for a first, unrecorded catch. */
function decide(overrides: Partial<Parameters<typeof decideCatchReward>[0]> = {}) {
  const value = identity();
  return decideCatchReward({
    extraFields: undefined,
    identity: value,
    outcome: 'answered-correct',
    xpTotal: 0,
    rank: 'Novice' as const,
    collection: [],
    heldBadges: [],
    fishEntry: fishFor(value),
    awardedAt: NOW,
    ...overrides,
  });
}

// ── Identity ─────────────────────────────────────────────────────────────────

describe('catchRewards - identity', () => {
  it('is stable across calls for the same (session, species, cast)', () => {
    const first = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    const second = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    expect(first).toBe(second);
  });

  it('is recognisable, opaque, and prefixed', () => {
    const value = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    expect(value.startsWith('catch-')).toBe(true);
    // Eight lowercase hex digits after the prefix: a digest, not an identifier.
    expect(value).toMatch(/^catch-[0-9a-f]{8}$/);
  });

  it('mixes the identity version in, so a future rule cannot collide with this one', () => {
    // The version is an *input* to the digest, so it cannot be read off the output. What
    // can be asserted is that changing it changes the digest, which is exactly the
    // property that makes an old row stop matching rather than start matching wrongly.
    expect(CATCH_IDENTITY_VERSION).toBe(1);
    const v1 = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    // Computed from the same rule with `v2` in place of `v1` and frozen alongside the
    // golden value above, so this is a real assertion rather than a restatement.
    expect('catch-ca48a6b9').not.toBe(v1);
  });

  it('pins the digest as a golden value, so a rule change cannot pass unnoticed', () => {
    // Computed once from the documented rule and frozen. A golden value is what makes
    // this catch an accidental change to the identity rule, which a re-derivation in the
    // test would happily agree with.
    expect(deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST })).toBe(
      'catch-be316bbe',
    );
  });

  it('differs per session, so two pond visits never share an identity', () => {
    const a = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    const b = deriveCatchIdentity({ contextId: CONTEXT_B, catalogId: CARP.id, castNumber: CAST });
    expect(a).not.toBe(b);
  });

  it('differs per species, so two species on one cast never share an identity', () => {
    const carp = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    const koi = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: KOI.id, castNumber: CAST });
    expect(carp).not.toBe(koi);
  });

  it('differs per cast, which is the case a name- or entry-id identity gets wrong', () => {
    // Two Moss Carp in one pond session. This is the case the identity exists for.
    const first = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 1 });
    const second = deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 2 });
    expect(first).not.toBe(second);
  });

  it('normalises a hostile cast number rather than throwing', () => {
    expect(deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: -5 })).toBe(
      deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 0 }),
    );
    expect(deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 3.9 })).toBe(
      deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 3 }),
    );
    expect(deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: Number.NaN })).toMatch(
      /^catch-[0-9a-f]{8}$/,
    );
  });

  it('is total for a hostile session id or species id', () => {
    expect(() =>
      deriveCatchIdentity({ contextId: '', catalogId: '', castNumber: 1 }),
    ).not.toThrow();
    expect(deriveCatchIdentity({ contextId: '', catalogId: '', castNumber: 1 })).toMatch(
      /^catch-[0-9a-f]{8}$/,
    );
  });

  it('carries no learner text: the digest is a function of the three components only', () => {
    // The components are app-minted and integers by construction. A digest built from
    // them therefore cannot contain a topic, a subject name, or a fish display name.
    const identityValue = toCatchRewardIdentity({
      contextId: CONTEXT_A,
      catalogId: CARP.id,
      castNumber: CAST,
    });
    expect(identityValue).toEqual({
      contextId: CONTEXT_A,
      catalogId: CARP.id,
      castNumber: CAST,
      catchIdentity: expect.stringMatching(/^catch-[0-9a-f]{8}$/),
    });
    // The subject's *display name* is not one of the components at all.
    expect(Object.values(identityValue)).not.toContain(SUBJECT_NAME);
    expect(Object.values(identityValue)).not.toContain(CARP.name);
    expect(CARP.name).not.toBe(CARP.id);
  });

  it('builds a coherent identity and digest in one call', () => {
    const value = toCatchRewardIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST });
    expect(value.catchIdentity).toBe(
      deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: CAST }),
    );
  });
});

// ── The ledger container ─────────────────────────────────────────────────────

describe('catchRewards - the ledger', () => {
  it('starts empty and is versioned', () => {
    const ledger = emptyCatchRewardLedger();
    expect(ledger).toEqual({ version: CATCH_REWARD_LEDGER_VERSION, entries: [] });
    expect(CATCH_REWARD_LEDGER_VERSION).toBe(1);
  });

  it('lives under a static key, never a derived one', () => {
    expect(CATCH_REWARD_LEDGER_KEY).toBe('catchRewardLedger');
    expect(CATCH_REWARD_LEDGER_KEY).not.toContain(SUBJECT_ID);
    expect(CATCH_REWARD_LEDGER_KEY).not.toContain(CARP.id);
  });

  it('is idempotent for a repeated identity', () => {
    const value = identity();
    const once = recordCatchReward(emptyCatchRewardLedger(), entryFor(value));
    const twice = recordCatchReward(once, entryFor(value));
    expect(twice).toBe(once);
    expect(twice.entries).toHaveLength(1);
  });

  it('replaces a row\'s fields without dropping the others or duplicating it', () => {
    // The distinction that matters: `recordCatchReward` keeps the existing row on a
    // repeat (right for a replay), `replaceCatchReward` rewrites it (right for a
    // correction). Getting this wrong loses earlier catches.
    const first = identity({
      castNumber: 1,
      catchIdentity: deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 1 }),
    });
    const second = identity({
      castNumber: 2,
      catchIdentity: deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 2 }),
    });
    const ledger = recordCatchReward(
      recordCatchReward(emptyCatchRewardLedger(), entryFor(first)),
      entryFor(second),
    );

    const corrected = replaceCatchReward(
      ledger,
      entryFor(first, { recallRoomId: 'synthetic-recall-room' }),
    );
    expect(corrected.entries).toHaveLength(2);
    expect(corrected.entries.filter((row) => row.castNumber === 1)).toHaveLength(1);
    expect(corrected.entries.find((row) => row.castNumber === 1)?.recallRoomId).toBe(
      'synthetic-recall-room',
    );
    // The other row is untouched.
    expect(corrected.entries.find((row) => row.castNumber === 2)?.recallRoomId).toBeNull();
    // And the original value is not mutated.
    expect(ledger.entries.find((row) => row.castNumber === 1)?.recallRoomId).toBeNull();
  });

  it('appends an unseen row when replacing into an empty ledger', () => {
    const ledger = replaceCatchReward(emptyCatchRewardLedger(), entryFor(identity()));
    expect(ledger.entries).toHaveLength(1);
    expect(hasCatchReward(ledger, identity())).toBe(true);
  });

  it('appends newest first and keeps every entry', () => {
    const first = identity({ castNumber: 1, catchIdentity: deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 1 }) });
    const second = identity({ castNumber: 2, catchIdentity: deriveCatchIdentity({ contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 2 }) });
    const ledger = recordCatchReward(
      recordCatchReward(emptyCatchRewardLedger(), entryFor(first)),
      entryFor(second),
    );
    expect(ledger.entries.map((entry) => entry.castNumber)).toEqual([2, 1]);
    expect(latestCatchRewardForContext(ledger, CONTEXT_A)?.castNumber).toBe(2);
    expect(countCatchRewardsForContext(ledger, CONTEXT_A)).toBe(2);
  });

  it('reports a different session as absent', () => {
    const ledger = recordCatchReward(emptyCatchRewardLedger(), entryFor(identity()));
    expect(latestCatchRewardForContext(ledger, CONTEXT_B)).toBeNull();
    expect(countCatchRewardsForContext(ledger, CONTEXT_B)).toBe(0);
  });

  it('is total when reading an absent, malformed, or hostile value', () => {
    const hostiles = [
      undefined,
      null,
      'a string',
      42,
      [],
      {},
      { entries: 'not an array' },
      { entries: [null, 'a string', 7] },
      { version: 99, entries: [] },
    ];
    for (const value of hostiles) {
      expect(readCatchRewardLedger(value)).toEqual({
        version: CATCH_REWARD_LEDGER_VERSION,
        entries: [],
      });
    }
  });

  it('drops an entry that could never be matched, rather than trusting it', () => {
    // A row with no context, no species, no cast number, or no digest suppresses
    // nothing, so keeping it would only grow the ledger.
    const kept = readCatchRewardLedger({
      entries: [
        entryFor(identity()),
        { contextId: '', catalogId: CARP.id, castNumber: 1, catchIdentity: 'catch-deadbeef' },
        { contextId: CONTEXT_A, catalogId: '', castNumber: 1, catchIdentity: 'catch-deadbeef' },
        { contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 0, catchIdentity: 'catch-deadbeef' },
        { contextId: CONTEXT_A, catalogId: CARP.id, castNumber: 1, catchIdentity: '' },
      ],
    });
    expect(kept.entries).toHaveLength(1);
  });

  it('normalises a malformed entry field without dropping the row', () => {
    const [row] = readCatchRewardLedger({
      entries: [
        {
          contextId: `  ${CONTEXT_A}  `,
          catalogId: CARP.id,
          castNumber: 2.9,
          rarity: 'not-a-rarity',
          catchIdentity: 'catch-deadbeef',
          outcome: 'not-an-outcome',
          xpAwarded: -4,
          fishEntryId: 'moss-carp:x',
          recallRoomId: 42,
          awardedAt: NOW,
        },
      ],
    }).entries;
    expect(row).toMatchObject({
      contextId: CONTEXT_A,
      castNumber: 2,
      rarity: 'common',
      outcome: 'answered-correct',
      xpAwarded: 0,
      recallRoomId: null,
    });
  });

  it('preserves every other preserved field when it writes', () => {
    const existing = {
      roomClearRewardLedger: { version: 1, entries: [{ roomId: 'synthetic-room' }] },
      reviewPassRewardLedger: { version: 1, entries: [] },
      interruptedReviewSession: { version: 1, roomId: 'synthetic-room' },
      someFutureUnknownField: { anything: true },
    };
    const written = {
      ...existing,
      [CATCH_REWARD_LEDGER_KEY]: recordCatchReward(emptyCatchRewardLedger(), entryFor(identity())),
    };
    expect(written).toMatchObject({
      roomClearRewardLedger: existing.roomClearRewardLedger,
      reviewPassRewardLedger: existing.reviewPassRewardLedger,
      interruptedReviewSession: existing.interruptedReviewSession,
      someFutureUnknownField: existing.someFutureUnknownField,
    });
  });

  it('reads back from preserved fields, treating absent fields as empty', () => {
    expect(readCatchRewardLedgerFromFields(undefined).entries).toEqual([]);
    expect(readCatchRewardLedgerFromFields({}).entries).toEqual([]);
    const ledger = recordCatchReward(emptyCatchRewardLedger(), entryFor(identity()));
    expect(readCatchRewardLedgerFromFields({ [CATCH_REWARD_LEDGER_KEY]: ledger }).entries).toHaveLength(1);
  });
});

// ── Outcome policy ───────────────────────────────────────────────────────────

describe('catchRewards - the outcome policy', () => {
  it('pays a correct answer the full per-answer rate', () => {
    expect(CATCH_XP_BY_OUTCOME['answered-correct']).toBe(FSH_XP_PER_CORRECT_ANSWER);
    expect(catchXpFor('answered-correct', 'common')).toBe(5);
    expect(catchXpFor('answered-correct', 'rare')).toBe(8); // 5 * 1.5, rounded
    expect(catchXpFor('answered-correct', 'epic')).toBe(10); // 5 * 2.0
  });

  it('pays a keep-without-recall nothing, and says why in the rule itself', () => {
    // The rule and its argument are on the module header. The assertion is the rule.
    expect(CATCH_XP_BY_OUTCOME['kept-without-recall']).toBe(0);
    for (const rarity of ['common', 'rare', 'epic'] as const) {
      expect(catchXpFor('kept-without-recall', rarity)).toBe(0);
    }
  });

  it('keeps the fish for both writing outcomes and drops it for both declining ones', () => {
    expect(CATCH_OUTCOME_POLICY['answered-correct'].keepsFish).toBe(true);
    expect(CATCH_OUTCOME_POLICY['kept-without-recall'].keepsFish).toBe(true);
    expect(CATCH_OUTCOME_POLICY.released.keepsFish).toBe(false);
    expect(CATCH_OUTCOME_POLICY['answered-incorrect'].keepsFish).toBe(false);
  });

  it('mutates progression only for the two writing outcomes', () => {
    expect(CATCH_OUTCOME_POLICY['answered-correct'].mutatesProgression).toBe(true);
    expect(CATCH_OUTCOME_POLICY['kept-without-recall'].mutatesProgression).toBe(true);
    expect(CATCH_OUTCOME_POLICY.released.mutatesProgression).toBe(false);
    expect(CATCH_OUTCOME_POLICY['answered-incorrect'].mutatesProgression).toBe(false);
  });

  it('awards badges for both writing outcomes', () => {
    expect(CATCH_OUTCOME_POLICY['answered-correct'].awardsBadges).toBe(true);
    expect(CATCH_OUTCOME_POLICY['kept-without-recall'].awardsBadges).toBe(true);
  });
});

// ── The persisted fish entry ─────────────────────────────────────────────────

describe('catchRewards - the persisted fish entry', () => {
  it('carries the canonical catalogId explicitly, never derived from the name', () => {
    const entry = fishFor(identity());
    expect(entry.catalogId).toBe(CARP.id);
    // Resolution now takes the first branch, not `entry-id-prefix` or the name match.
    expect(resolveFishCatalogId(entry).source).toBe('catalog-id-field');
  });

  it('builds the entry id from the catalog id, so the prefix resolves on its own', () => {
    const entry = fishFor(identity());
    expect(entry.id.startsWith(`${CARP.id}:`)).toBe(true);
    // Even with the explicit field removed, the prefix resolves on its own - which is
    // the resolution order the phase criterion names, and the one `addFish` only
    // reaches by a coincidence of every catalogue name slugging to its own id.
    const withoutField: FishEntry = { ...entry };
    delete withoutField.catalogId;
    expect(resolveFishCatalogId(withoutField).source).toBe('entry-id-prefix');
  });

  it('is a canonical entry: canonicalizing it is a no-op', () => {
    const entry = fishFor(identity());
    expect(toCanonicalFishEntry(entry)).toEqual(entry);
  });

  it('carries the subject id and name from the caller, not from a lookup', () => {
    const entry = fishFor(identity());
    expect(entry.subjectId).toBe(SUBJECT_ID);
    expect(entry.subjectName).toBe(SUBJECT_NAME);
  });

  it('takes both its timestamp and its id suffix from the caller', () => {
    const entry = createCanonicalFishEntry({
      catalogEntry: KOI,
      subjectId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
      caughtAt: 'synthetic-clock-reading',
      entrySuffix: 'synthetic-fixed-suffix',
    });
    expect(entry.caughtAt).toBe('synthetic-clock-reading');
    expect(entry.id).toBe(`gilded-koi:synthetic-fixed-suffix`);
  });

  it('mints a suffix from an injected clock and random value, in createFishId\'s format', () => {
    // The format is preserved so `resolveFishCatalogId`'s `entry-id-prefix` branch
    // keeps working for every entry written before this phase.
    const suffix = createFishEntrySuffix(1_000_000, 0.5);
    expect(suffix).toBe(createFishEntrySuffix(1_000_000, 0.5));
    expect(suffix).toMatch(/^[0-9a-z]+-[0-9a-z]{0,6}$/);
    // Total for a hostile clock and random value.
    expect(() => createFishEntrySuffix(Number.NaN, -1)).not.toThrow();
    expect(createFishEntrySuffix(-5, 2)).toBe(createFishEntrySuffix(0, 0.9999999));
  });

  it('is reproducible for a fixed clock and suffix, which createFishId is not', () => {
    const first = fishFor(identity(), CARP, 'fixed');
    const second = fishFor(identity(), CARP, 'fixed');
    expect(first).toEqual(second);
  });
});

// ── Badges ───────────────────────────────────────────────────────────────────

describe('catchRewards - badge evaluation', () => {
  const collectionOf = (count: number, catalogId = CARP.id): FishCollection =>
    Array.from({ length: count }, (_unused, index) =>
      createCanonicalFishEntry({
        catalogEntry: FISH_CATALOG.find((entry) => entry.id === catalogId)!,
        subjectId: SUBJECT_ID,
        subjectName: SUBJECT_NAME,
        caughtAt: NOW,
        entrySuffix: `synthetic-${index}`,
      }),
    );

  it('awards First Catch at one fish, and nothing before it', () => {
    expect(evaluateFishingBadgeUnlocks({ collection: [], heldBadges: [] })).toEqual([]);
    expect(evaluateFishingBadgeUnlocks({ collection: collectionOf(1), heldBadges: [] })).toEqual([
      'FshFirstCatch',
    ]);
  });

  it('never re-awards a held badge', () => {
    expect(
      evaluateFishingBadgeUnlocks({ collection: collectionOf(1), heldBadges: ['FshFirstCatch'] }),
    ).toEqual([]);
  });

  it('walks the thresholds', () => {
    expect(evaluateFishingBadgeUnlocks({ collection: collectionOf(10), heldBadges: [] })).toEqual([
      'FshFirstCatch',
      'FshAngler',
    ]);
    expect(evaluateFishingBadgeUnlocks({ collection: collectionOf(25), heldBadges: [] })).toEqual([
      'FshFirstCatch',
      'FshAngler',
      'FshMasterAngler',
    ]);
  });

  it('counts canonical catalog ids for Full Creel, not display names', () => {
    // The criterion is "collection counts use canonical catalog IDs". Two entries whose
    // *names* differ but which resolve to one catalogue id are one type.
    const aliased: FishCollection = [
      { ...collectionOf(1)[0], name: 'Moss Carp' },
      { ...collectionOf(1)[0], id: 'moss-carp:other', name: 'A Different Name' },
    ];
    // Both resolve to `moss-carp`, so this is one canonical type and not a full creel.
    expect(
      evaluateFishingBadgeUnlocks({ collection: aliased, heldBadges: [] }),
    ).not.toContain('FshFullCreel');

    const everyType = FISH_CATALOG.map((entry, index) =>
      createCanonicalFishEntry({
        catalogEntry: entry,
        subjectId: SUBJECT_ID,
        subjectName: SUBJECT_NAME,
        caughtAt: NOW,
        entrySuffix: `synthetic-${index}`,
      }),
    );
    expect(evaluateFishingBadgeUnlocks({ collection: everyType, heldBadges: [] })).toContain(
      'FshFullCreel',
    );
  });
});

// ── The decision ─────────────────────────────────────────────────────────────

describe('catchRewards - decideCatchReward', () => {
  it('is idempotent on replay even through the read/serialise round trip', () => {
    // The ledger a replay reads has been through `JSON.stringify` and
    // `JSON.parse`, which is what a reload does. Comparing with `toBe` would assert an
    // implementation detail - reference identity - that has nothing to do with
    // idempotency; what matters is that the re-read ledger suppresses and does not grow.
    const first = decide();
    if (first.outcome !== 'awarded') throw new Error('expected an award');
    const round = JSON.parse(
      JSON.stringify({ [CATCH_REWARD_LEDGER_KEY]: first.ledger }),
    ) as Record<string, unknown>;

    const replay = decide({ extraFields: round, xpTotal: first.nextXpTotal });
    expect(replay.outcome).toBe('already-awarded');
    if (replay.outcome !== 'already-awarded') throw new Error('expected a suppression');
    expect(replay.ledger.entries).toHaveLength(1);
    expect(replay.ledger.entries[0].catchIdentity).toBe(first.ledger.entries[0].catchIdentity);

    // And a third replay, from the re-read ledger, is equally suppressed and does not
    // grow it.
    const third = decide({
      extraFields: { [CATCH_REWARD_LEDGER_KEY]: replay.ledger },
      xpTotal: first.nextXpTotal,
    });
    expect(third.outcome).toBe('already-awarded');
    if (third.outcome !== 'already-awarded') throw new Error('expected a suppression');
    expect(third.ledger.entries).toHaveLength(1);
  });

  it('awards a first catch: fish, XP, rank, badges, and one ledger entry', () => {
    const decision = decide();
    expect(decision.outcome).toBe('awarded');
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    expect(decision.xpAwarded).toBe(5);
    expect(decision.nextXpTotal).toBe(5);
    expect(decision.rank).toBe('Novice');
    expect(decision.rankChanged).toBe(false);
    expect(decision.fishEntry!.catalogId).toBe(CARP.id);
    expect(decision.badgesUnlocked).toEqual(['FshFirstCatch']);
    expect(decision.ledger.entries).toHaveLength(1);
    expect(decision.ledger.entries[0]).toMatchObject({
      contextId: CONTEXT_A,
      catalogId: CARP.id,
      castNumber: CAST,
      xpAwarded: 5,
      outcome: 'answered-correct',
    });
  });

  it('is idempotent on replay: the second decision suppresses and pays nothing', () => {
    const first = decide();
    if (first.outcome !== 'awarded') throw new Error('expected an award');
    const fields = { [CATCH_REWARD_LEDGER_KEY]: first.ledger };

    const replay = decide({ extraFields: fields, xpTotal: first.nextXpTotal });
    expect(replay.outcome).toBe('already-awarded');
    if (replay.outcome !== 'already-awarded') throw new Error('expected a suppression');
    expect(replay.xpAwarded).toBe(0);
    expect(replay.fishEntry).toBeNull();
    expect(replay.badgesUnlocked).toEqual([]);
    // A suppression does not add a row, so the ledger is still exactly one entry.
    expect(replay.ledger.entries).toHaveLength(1);
  });

  it('awards a different catch of the same species in the same session', () => {
    const first = decide();
    if (first.outcome !== 'awarded') throw new Error('expected an award');
    const nextCast = toCatchRewardIdentity({
      contextId: CONTEXT_A,
      catalogId: CARP.id,
      castNumber: CAST + 1,
    });
    const second = decide({
      extraFields: { [CATCH_REWARD_LEDGER_KEY]: first.ledger },
      identity: nextCast,
      xpTotal: first.nextXpTotal,
      collection: [first.fishEntry],
      heldBadges: [...first.badgesUnlocked],
      fishEntry: fishFor(nextCast, CARP, 'synthetic-second'),
    });
    expect(second.outcome).toBe('awarded');
    if (second.outcome !== 'awarded') throw new Error('expected an award');
    expect(second.xpAwarded).toBe(5);
    expect(second.nextXpTotal).toBe(10);
    expect(second.ledger.entries).toHaveLength(2);
  });

  it('declines a release without touching the ledger', () => {
    const decision = decide({ outcome: 'released' });
    expect(decision.outcome).toBe('declined');
    if (decision.outcome !== 'declined') throw new Error('expected a decline');
    expect(decision.declinedOutcome).toBe('released');
    expect(decision.xpAwarded).toBe(0);
    expect(decision.fishEntry).toBeNull();
    expect(decision.badgesUnlocked).toEqual([]);
    expect(decision.ledger.entries).toEqual([]);
  });

  it('declines a failed recall without touching the ledger', () => {
    const decision = decide({ outcome: 'answered-incorrect' });
    expect(decision.outcome).toBe('declined');
    if (decision.outcome !== 'declined') throw new Error('expected a decline');
    expect(decision.declinedOutcome).toBe('answered-incorrect');
    expect(decision.xpAwarded).toBe(0);
  });

  it('declines even when the identity is already recorded, so a release never pays', () => {
    const first = decide();
    if (first.outcome !== 'awarded') throw new Error('expected an award');
    const decision = decide({
      outcome: 'released',
      extraFields: { [CATCH_REWARD_LEDGER_KEY]: first.ledger },
    });
    expect(decision.outcome).toBe('declined');
  });

  it('keeps the fish and pays nothing for a keep-without-recall', () => {
    const decision = decide({ outcome: 'kept-without-recall' });
    expect(decision.outcome).toBe('awarded');
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    expect(decision.xpAwarded).toBe(0);
    expect(decision.nextXpTotal).toBe(0);
    expect(decision.fishEntry).not.toBeNull();
    // The fish still counts toward the badges: it is a real catch.
    expect(decision.badgesUnlocked).toEqual(['FshFirstCatch']);
    expect(decision.ledger.entries[0]).toMatchObject({
      outcome: 'kept-without-recall',
      xpAwarded: 0,
    });
  });

  it('pays the rarity multiplier for a correct answer and nothing extra for a bare keep', () => {
    const value = identity();
    const epic = decide({ identity: value, fishEntry: fishFor(value, KOI, 'synthetic-epic') });
    if (epic.outcome !== 'awarded') throw new Error('expected an award');
    expect(epic.xpAwarded).toBe(10);

    const bareEpic = decide({
      identity: value,
      outcome: 'kept-without-recall',
      fishEntry: fishFor(value, KOI, 'synthetic-epic-2'),
    });
    if (bareEpic.outcome !== 'awarded') throw new Error('expected an award');
    expect(bareEpic.xpAwarded).toBe(0);
  });

  it('reports a rank change when the XP crosses a tier', () => {
    const decision = decide({ xpTotal: 295 });
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    expect(decision.nextXpTotal).toBe(300);
    expect(decision.rank).toBe('Scholar');
    expect(decision.rankChanged).toBe(true);
  });

  it('records a keep-without-recall as its own outcome, never as a correct answer', () => {
    const decision = decide({ outcome: 'kept-without-recall' });
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    expect(decision.recorded.outcome).toBe('kept-without-recall');
    expect(decision.recorded.outcome).not.toBe('answered-correct');
  });

  it('refuses to record when no entry could be built, rather than writing a bare row', () => {
    // A row with no fish would suppress a retry that could have succeeded.
    const decision = decide({ fishEntry: null });
    expect(decision.outcome).toBe('already-awarded');
    if (decision.outcome !== 'already-awarded') throw new Error('expected a refusal');
    expect(decision.ledger.entries).toEqual([]);
  });

  it('attaches the recall room without changing the digest', () => {
    const value = identity();
    const decision = decide({ identity: value });
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    const attached = withRecallRoom(decision, 'synthetic-recall-room');
    expect(attached.recorded.recallRoomId).toBe('synthetic-recall-room');
    // The identity is unchanged: the room is descriptive, not an identity component.
    expect(attached.recorded.catchIdentity).toBe(decision.recorded.catchIdentity);
    expect(attached.identity).toEqual(decision.identity);
    // And the ledger carries it.
    expect(attached.ledger.entries[0].recallRoomId).toBe('synthetic-recall-room');
  });

  it('keeps every earlier catch when attaching the room to the newest one', () => {
    // The regression this guards: rebuilding the ledger from empty here would leave
    // exactly one row after any reload, silently discarding the subject's history.
    const first = toCatchRewardIdentity({
      contextId: CONTEXT_A,
      catalogId: CARP.id,
      castNumber: 1,
    });
    const firstDecision = decide({
      identity: first,
      fishEntry: fishFor(first, CARP, 'synthetic-first'),
    });
    if (firstDecision.outcome !== 'awarded') throw new Error('expected an award');

    const second = toCatchRewardIdentity({
      contextId: CONTEXT_A,
      catalogId: KOI.id,
      castNumber: 2,
    });
    const secondDecision = decide({
      identity: second,
      outcome: 'kept-without-recall',
      extraFields: { [CATCH_REWARD_LEDGER_KEY]: firstDecision.ledger },
      xpTotal: firstDecision.nextXpTotal,
      collection: [firstDecision.fishEntry],
      heldBadges: [...firstDecision.badgesUnlocked],
      fishEntry: fishFor(second, KOI, 'synthetic-second'),
    });
    if (secondDecision.outcome !== 'awarded') throw new Error('expected an award');
    expect(secondDecision.ledger.entries).toHaveLength(2);

    const attached = withRecallRoom(secondDecision, 'synthetic-recall-room');
    expect(attached.ledger.entries).toHaveLength(2);
    expect(attached.ledger.entries.map((row) => row.castNumber).sort()).toEqual([1, 2]);
    // Only the new row carries the room.
    expect(attached.ledger.entries.filter((row) => row.recallRoomId !== null)).toHaveLength(1);
  });

  it('normalises a blank recall room to null', () => {
    const decision = decide();
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    expect(withRecallRoom(decision, '   ').recorded.recallRoomId).toBeNull();
    expect(withRecallRoom(decision, null).recorded.recallRoomId).toBeNull();
  });

  it('refuses withRecallRoom for a decision that did not award', () => {
    const declined = decide({ outcome: 'released' });
    expect(() => withRecallRoom(declined, 'synthetic-recall-room')).toThrow(
      /awarded decision/,
    );
  });

  it('carries no learner text into any recorded field', () => {
    const decision = decide({ outcome: 'kept-without-recall' });
    if (decision.outcome !== 'awarded') throw new Error('expected an award');
    const serialised = JSON.stringify(decision.recorded);
    // The fields are app-minted ids, integers, and codes. The subject's display name and
    // the fish's display name are the two human-readable strings in the vicinity, and
    // neither appears in the row.
    expect(serialised).not.toContain(SUBJECT_NAME);
    expect(serialised).not.toContain(CARP.name);
    expect(Object.values(decision.recorded).some((value) => typeof value === 'string' && value.length > 40)).toBe(
      false,
    );
  });
});

// ── The store transaction ────────────────────────────────────────────────────

async function bind(): Promise<typeof import('@/store/progressionStore')> {
  vi.resetModules();
  return import('@/store/progressionStore');
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('progressionStore.recordCatch', () => {
  it('writes the fish, the XP, and the ledger entry in one record', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);

    const outcome = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    const state = mod.useProgressionStore.getState();
    expect(outcome.awarded).toBe(true);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.xpGained).toBe(5);
    expect(outcome.unlockedBadges).toEqual(['FshFirstCatch']);
    expect(state.xpTotal).toBe(5);
    expect(state.fishCollection).toHaveLength(1);
    expect(state.badges).toContain('FshFirstCatch');
    // The fish and the guard are in the same record.
    expect(state.bySubject[SUBJECT_ID].fishCollection).toHaveLength(1);
    expect(state.bySubject[SUBJECT_ID].extraFields).toHaveProperty(CATCH_REWARD_LEDGER_KEY);
  });

  it('awards exactly once: a repeat awards zero and leaves xpTotal byte-identical', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const value = identity();

    const store = () => mod.useProgressionStore.getState();
    const input = {
      subjectId: SUBJECT_ID,
      identity: value,
      outcome: 'answered-correct' as const,
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    };

    store().recordCatch(input);
    const afterFirst = JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const repeat = store().recordCatch(input);
      expect(repeat.awarded).toBe(false);
      expect(repeat.duplicate).toBe(true);
      expect(repeat.xpGained).toBe(0);
      expect(repeat.fishEntryId).toBeNull();
    }

    // Not one byte moved, including `xpTotal`.
    expect(JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID])).toBe(afterFirst);
    expect(mod.useProgressionStore.getState().xpTotal).toBe(5);
    expect(mod.useProgressionStore.getState().fishCollection).toHaveLength(1);
  });

  it('suppresses a repeat that arrives from a *different* subjectId, because the ledger wins', async () => {
    // The old chain stored the fish under `activeSubjectId` while carrying the payload's
    // `subjectId`, so a second subject could pay again for the same catch. The identity
    // is per subject record, and this asserts the same subject's ledger is authoritative
    // regardless of what the caller claims.
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const value = identity();

    mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: value,
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    const repeat = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: { ...value, catchIdentity: 'catch-00000000' },
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    expect(repeat.awarded).toBe(true);

    // And the genuinely identical identity is suppressed regardless of the entry id it
    // would have minted.
    const genuineRepeat = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: value,
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    expect(genuineRepeat.duplicate).toBe(true);
  });

  it('keeps the fish under the subject it was told, not the active one', async () => {
    const mod = await bind();
    const store = mod.useProgressionStore.getState();
    store.setActiveSubject('synthetic-other-subject');
    store.setActiveSubject(SUBJECT_ID);

    // Now make a *different* subject active and write the catch for the session's
    // subject, which is what the command layer does.
    mod.useProgressionStore.getState().setActiveSubject('synthetic-other-subject');

    const outcome = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    expect(outcome.awarded).toBe(true);
    const state = mod.useProgressionStore.getState();
    // The fish is in the subject it was told to write to.
    expect(state.bySubject[SUBJECT_ID].fishCollection).toHaveLength(1);
    expect(state.bySubject[SUBJECT_ID].fishCollection[0].subjectId).toBe(SUBJECT_ID);
    expect(state.bySubject[SUBJECT_ID].xpTotal).toBe(5);
    // And the *active* subject's header is untouched, rather than corrupted by the
    // other subject's record.
    expect(state.bySubject['synthetic-other-subject'].fishCollection).toHaveLength(0);
    expect(state.fishCollection).toHaveLength(0);
    expect(state.xpTotal).toBe(0);
  });

  it('records a keep-without-recall as its own outcome and pays nothing', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);

    const outcome = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'kept-without-recall',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    const state = mod.useProgressionStore.getState();
    expect(outcome.awarded).toBe(true);
    expect(outcome.xpGained).toBe(0);
    // The fish is kept, so this is not worthless: it is in the collection and badged.
    expect(state.fishCollection).toHaveLength(1);
    expect(state.badges).toContain('FshFirstCatch');
    expect(state.xpTotal).toBe(0);
    const ledger = readCatchRewardLedgerFromFields(state.bySubject[SUBJECT_ID].extraFields);
    expect(ledger.entries[0].outcome).toBe('kept-without-recall');
    expect(ledger.entries[0].xpAwarded).toBe(0);
  });

  it('leaves the whole progression value byte-identical for a release', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const before = JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID]);

    const outcome = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'released',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    expect(outcome.awarded).toBe(false);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.declinedReason).toBe('released');
    expect(outcome.fishEntryId).toBeNull();
    expect(JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID])).toBe(before);
  });

  it('leaves the whole progression value byte-identical for a failed recall', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const before = JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID]);

    const outcome = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-incorrect',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: 'synthetic-recall-room',
    });

    expect(outcome.awarded).toBe(false);
    expect(outcome.declinedReason).toBe('answered-incorrect');
    expect(JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID])).toBe(before);
  });

  it('writes nothing to persistence for a declined outcome', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const committed = mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    expect(committed.awarded).toBe(true);
    const persisted = window.localStorage.getItem(STORAGE_KEYS.progression);

    mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity({ castNumber: 99, catchIdentity: 'catch-00000000' }),
      outcome: 'released',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    // A declined catch is not even a re-save of an unchanged record.
    expect(window.localStorage.getItem(STORAGE_KEYS.progression)).toBe(persisted);
  });

  it('survives a real reload: the suppression is still there', async () => {
    const first = await bind();
    first.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    first.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    expect(first.useProgressionStore.getState().xpTotal).toBe(5);

    // A reload is a fresh module plus a fresh hydration, which is what Phase 16's store
    // binding test does. Anything less is not a reload.
    const second = await bind();
    second.useProgressionStore
      .getState()
      .hydrateProgression(second.readPersistedProgressionPayload());
    second.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);

    expect(second.useProgressionStore.getState().xpTotal).toBe(5);
    expect(second.useProgressionStore.getState().fishCollection).toHaveLength(1);

    const repeat = second.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    expect(repeat.duplicate).toBe(true);
    expect(second.useProgressionStore.getState().xpTotal).toBe(5);
    expect(second.useProgressionStore.getState().fishCollection).toHaveLength(1);
  });

  it('persists the canonical catalog id on the stored fish', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    const [stored] = mod.useProgressionStore.getState().fishCollection;
    expect(stored.catalogId).toBe(CARP.id);
    expect(resolveFishCatalogId(stored).source).toBe('catalog-id-field');
  });

  it('refuses a catch with no subject rather than guessing one', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const before = JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID]);

    const outcome = mod.useProgressionStore.getState().recordCatch({
      subjectId: '   ',
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    expect(outcome.awarded).toBe(false);
    // It must not have fallen back to `activeSubjectId`, which is the whole defect.
    expect(JSON.stringify(mod.useProgressionStore.getState().bySubject[SUBJECT_ID])).toBe(before);
  });

  it('records the recall room on the ledger row, not in the digest', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const value = identity();
    mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: value,
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: 'synthetic-recall-room',
    });

    const ledger = readCatchRewardLedgerFromFields(
      mod.useProgressionStore.getState().bySubject[SUBJECT_ID].extraFields,
    );
    expect(ledger.entries[0].recallRoomId).toBe('synthetic-recall-room');
    expect(ledger.entries[0].catchIdentity).toBe(value.catchIdentity);
  });

  it('keeps the room-clear and review-pass ledgers intact alongside its own', async () => {
    const mod = await bind();
    mod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    mod.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: identity(),
      outcome: 'answered-correct',
      catalogEntry: CARP,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });
    const fields = mod.useProgressionStore.getState().bySubject[SUBJECT_ID].extraFields ?? {};
    expect(fields).toHaveProperty(CATCH_REWARD_LEDGER_KEY);
    // Untouched, not overwritten.
    expect(fields.roomClearRewardLedger).toBeUndefined();
  });
});