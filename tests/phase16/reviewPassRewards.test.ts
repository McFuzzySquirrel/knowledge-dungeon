/**
 * Phase 16: the review-pass reward ledger.
 *
 * The pure module first, then the store it rides in. Mirrors
 * `tests/unit/roomClearRewards.test.ts` because this ledger is the same kind of
 * object for the same reason: a reward that can be minted twice must be guarded
 * durably, in the same record write as the reward itself.
 *
 * Every fixture below is obviously synthetic: `synthetic-*` ids and
 * `Synthetic *` topics invented for this file, no learner data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REVIEW_PASS_REWARD_LEDGER_KEY,
  decideReviewPassReward,
  deriveReviewPassIdentity,
  emptyReviewPassRewardLedger,
  hasReviewPassReward,
  latestReviewPassRewardForRoom,
  readReviewPassRewardLedger,
  readReviewPassRewardLedgerFromFields,
  recordReviewPassReward,
  toReviewPassRewardIdentity,
  writeReviewPassRewardLedgerToFields,
  type ReviewPassRewardEntry,
} from '@/core/review/reviewPassRewards';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';

const SUBJECT_ID = 'synthetic-review-subject';
const ROOM_A = 'synthetic-review-room-a';
const ROOM_B = 'synthetic-review-room-b';
const NOW = '2026-03-03T03:03:03.000Z';

function entry(roomId: string, passNumber: number, awardedAt = NOW): ReviewPassRewardEntry {
  return {
    roomId,
    passNumber,
    reviewIdentity: deriveReviewPassIdentity({ roomId, passNumber }),
    awardedAt,
  };
}

// ── Identity ────────────────────────────────────────────────────────────────

describe('reviewPassRewards - identity', () => {
  it('is stable across calls for the same (room, pass)', () => {
    const first = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 3 });
    const second = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 3 });
    expect(first).toBe(second);
  });

  it('is recognisable, opaque, and prefixed', () => {
    const identity = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 1 });
    expect(identity.startsWith('rpass-')).toBe(true);
    // Eight lowercase hex digits after the prefix: a digest, not an identifier.
    expect(identity).toMatch(/^rpass-[0-9a-f]{8}$/);
  });

  it('changes when the pass number changes', () => {
    const first = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 1 });
    const second = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 2 });
    expect(first).not.toBe(second);
  });

  it('differs per room, so two rooms never share one pass identity', () => {
    const first = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 1 });
    const second = deriveReviewPassIdentity({ roomId: ROOM_B, passNumber: 1 });
    expect(first).not.toBe(second);
  });

  it('is total for a room id the dungeon does not list, and for a nonsense pass', () => {
    expect(() =>
      deriveReviewPassIdentity({ roomId: 'synthetic-room-that-was-deleted', passNumber: 1 }),
    ).not.toThrow();
    expect(
      deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: Number.NaN }),
    ).toBe(deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 0 }));
  });

  it('builds a matching identity and pass number in one call', () => {
    const identity = toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 2.9 });
    expect(identity).toEqual({
      roomId: ROOM_A,
      passNumber: 2,
      reviewIdentity: deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 2 }),
    });
  });
});

// ── Decision ────────────────────────────────────────────────────────────────

describe('reviewPassRewards - decision', () => {
  it('awards the first pass and records the entry', () => {
    const decision = decideReviewPassReward({
      extraFields: undefined,
      roomId: ROOM_A,
      passNumber: 1,
      awardedAt: NOW,
    });

    expect(decision.outcome).toBe('awarded');
    expect(decision.ledger.entries).toHaveLength(1);
    expect(decision.ledger.entries[0]).toMatchObject({ roomId: ROOM_A, passNumber: 1 });
  });

  it('suppresses a replay of the same (room, pass)', () => {
    const first = decideReviewPassReward({
      extraFields: undefined,
      roomId: ROOM_A,
      passNumber: 1,
      awardedAt: NOW,
    });
    const replay = decideReviewPassReward({
      extraFields: writeReviewPassRewardLedgerToFields(undefined, first.ledger),
      roomId: ROOM_A,
      passNumber: 1,
      awardedAt: '2026-03-04T00:00:00.000Z',
    });

    expect(replay.outcome).toBe('already-awarded');
    // Suppressed means untouched: not "rewritten with a newer timestamp".
    expect(replay.ledger).toEqual(first.ledger);
  });

  it('awards again for a new pass of the same room', () => {
    const first = decideReviewPassReward({
      extraFields: undefined,
      roomId: ROOM_A,
      passNumber: 1,
      awardedAt: NOW,
    });
    const second = decideReviewPassReward({
      extraFields: writeReviewPassRewardLedgerToFields(undefined, first.ledger),
      roomId: ROOM_A,
      passNumber: 2,
      awardedAt: NOW,
    });

    expect(second.outcome).toBe('awarded');
    expect(second.ledger.entries).toHaveLength(2);
    // Newest first.
    expect(second.ledger.entries[0]).toMatchObject({ passNumber: 2 });
  });

  it('keeps another room unaffected', () => {
    const first = decideReviewPassReward({
      extraFields: undefined,
      roomId: ROOM_A,
      passNumber: 1,
      awardedAt: NOW,
    });
    const other = decideReviewPassReward({
      extraFields: writeReviewPassRewardLedgerToFields(undefined, first.ledger),
      roomId: ROOM_B,
      passNumber: 1,
      awardedAt: NOW,
    });

    expect(other.outcome).toBe('awarded');
    expect(other.ledger.entries).toHaveLength(2);
  });

  it('is idempotent when the same entry is recorded twice', () => {
    const once = recordReviewPassReward(emptyReviewPassRewardLedger(), entry(ROOM_A, 1));
    const twice = recordReviewPassReward(once, entry(ROOM_A, 1, '2026-04-04T00:00:00.000Z'));
    expect(twice).toEqual(once);
    expect(twice.entries).toHaveLength(1);
  });

  it('reports the latest entry for a room and null for one never awarded', () => {
    const ledger = recordReviewPassReward(emptyReviewPassRewardLedger(), entry(ROOM_A, 1));
    expect(latestReviewPassRewardForRoom(ledger, ROOM_A)).toMatchObject({ passNumber: 1 });
    expect(latestReviewPassRewardForRoom(ledger, ROOM_B)).toBeNull();
  });

  it('hasReviewReward keys on (room, pass), never on the room alone', () => {
    const ledger = recordReviewPassReward(emptyReviewPassRewardLedger(), entry(ROOM_A, 1));
    expect(hasReviewPassReward(ledger, ROOM_A, 1)).toBe(true);
    expect(hasReviewPassReward(ledger, ROOM_A, 2)).toBe(false);
    expect(hasReviewPassReward(ledger, ROOM_B, 1)).toBe(false);
  });
});

// ── Reading and writing ─────────────────────────────────────────────────────

describe('reviewPassRewards - persistence shape', () => {
  it('reads an absent or unrecognized field as an empty ledger', () => {
    expect(readReviewPassRewardLedgerFromFields(undefined)).toEqual(emptyReviewPassRewardLedger());
    expect(readReviewPassRewardLedgerFromFields({})).toEqual(emptyReviewPassRewardLedger());
    expect(readReviewPassRewardLedger(null)).toEqual(emptyReviewPassRewardLedger());
    expect(readReviewPassRewardLedger('not a ledger')).toEqual(emptyReviewPassRewardLedger());
    expect(readReviewPassRewardLedger(42)).toEqual(emptyReviewPassRewardLedger());
    expect(readReviewPassRewardLedger({ entries: 'nope' })).toEqual(
      emptyReviewPassRewardLedger(),
    );
  });

  it('drops malformed entries rather than trusting them', () => {
    const ledger = readReviewPassRewardLedger({
      version: 1,
      entries: [
        null,
        'nope',
        { roomId: '', reviewIdentity: 'rpass-00000000', passNumber: 1 },
        { roomId: ROOM_A, reviewIdentity: '', passNumber: 1 },
        // No usable pass number: the entry cannot be matched, so keeping it would
        // grow the ledger with rows that suppress nothing.
        { roomId: ROOM_A, reviewIdentity: 'rpass-11111111', passNumber: 0 },
        { roomId: ROOM_A, reviewIdentity: 'rpass-22222222', passNumber: 'two' },
        { roomId: ROOM_A, reviewIdentity: 'rpass-33333333', passNumber: 4, awardedAt: NOW },
      ],
    });

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toEqual({
      roomId: ROOM_A,
      passNumber: 4,
      reviewIdentity: 'rpass-33333333',
      awardedAt: NOW,
    });
  });

  it('preserves other preserved fields when the ledger is written', () => {
    const fields = writeReviewPassRewardLedgerToFields(
      { roomClearRewardLedger: { version: 1, entries: [] }, somethingLaterPhaseWrote: 7 },
      emptyReviewPassRewardLedger(),
    );

    expect(fields.roomClearRewardLedger).toEqual({ version: 1, entries: [] });
    expect(fields.somethingLaterPhaseWrote).toBe(7);
    expect(fields[REVIEW_PASS_REWARD_LEDGER_KEY]).toEqual(emptyReviewPassRewardLedger());
  });

  it('uses a static-vocabulary carrier key that is not learner-influenced', () => {
    expect(REVIEW_PASS_REWARD_LEDGER_KEY).toBe('reviewPassRewardLedger');
  });
});

// ── Privacy ─────────────────────────────────────────────────────────────────

describe('reviewPassRewards - privacy', () => {
  it('pins that no topic, note text, or artifact markdown reaches a digest or an entry', () => {
    // The identity is the only hashed value, and its input list is the whole
    // contract. If someone adds the room's topic to it, this fails.
    const before = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 1 });
    const afterTopic = deriveReviewPassIdentity({ roomId: ROOM_A, passNumber: 1 });
    expect(before).toBe(afterTopic);

    // A ledger entry carries an app id, an integer pass number, a digest, and a
    // timestamp - exactly four keys, none of which can hold prose.
    const decision = decideReviewPassReward({
      extraFields: undefined,
      roomId: ROOM_A,
      passNumber: 1,
      awardedAt: NOW,
    });
    expect(Object.keys(decision.ledger.entries[0]).sort()).toEqual([
      'awardedAt',
      'passNumber',
      'reviewIdentity',
      'roomId',
    ]);
    expect(typeof decision.ledger.entries[0].passNumber).toBe('number');
    expect(decision.ledger.entries[0].reviewIdentity).toMatch(/^rpass-[0-9a-f]{8}$/);
  });

  it('keeps a room id that *looks* like prose out of every other field', () => {
    // Even a hostile room id can only reach the id slot and the digest.
    const odd = deriveReviewPassIdentity({ roomId: 'synthetic room #1 "vectors"', passNumber: 1 });
    expect(odd).toMatch(/^rpass-[0-9a-f]{8}$/);
  });
});

// ── The store transaction ───────────────────────────────────────────────────

type ProgressionStoreModule = typeof import('@/store/progressionStore');

async function loadStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  const mod = await import('@/store/progressionStore');
  mod.useProgressionStore
    .getState()
    .hydrateProgression(mod.readPersistedProgressionPayload());
  return mod;
}

function readMirrorRecord(subjectId = SUBJECT_ID): Record<string, unknown> {
  const raw = window.localStorage.getItem(STORAGE_KEYS.progression);
  if (raw === null) throw new Error('the store wrote nothing to the progression key');
  const payload = JSON.parse(raw) as { bySubject: Record<string, Record<string, unknown>> };
  const record = payload.bySubject[subjectId];
  if (record === undefined) throw new Error(`no mirrored record for ${subjectId}`);
  return record;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('progressionStore.awardReviewPass - durability', () => {
  it('lands the ledger entry and the XP in one record write', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);

    const result = useProgressionStore
      .getState()
      .awardReviewPass(toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 }));

    expect(result.awarded).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.xpGained).toBe(6);

    // One read of the persisted record: the ledger entry and `xpTotal` are in the
    // same object, which is what "no partial-reward window" means here.
    const mirrored = readMirrorRecord();
    expect(mirrored.xpTotal).toBe(6);
    expect(mirrored.reviewPasses).toBe(1);
    const ledger = mirrored[REVIEW_PASS_REWARD_LEDGER_KEY] as {
      entries: Array<{ roomId: string; passNumber: number }>;
    };
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ roomId: ROOM_A, passNumber: 1 });
  });

  it('two same-tick awards for one (room, pass) pay exactly once', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const identity = toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 });

    const first = useProgressionStore.getState().awardReviewPass(identity);
    const second = useProgressionStore.getState().awardReviewPass(identity);

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(useProgressionStore.getState().xpTotal).toBe(6);
    expect(useProgressionStore.getState().reviewPasses).toBe(1);
  });

  it('a suppressed award leaves xpTotal byte-identical', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const identity = toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 });

    useProgressionStore.getState().awardReviewPass(identity);
    const persistedBefore = JSON.stringify(readMirrorRecord());

    useProgressionStore.getState().awardReviewPass(identity);

    // Nothing at all was written: not the XP, not the ledger, not the mirror.
    expect(JSON.stringify(readMirrorRecord())).toBe(persistedBefore);
    expect(useProgressionStore.getState().xpTotal).toBe(6);
  });

  it('awards a genuine new pass of the same room', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);

    useProgressionStore
      .getState()
      .awardReviewPass(toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 }));
    const second = useProgressionStore
      .getState()
      .awardReviewPass(toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 2 }));

    expect(second.awarded).toBe(true);
    expect(useProgressionStore.getState().xpTotal).toBe(12);
    expect(useProgressionStore.getState().reviewPasses).toBe(2);
  });

  it('the guard survives a reload and a fresh hydration', async () => {
    const first = await loadStore();
    first.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const identity = toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 });
    first.useProgressionStore.getState().awardReviewPass(identity);
    const xpAfterFirst = first.useProgressionStore.getState().xpTotal;

    // A reload: drop the module registry, import again, hydrate as the bootstrap
    // does. That is the window that used to award a second time.
    const second = await loadStore();
    second.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const retry = second.useProgressionStore.getState().awardReviewPass(identity);

    expect(retry.awarded).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(second.useProgressionStore.getState().xpTotal).toBe(xpAfterFirst);
    expect(second.useProgressionStore.getState().reviewPasses).toBe(1);
  });

  it('keeps the pre-Phase-16 unconditional award when no identity is supplied', async () => {
    // The documented carve-out: `NoteEditorModal`'s note-submit lane and the
    // Phase 15 rollback both call this with no argument.
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);

    const first = useProgressionStore.getState().awardReviewPass();
    const second = useProgressionStore.getState().awardReviewPass();

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(true);
    expect(second.duplicate).toBe(false);
    expect(useProgressionStore.getState().xpTotal).toBe(12);
    // And it writes no ledger at all, so the byte-comparison lanes stay clean.
    expect(readMirrorRecord()[REVIEW_PASS_REWARD_LEDGER_KEY]).toBeUndefined();
  });

  it('reports that nothing was awarded when there is no active subject', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(null);

    const result = useProgressionStore
      .getState()
      .awardReviewPass(toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 }));

    expect(result.awarded).toBe(false);
    // The discriminator: `awarded: false` alone would be ambiguous.
    expect(result.duplicate).toBe(false);
    expect(result.xpGained).toBe(0);
  });

  it('an existing preserved unknown field survives an awarded review pass', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.setState({
      bySubject: {
        [SUBJECT_ID]: {
          ...useProgressionStore.getState().bySubject[SUBJECT_ID],
          extraFields: { somethingLaterPhaseWrote: 'kept' },
        },
      },
    });

    useProgressionStore
      .getState()
      .awardReviewPass(toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 }));

    expect(readMirrorRecord().somethingLaterPhaseWrote).toBe('kept');
  });
});
