/**
 * Progression store - XP, rank, badges, inventory. Persists to localStorage
 * mirroring repo-dungeon's progression-store wiring.
 *
 * Phase 3c additions: equippable loot/gear system, cross-subject achievements.
 */
import { create } from 'zustand';
import {
  assignRankTier,
  awardRoomClearProgression,
  type RankTier,
  type EquippableLootItem,
  type CrossSubjectProgress,
  computeEquipBonuses,
  rollEquippableLoot,
  computeCrossSubjectProgress,
  evaluateAchievementUnlocks,
  FSH_XP_PER_CORRECT_ANSWER,
  FISHING_BADGE_DEFS,
  FISHING_BADGE_IDS,
  type FishingBadgeId,
} from '@/core/progression';
import { STORAGE_KEYS, getActiveSubjectId } from '@/services/persistence/subjectPersistence';
import { writeThroughInBackground } from '@/services/persistence/v2/dualWrite';
import { currentStorageV2Repository } from '@/services/persistence/v2/repositorySelection';
import type { FishEntry, FishRarity, FishCollection, FishCatalogEntry } from '@/core/fishing/fishingTypes';
import { FISH_RARITY_XP_MULTIPLIER, FISH_CATALOG } from '@/core/fishing/fishingTypes';
import { createFishId, addFishToCollection, countUniqueTypes } from '@/core/fishing/fishCollectionService';
import {
  CATCH_OUTCOME_POLICY,
  createCanonicalFishEntry,
  createFishEntrySuffix,
  decideCatchReward,
  writeCatchRewardLedgerToFields,
  withRecallRoom,
  type CatchDeclinedOutcome,
  type CatchOutcome,
  type CatchRewardIdentity,
} from '@/core/fishing/catchRewards';
import {
  CANONICAL_PROGRESSION_VERSION,
  makeDefaultSubjectProgression,
  normalizeProgressionRecord,
  toLegacyV3ProgressionRecord,
  type CanonicalCollectedNote,
  type CanonicalLootItem,
  type CanonicalSubjectProgressionWriteShape,
} from '@/core/progression/canonicalProgression';
import {
  decideRoomClearReward,
  writeRoomClearRewardLedgerToFields,
  type RoomClearRewardDecision,
} from '@/core/progression/roomClearRewards';
import {
  decideReviewPassReward,
  writeReviewPassRewardLedgerToFields,
  type ReviewPassRewardDecision,
  type ReviewPassRewardIdentity,
} from '@/core/review/reviewPassRewards';
import {
  applyInterruptedReviewSessionWrite,
  type InterruptedReviewSessionWrite,
} from '@/core/review/interruptedReviewSession';
import {
  localDateKey,
  toFishingOutcomeEvent,
  toNoteSubmissionEvent,
  toReviewCompletionEvent,
  toXpAwardEvent,
  noteSubmissionEventSourceIdentity,
  reviewCompletionEventSourceIdentity,
  fishingOutcomeEventSourceIdentity,
  writeStatisticsEventLedgerToFields,
  decideStatisticsEvent,
  decideNoteSubmission,
  deriveNoteSubmissionSourceIdentity,
  type NoteSubmissionEventIdentity,
  type StatisticsEvent,
} from '@/core/statistics';
import { emitStatisticsActivity } from '@/core/statistics/activitySink';

export type LootItem = CanonicalLootItem;
export type CollectedNoteEntry = CanonicalCollectedNote;

/**
 * Per-subject progression in the store is the canonical record.
 *
 * The two canonical-only fields (`subjectId`, `extraFields`) are optional, not
 * merely omitted from the type: a record the store built itself (the default for
 * a subject with nothing stored) genuinely has neither. Identity always comes
 * from the `bySubject` map key, and preserved unknown fields live in
 * `extraFields` until {@link savePersistedBySubject} flattens them back out.
 */
type PersistedSubjectProgression = CanonicalSubjectProgressionWriteShape;

const REVIEW_PASS_XP = 6;

/**
 * Write Phase 18's statistics events into a record's preserved fields.
 *
 * Each event is decided through {@link decideStatisticsEvent} and only an event that was
 * actually recorded is written, so a repeated decision is a no-op rather than a second
 * ledger row. Called **inside** the same `set` of one record as the reward, which is the
 * whole reason the statistic cannot disagree with the award: a failed write persists the
 * reward, its guard, and its statistic together or none of them.
 *
 * Returns `extraFields` **unchanged** - including `undefined` - when there is nothing to
 * write, so a call that records no statistics gains no `extraFields` key. That is now a
 * statement about the *call*, not about the lane: Phase 18 restricted this to `clear`-bearing
 * calls so that a shipped lane kept gaining no key, which meant a completed note on the default
 * artifact recorded nothing anywhere. Every lane that names a room records; only a call that names
 * no room still writes the pre-Phase-18 byte sequence.
 */
function writeStatisticsEventsToFields(
  extraFields: Record<string, unknown> | undefined,
  events: readonly StatisticsEvent[],
): Record<string, unknown> | undefined {
  if (events.length === 0) return extraFields;
  let next: Record<string, unknown> | undefined = extraFields;
  for (const event of events) {
    const decision = decideStatisticsEvent({ extraFields: next, event });
    if (decision.outcome !== 'recorded') continue;
    next = writeStatisticsEventLedgerToFields(next ?? {}, decision.ledger);
  }
  return next;
}

/**
 * The local calendar day an event was recorded on, and the ISO instant it was recorded at.
 *
 * Read once per award so the two agree: a write that crossed local midnight would otherwise
 * put an event on a day its own timestamp does not name.
 */
function statisticsStamp(): { localDate: string; recordedAt: string } {
  const recordedAt = new Date().toISOString();
  return { localDate: localDateKey(recordedAt), recordedAt };
}

/**
 * The statistics events one awarded room clear records.
 *
 * **Two events, not one.** The note and the XP it paid are separate entries because they are
 * separate questions - "how many notes did this learner write" and "how much XP did they earn
 * this subject" - and a surface that wants one must not have to sum the other. The XP event's
 * identity is derived from the *same* `(room, clear generation)` components as the note event,
 * so the two are suppressed by the same rule and can never disagree.
 *
 * Both are built by the core constructors, which derive the identity from the same components
 * the event stores, so a caller cannot build an event whose identity was derived from
 * something it does not carry.
 */
function noteStatisticsEvents(input: {
  subjectId: string;
  identity: NoteSubmissionEventIdentity;
  xpAwarded: number;
}): readonly StatisticsEvent[] {
  const { localDate, recordedAt } = statisticsStamp();
  const identity = input.identity;
  return [
    toNoteSubmissionEvent({
      subjectId: input.subjectId,
      identity,
      localDate,
      recordedAt,
      xpAwarded: input.xpAwarded,
    }),
    toXpAwardEvent({
      subjectId: input.subjectId,
      source: 'note-submission',
      sourceIdentity: noteSubmissionEventSourceIdentity(identity),
      localDate,
      recordedAt,
      amount: input.xpAwarded,
    }),
  ];
}

/**
 * The statistics events one awarded review pass records. See {@link noteStatisticsEvents}.
 */
function reviewStatisticsEvents(input: {
  subjectId: string;
  roomId: string;
  passNumber: number;
  /** The digest the award site already computed. Part of the identity, never re-derived. */
  reviewIdentity: string;
  xpAwarded: number;
}): readonly StatisticsEvent[] {
  const { localDate, recordedAt } = statisticsStamp();
  // The `reviewIdentity` the reward site already computed is part of the identity, so the
  // event is suppressed by exactly the rule that suppressed the award.
  const identity: ReviewPassRewardIdentity = {
    roomId: input.roomId,
    passNumber: input.passNumber,
    reviewIdentity: input.reviewIdentity,
  };
  return [
    toReviewCompletionEvent({
      subjectId: input.subjectId,
      identity,
      localDate,
      recordedAt,
      xpAwarded: input.xpAwarded,
    }),
    toXpAwardEvent({
      subjectId: input.subjectId,
      source: 'review-completion',
      sourceIdentity: reviewCompletionEventSourceIdentity(identity),
      localDate,
      recordedAt,
      amount: input.xpAwarded,
    }),
  ];
}

/**
 * The statistics events one awarded catch records. See {@link noteStatisticsEvents}.
 *
 * Only an **awarded** catch produces events. A declined outcome - a release or a wrong
 * recall - returns from `recordCatch` before any `set`, which is Phase 17's "a declined
 * outcome writes nothing at all", and it writes nothing here too. The session record still
 * learns about it through `emitStatisticsActivity`, which is a statistics fact about the
 * session rather than a mutation of progression.
 */
function fishingStatisticsEvents(input: {
  subjectId: string;
  identity: CatchRewardIdentity;
  xpAwarded: number;
}): readonly StatisticsEvent[] {
  const { localDate, recordedAt } = statisticsStamp();
  return [
    toFishingOutcomeEvent({
      subjectId: input.subjectId,
      identity: {
        catalogId: input.identity.catalogId,
        contextId: input.identity.contextId,
        castNumber: input.identity.castNumber,
        catchIdentity: input.identity.catchIdentity,
      },
      localDate,
      recordedAt,
      xpAwarded: input.xpAwarded,
    }),
    toXpAwardEvent({
      subjectId: input.subjectId,
      source: 'fishing-outcome',
      sourceIdentity: fishingOutcomeEventSourceIdentity({
        catalogId: input.identity.catalogId,
        contextId: input.identity.contextId,
        castNumber: input.identity.castNumber,
        catchIdentity: input.identity.catchIdentity,
      }),
      localDate,
      recordedAt,
      amount: input.xpAwarded,
    }),
  ];
}

/**
 * What a room clear reports when a durable ledger already held it.
 *
 * Named rather than inlined twice, because the two guards that can produce it - the Phase 15
 * clear ledger and the Phase 18 statistics ledger - must not be able to drift into reporting
 * different things. `xpGained: 0` is the load-bearing part: a caller that announces a reward from
 * `xpGained` has nothing to announce.
 *
 * The rank is the record's own, not `Novice`: a suppressed clear changed nothing, so reporting a
 * rank as if it were the default would describe a learner who had earned nothing as a beginner.
 */
function releasedRoomClear(currentRank: RankTier): {
  xpGained: number;
  newRank: RankTier;
  rankChanged: false;
  unlockedBadges: string[];
  loot: null;
  unlockedAchievements: string[];
  awarded: false;
  duplicate: true;
} {
  return {
    xpGained: 0,
    newRank: currentRank,
    rankChanged: false,
    unlockedBadges: [],
    loot: null,
    unlockedAchievements: [],
    awarded: false,
    duplicate: true,
  };
}

/**
 * The room and clear generation a room-clear reward belongs to.
 *
 * Phase 15. Supplied by `encounter/note-submit`, which is the only caller that
 * knows the graph the note was validated against (see
 * `deriveRoomClearIdentity`). Omitting it keeps the pre-Phase-15 behaviour
 * exactly - an unconditional award.
 *
 * ## Phase 18: no longer the only identity the store accepts
 *
 * This type used to be the *only* way to name a clear, which meant the shipping lane - the one
 * `NoteEditorModal` drives, and the only lane the default artifact has - could not say which room
 * it was paying for at all. It therefore recorded no room-clear ledger, no statistics events, no
 * session activity, and no awarded-once guard: a resubmitted valid note paid again, and nothing
 * anywhere counted it.
 *
 * `roomId` is now accepted on its own (see {@link AwardRoomClearRoomId}), and the store derives
 * the weaker per-room identity from it. Both lanes now name the clear, both are guarded, and both
 * record. Omitting *both* keeps the pre-Phase-15 unconditional award, which is what the
 * byte-comparison fixtures' no-identity call shape exercises.
 */
export interface RoomClearRewardIdentity {
  /** The room the learner cleared. */
  roomId: string;
  /** The digest naming which clear of this room, per the caller's derivation rule. */
  clearIdentity: string;
}

/**
 * What `awardRoomClear` reports about the award itself.
 *
 * Additive, so every existing reader of `xpGained` / `loot` /
 * `unlockedBadges` / `unlockedAchievements` is unaffected. `duplicate` is the
 * signal a caller needs in order not to announce a reward that did not happen.
 */
export interface RoomClearRewardOutcome {
  awarded: boolean;
  /** The ledger already held this exact (room, clear generation). */
  duplicate: boolean;
}

/**
 * What `awardReviewPass` reports about the award itself.
 *
 * Phase 16. Additive, so every existing reader of `xpGained` / `newRank` /
 * `unlockedAchievements` is unaffected. `duplicate` is the signal a caller needs
 * in order not to announce a reward that did not happen - and, as with
 * `RoomClearRewardOutcome`, `awarded: false` alone covers more than one cause:
 *
 * - `duplicate: true` - the durable ledger already held this (room, pass).
 * - `duplicate: false, awarded: false` - there was no active subject to pay.
 *
 * A caller that branches on `!awarded` alone will tell a learner a sentence about
 * a repeat when a different cause produced it.
 */
export interface ReviewPassAwardOutcome {
  awarded: boolean;
  duplicate: boolean;
}

/**
 * What `recordCatch` reports about the whole transaction.
 *
 * Phase 17. Additive, so every existing reader of the fishing actions is unaffected.
 * `duplicate` is the signal a caller needs in order not to announce a reward that did
 * not happen, for the same reason as the two outcomes above - and the third cause is
 * unique to fishing:
 *
 * - `duplicate: true` - the durable ledger already held this catch.
 * - `duplicate: false, awarded: false` - the outcome was **declined**, which is
 *   `released` or `answered-incorrect`. Nothing was written, and `reason` says which.
 *
 * A caller that branches on `!awarded` alone will tell a learner a sentence about a
 * repeat when a release produced it.
 */
export interface CatchRecordOutcome {
  awarded: boolean;
  duplicate: boolean;
  xpGained: number;
  /** `null` when nothing was written. */
  newRank: RankTier | null;
  rankChanged: boolean;
  unlockedBadges: string[];
  /** The persisted entry's id, or `null` when nothing was written. */
  fishEntryId: string | null;
  /** Why nothing was written, when nothing was. `null` on an award. */
  declinedReason: CatchDeclinedOutcome | null;
  unlockedAchievements: string[];
}

/**
 * One record write of the interrupted-review marker, or the reward transaction's
 * marker clear.
 *
 * Phase 16. The marker rides in the same preserved app-owned field bag as the
 * room-clear and review-pass ledgers, which is what gives it migration, generation
 * membership, both backup products, and subject-copy ID remapping for free. See
 * `src/core/review/interruptedReviewSession.ts` for the four locations weighed and
 * why the *subject* record's carrier was rejected on evidence rather than taste:
 * `withRooms` rebuilds every snapshot as `{ dungeon, rooms }`, so an unknown
 * top-level key on a subject snapshot would not survive the next room write.
 */
export type ProgressionReviewSessionWrite = InterruptedReviewSessionWrite;

/**
 * Identifier factory for a persisted record that is missing an id.
 *
 * Normalization lives in `src/core/progression/canonicalProgression.ts` and
 * mints no ids of its own, so the `Math.random()` suffix the current store
 * produces stays exactly here. The storage-v2 migration injects a seeded
 * counter instead, which is what makes a migration run reproducible.
 */
function createPersistedId(prefix: 'loot' | 'gear'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A subject with no stored progression gets the default record.
 *
 * The canonical-only fields (`subjectId`, `extraFields`) are absent, so a
 * subject that has never been persisted cannot end up carrying a foreign
 * identity in its record.
 */
function cloneDefaultSubjectProgression(): PersistedSubjectProgression {
  return makeDefaultSubjectProgression();
}

function notesForSubject(notes: readonly CollectedNoteEntry[], subjectId: string): CollectedNoteEntry[] {
  return notes.filter((note) => note.dungeonId === subjectId);
}

/**
 * Hydrate the canonical progression from the current localStorage key.
 *
 * v1 flat, v2 by-subject, and v3 by-subject payloads all normalize through the
 * one function in `src/core/progression/canonicalProgression.ts`. JSON parse
 * failures and non-object payloads still yield empty in-memory state, exactly
 * as before.
 */
/**
 * The one normalizer the store's reads and hydrations both go through.
 *
 * Exported so a test can exercise the resolution rules on a payload without
 * touching the live store, and so the read and the hydration cannot drift: both
 * call this.
 */
export function normalizePersistedProgression(
  raw: unknown,
  activeSubjectId: string | null,
): {
  bySubject: Record<string, PersistedSubjectProgression>;
  crossSubjectAchievements: string[];
} {
  const canonical = normalizeProgressionRecord(raw, {
    activeSubjectId,
    // The same identifier factory the legacy read uses, so a record missing an
    // id hydrates the id it always did.
    createId: createPersistedId,
  });
  return {
    bySubject: canonical.bySubject as unknown as Record<string, PersistedSubjectProgression>,
    crossSubjectAchievements: canonical.crossSubjectAchievements,
  };
}

export function readPersistedProgressionPayload(): {
  version: number;
  bySubject: Record<string, PersistedSubjectProgression>;
  crossSubjectAchievements: string[];
} {
  const empty = { version: CANONICAL_PROGRESSION_VERSION, bySubject: {}, crossSubjectAchievements: [] };
  try {
    if (typeof localStorage === 'undefined') return empty;
    const raw = localStorage.getItem(STORAGE_KEYS.progression);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return empty;

    // The version travels with the payload so hydrating it is idempotent: a
    // canonical envelope handed back to the normalizer is recognised as the
    // by-subject shape instead of being read as an unversioned v1 flat record.
    return {
      version: CANONICAL_PROGRESSION_VERSION,
      ...normalizePersistedProgression(parsed, getActiveSubjectId()),
    };
  } catch {
    return empty;
  }
}

/**
 * Persist to the legacy `localStorage` key.
 *
 * This writes the **legacy v3 mirror format**, deliberately not the storage-v2
 * canonical format. Phase 3 is not a storage cutover, and Phase 4 - not this
 * phase - owns the mirror/dual-write contract, so the payload must stay exactly
 * what the pre-phase build wrote: three envelope keys, thirteen record keys in
 * the same order, and no canonical-only field. That is what makes Phase 3's
 * rollback (revert the source) a no-op for data.
 *
 * Preserved unknown app-owned fields are flattened into their record, which is
 * an additive superset the pre-phase reader ignores. Storage-v2 output uses
 * `canonicalProgressionToRecord` / `serializeCanonicalProgression` instead.
 */
function savePersistedBySubject(
  bySubject: Record<string, PersistedSubjectProgression>,
  crossSubjectAchievements: string[],
): void {
  // The legacy mirror keeps exactly the pre-phase payload, so a rollback build
  // reads what it always read.
  let payload: string;
  try {
    payload =
      typeof localStorage === 'undefined'
        ? ''
        : JSON.stringify(toLegacyV3ProgressionRecord({ bySubject, crossSubjectAchievements }));
  } catch {
    return;
  }

  const repository = currentStorageV2Repository();
  if (repository === null) {
    if (payload !== '') writeProgressionMirror(payload);
    return;
  }
  // Storage-v2 is the primary repository, so the generation is written first and
  // the legacy key is the rollback mirror. The mirror runs only after the primary
  // succeeded, so a failed write can never leave the legacy key ahead of the
  // generation. A mirror failure is recorded and reported, and never fails the
  // write the learner asked for.
  //
  // The generation write is asynchronous: a store action cannot await. The
  // canonical envelope is the *whole* progression state, not one subject's slice,
  // so the whole `bySubject` map is published and a replayed write is idempotent.
  writeThroughInBackground({
    operation: 'progression',
    primary: () =>
      import('@/services/persistence/v2/appRepository').then((records) =>
        records.publishProgressionToActiveGeneration(
          repository,
          // The version is stamped here as well as inside the writer. That is
          // deliberate redundancy, not an accident: the writer stamps it because
          // its parameter is `unknown` and only it can guarantee the shape, and
          // this call site stamps it because the payload really is the current
          // shape and saying so here is what keeps the two from ever disagreeing
          // about the contract. Omitting it here would still be correct; having it
          // here is what documents the intent at the call site.
          { version: CANONICAL_PROGRESSION_VERSION, bySubject, crossSubjectAchievements },
          new Date().toISOString(),
        ),
      ),
    mirror: () => writeProgressionMirror(payload),
  });
}

/** Write the legacy mirror. Returns `false` when the storage refused it. */
function writeProgressionMirror(payload: string): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.progression, payload);
    }
    return true;
  } catch {
    // A quota or privacy-mode failure is a mirror failure, and `writeThrough`
    // records it rather than letting the learner's write be reported as lost.
    return false;
  }
}

function getSubjectProgression(
  bySubject: Record<string, PersistedSubjectProgression>,
  subjectId: string | null,
): PersistedSubjectProgression {
  if (!subjectId) return cloneDefaultSubjectProgression();
  const current = bySubject[subjectId] ?? cloneDefaultSubjectProgression();
  return {
    ...current,
    collectedNotes: notesForSubject(current.collectedNotes, subjectId),
  };
}

const LOOT_POOL: Omit<LootItem, 'id' | 'acquiredAt'>[] = [
  {
    name: 'Inkwell of Insight',
    description: 'A small ceramic inkwell that hums when a recall question is well-formed.',
    rarity: 'common',
  },
  {
    name: 'Cartographer’s Compass',
    description: 'Points toward the next unresolved room in your subject graph.',
    rarity: 'rare',
  },
  {
    name: 'Tome of Cross-References',
    description: 'A worn volume whose pages refuse to stay closed until you write a link.',
    rarity: 'epic',
  },
];

export interface ProgressionStoreState {
  activeSubjectId: string | null;
  /**
   * Apply a hydrated progression payload. Called once by the application
   * bootstrap, before the first render, with whatever the selected repository
   * produced. `null` resets to the documented defaults, which is what a device
   * with no stored progression hydrates to.
   *
   * The payload is normalized here, not trusted. A storage-v2 generation and a
   * legacy key reach this function as different documents of the same state, so
   * the one normalizer is what makes the two repositories hydrate the same
   * in-memory value instead of two shapes that happen to hold the same numbers.
   */
  hydrateProgression: (persisted: unknown) => void;
  bySubject: Record<string, PersistedSubjectProgression>;
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: LootItem[];
  equippedItems: EquippableLootItem[];
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
  /** Phase 3c: per-subject extended stats exposed at top level */
  subjectsMastered: number;
  roomsCleared: number;
  reviewPasses: number;
  artifacts: number;
  bossesDefeated: number;
  /** Phase 3c: cross-subject achievements */
  crossSubjectAchievements: string[];
  /** Fisher's Rest: fish caught in the active subject */
  fishCollection: FishEntry[];
  setActiveSubject: (subjectId: string | null) => void;
  awardBadge: (badgeId: string) => boolean;
  collectArtifactNote: (entry: Omit<CollectedNoteEntry, 'noteId' | 'collectedAt'>) => boolean;
  awardRoomClear: (input: {
    qualityBonus: number;
    totalRooms: number;
    creatorMappedRooms: number;
    scribeClearedRooms: number;
    archaeologistFullReviewPasses: number;
    /** Track 3c: is this a boss encounter? */
    isBossEncounter?: boolean;
    /** Track 3c: boss loot rarity minimum */
    bossMinLootRarity?: 'rare' | 'epic';
    /**
     * Phase 15: which (room, clear generation) this reward is for.
     *
     * Present makes the award idempotent for that identity, and carries the Phase 15
     * room-clear ledger. Absent, but with `roomId` present, the weaker per-room identity applies.
     * Absent with no `roomId` either, the pre-Phase-15 unconditional award is preserved.
     */
    clear?: RoomClearRewardIdentity;
    /**
     * Phase 18: which room this reward is for, for a lane that has no clear identity.
     *
     * This is what the **default production artifact** supplies: `NoteEditorModal` knows the room
     * it submitted for and does not derive a graph digest. Naming the room is what lets this
     * action record the note submission and its XP as statistics, and - because the statistics
     * ledger is the awarded-once ledger - what stops a resubmitted valid note paying twice.
     *
     * Ignored when `clear` is present: `clear` already names the room, and a caller that
     * contradicted it would get an identity it did not mean.
     */
    roomId?: string;
  }) => {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
    unlockedBadges: string[];
    loot: LootItem | null;
    /** Track 3c: newly unlocked cross-subject achievements */
    unlockedAchievements: string[];
    /** Phase 15: whether this call awarded anything. */
    awarded: boolean;
    /** Phase 15: whether this call was suppressed as a repeat of an awarded clear. */
    duplicate: boolean;
  };
  /**
   * Award a review pass, consulting and writing the durable (room, pass) ledger in
   * the **same `set` of one record** as the XP, the rank, the `reviewPasses`
   * increment, and the interrupted-review marker for that room.
   *
   * Phase 16. The identity is **required by the command layer and optional here**.
   * Omitting it preserves the pre-Phase-16 behaviour exactly - an unconditional
   * award - and that carve-out is deliberate, because two lanes still depend on
   * it:
   *
   * - `NoteEditorModal`'s note-submit path passes no identity, and the Phase 15
   *   rollback keeps using it.
   * - `tests/phase15/**` and `tests/unit/roomClearRewards.test.ts` pin the
   *   no-identity answer.
   *
   * Without the carve-out, extending the action would break both lanes and take
   * the documented rollback with them. With it, the command layer is the only
   * production caller that supplies an identity, and every *new* review award is
   * therefore durable.
   */
  awardReviewPass: (review?: ReviewPassRewardIdentity) => {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
    unlockedAchievements: string[];
    /** Phase 16: whether this call awarded anything. */
    awarded: boolean;
    /** Phase 16: whether this call was suppressed as a repeat of an awarded pass. */
    duplicate: boolean;
  };
  /**
   * Phase 16: read the active subject record's preserved app-owned fields.
   *
   * Exposed so the review command layer can decide from one read what is already
   * durable - the ledger and the interrupted-review marker - before writing one
   * record. It returns `undefined` when there is no active subject, which every
   * preserved-field reader treats as "nothing preserved".
   */
  readProgressionPreservedFields: () => Record<string, unknown> | undefined;
  /**
   * Phase 16: write or drop the interrupted-review marker in one record write.
   *
   * No reward and no SM-2 state: this is the marker only. Used by
   * `review/session-save` and `review/session-discard`, and idempotent, because a
   * `save` of the same marker is the same record.
   */
  writeReviewSession: (write: ProgressionReviewSessionWrite) => void;
  /**
   * Fisher's Rest: add a caught fish to the active subject's collection.
   *
   * **Phase 17 carve-out, deliberately unchanged.** This action, `awardFishingXp`,
   * and `checkFishingBadges` are the *pre-Phase-17* chain. They are kept working
   * exactly as they were, and the reason has changed during the phase:
   *
   * - At `ade1f78` their only production caller was `VillageScreen.handleKeepFish`,
   *   reached through the Phase 15 rollback lane (`VITE_PIXI_FISHING=false`).
   * - **`handleKeepFish` no longer exists.** Phase 17 moved the catch transaction to
   *   `src/ui/fishing/fishingSession.ts`, which commits through `recordCatch` below
   *   as one deduplicated command. That is true on **both** lanes: the DOM calls
   *   `recordCatch` whether the pond is the Pixi world or the Phaser `FishingScene`,
   *   so the rollback lane is not a second code path any more - there is one.
   * - `grep -rn "addFish\|awardFishingXp\|checkFishingBadges" src/ tests/` now finds
   *   **no production caller** of these three store actions. The remaining hits are
   *   `fishCollectionService`'s own `addFishToCollection` (a different, pure function
   *   in `src/core/fishing/`), the Phaser and Pixi renderers' private
   *   `addFishToBucket` (a scene-graph bucket, not a collection write), and this note.
   *
   * So they are kept because **removing them is a separate decision**, not because
   * anything still needs them. Two of the three carry defects `recordCatch` fixes:
   *
   * - The id prefix is derived from the **display name**
   *   (`name.toLowerCase().replace(/\s+/g, '-')`) rather than the catalogue id, and
   *   `catalogId` is never set, so `resolveFishCatalogId` falls through its
   *   `entry-id-prefix` branch to `catalog-name-match`. That works today only because
   *   every catalogue name slugs to its own id - a coincidence between
   *   `fishingTypes.ts` and `fishCollectionService.ts`, not a contract. `recordCatch`
   *   builds the id from the catalogue id and sets `catalogId` explicitly.
   * - `awardFishingXp` has **no idempotency guard at all**, so a double dispatch pays
   *   twice. `recordCatch` consults the durable ledger in the same record write as
   *   the reward.
   *
   * Neither defect is reachable from any caller, which is exactly why neither is
   * fixed here: a repair with no caller is a change nobody can observe. A follow-up
   * should either delete all three or keep them with this note, and should say which.
   * `fishingCommandStoreBinding.test.ts` asserts the unguarded `awardFishingXp` **as
   * the defect**, so a future guard has to update that test and its stated reason.
   */
  addFish: (input: { name: string; rarity: FishEntry['rarity']; subjectId: string; subjectName: string }) => FishEntry;
  /**
   * Fisher's Rest: award XP for a fishing recall answer.
   *
   * **Unguarded, and unchanged.** Phase 17 carve-out; see `addFish`. The new path
   * pays XP through `recordCatch`, which consults the durable ledger first.
   */
  awardFishingXp: (rarity: FishRarity) => { xpGained: number; newRank: RankTier; rankChanged: boolean };
  /**
   * Fisher's Rest: check and award fishing badges from the current collection.
   *
   * **Unchanged, including its separate `set` per badge and its name-based unique
   * count.** Phase 17 carve-out; see `addFish`. `recordCatch` computes the same badges
   * from `evaluateFishingBadgeUnlocks`, which counts **canonical catalogue ids** and
   * returns them for one combined write.
   */
  checkFishingBadges: () => FishingBadgeId[];
  /**
   * Phase 17: the whole catch transaction, in **one `set` of one record**.
   *
   * The fish entry, the XP, the rank, the fishing badge unlocks, and the durable
   * catch-reward ledger entry land together, so there is no partial-reward window: a
   * failed write persists the reward *and* its guard together or neither, and a retry
   * can never find a fish whose ledger entry is missing. See
   * `src/core/fishing/catchRewards.ts` for the identity and the argument.
   *
   * **`subjectId` is a parameter, not `activeSubjectId`.** That is the fix for plan
   * 5.3's "fishing eligibility, recall selection, and persistence may use different
   * subject contexts": the three steps that read `activeSubjectId`, the village
   * layout's nearest portal slot, and `Object.keys(bySubject)[n - 1]` all disagreed,
   * and an action that could only pay the *active* subject could not honour a session
   * whose subject had since changed. The top-level flat mirror fields are updated
   * **only** when the written subject is the active one, so writing a catch for a
   * non-active subject cannot corrupt the header a panel reads.
   *
   * **A declined outcome writes nothing at all.** `released` and `answered-incorrect`
   * return before any `set`, which is what makes "release and failed recall do not
   * mutate progression" true by construction rather than by convention.
   */
  recordCatch: (input: {
    /** The subject the catch belongs to. App-minted. */
    subjectId: string;
    /** Which (session, species, cast) this is. */
    identity: CatchRewardIdentity;
    outcome: CatchOutcome | CatchDeclinedOutcome;
    /** The catalogue entry that was caught. */
    catalogEntry: FishCatalogEntry;
    /** The subject's display name, for the persisted entry's record text. */
    subjectName: string;
    /** The app-minted recall room id, or `null`. Never a topic. */
    recallRoomId: string | null;
  }) => CatchRecordOutcome;
  /** Track 3c: equip an equippable item */
  equipItem: (itemId: string) => boolean;
  /** Track 3c: unequip an item */
  unequipItem: (itemId: string) => boolean;
  /** Track 3c: compute bonuses from currently equipped items */
  getEquipBonuses: () => { qualityBonus: number; xpMultiplier: number; xpBonus: number; streakBonus: number };
  /** Track 3c: get cross-subject progress */
  getCrossSubjectProgress: () => CrossSubjectProgress;
  /** Track 3c: check for new cross-subject achievements */
  checkCrossSubjectAchievements: () => string[];
  resetStreak: () => void;
  reset: () => void;
}

const { bySubject: initialBySubject, crossSubjectAchievements: initialCrossSubjectAchs } =
  readPersistedProgressionPayload();
const initialActiveSubject = getActiveSubjectId();
const initialSubjectId =
  initialActiveSubject && initialActiveSubject.trim().length > 0
    ? initialActiveSubject
    : Object.keys(initialBySubject)[0] ?? null;
const initialSubjectProgression = getSubjectProgression(initialBySubject, initialSubjectId);

export const useProgressionStore = create<ProgressionStoreState>((set, get) => ({
  activeSubjectId: initialSubjectId,
  bySubject: initialBySubject,
  crossSubjectAchievements: initialCrossSubjectAchs,
  ...initialSubjectProgression,

  hydrateProgression(persisted) {
    // `null` means nothing is stored, or the read failed. It must hydrate to the
    // documented empty state, not to a v1 flat record: the normalizer files an
    // unversioned payload under a bucket, and inventing a zeroed record for a
    // device that simply has no progression would show a learner a subject that
    // is not there.
    if (persisted === null || persisted === undefined) {
      set({
        activeSubjectId: get().activeSubjectId,
        bySubject: {},
        crossSubjectAchievements: [],
        ...getSubjectProgression({}, get().activeSubjectId),
      });
      return;
    }
    // The active subject is resolved here, not read afterwards: an unversioned v1
    // flat payload is *routed* by it, and the top-level totals are the active
    // subject's. Hydrating before the subject is known would file a learner's
    // whole history under `__legacy__` and show them zero XP, which is what the
    // module-load initialization this replaces never did.
    const stored = getActiveSubjectId();
    const activeSubjectId = get().activeSubjectId ?? (stored && stored.trim().length > 0 ? stored : null);
    const { bySubject, crossSubjectAchievements } = normalizePersistedProgression(
      persisted,
      activeSubjectId,
    );
    set({
      activeSubjectId,
      bySubject,
      crossSubjectAchievements,
      ...getSubjectProgression(bySubject, activeSubjectId),
    });
  },

  setActiveSubject(subjectId) {
    const normalizedSubjectId = subjectId && subjectId.trim().length > 0 ? subjectId : null;
    const state = get();
    if (normalizedSubjectId === null) {
      set({
        activeSubjectId: null,
        ...cloneDefaultSubjectProgression(),
      });
      return;
    }

    const current = state.bySubject[normalizedSubjectId] ?? cloneDefaultSubjectProgression();
    const bySubject = state.bySubject[normalizedSubjectId]
      ? state.bySubject
      : { ...state.bySubject, [normalizedSubjectId]: current };

    set({
      activeSubjectId: normalizedSubjectId,
      bySubject,
      ...current,
    });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
  },

  awardBadge(badgeId) {
    const normalized = badgeId.trim();
    if (normalized.length === 0) return false;
    const state = get();
    if (!state.activeSubjectId) return false;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    if (current.badges.includes(normalized)) return false;

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      badges: [...current.badges, normalized],
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return true;
  },

  collectArtifactNote(entry) {
    const state = get();
    if (!state.activeSubjectId) return false;
    if (entry.dungeonId !== state.activeSubjectId) return false;
    const normalizedRoom = entry.roomId.trim();
    const normalizedDungeon = entry.dungeonId.trim();
    if (normalizedRoom.length === 0 || normalizedDungeon.length === 0) return false;

    const noteId = `${normalizedDungeon}:${normalizedRoom}`;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    if (current.collectedNotes.some((note) => note.noteId === noteId)) return false;

    const collectedAt = new Date().toISOString();
    const nextEntry: CollectedNoteEntry = {
      ...entry,
      noteId,
      collectedAt,
    };

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      collectedNotes: [nextEntry, ...current.collectedNotes],
      artifacts: current.artifacts + 1,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    // Check cross-subject achievements
    const newAchs = get().checkCrossSubjectAchievements();
    if (newAchs.length > 0) {
      return true;
    }
    return true;
  },

  // ── Fisher's Rest: addFish ──────────────────────────

  addFish({ name, rarity, subjectId, subjectName }) {
    const state = get();
    if (!state.activeSubjectId) {
      // If no active subject, still return a valid entry but don't persist
      return {
        id: createFishId('unknown'),
        name,
        rarity,
        subjectId,
        subjectName,
        caughtAt: new Date().toISOString(),
      };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const entry: FishEntry = {
      id: createFishId(name.toLowerCase().replace(/\s+/g, '-')),
      name,
      rarity,
      subjectId,
      subjectName,
      caughtAt: new Date().toISOString(),
    };

    const updatedCollection = addFishToCollection(current.fishCollection, entry);
    const nextSubject: PersistedSubjectProgression = {
      ...current,
      fishCollection: updatedCollection,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return entry;
  },

  // ── Fisher's Rest: awardFishingXp ─────────────────

  awardFishingXp(rarity) {
    const state = get();
    if (!state.activeSubjectId) {
      return { xpGained: 0, newRank: 'Novice' as RankTier, rankChanged: false };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const multiplier = FISH_RARITY_XP_MULTIPLIER[rarity] ?? 1.0;
    const xpGained = Math.round(FSH_XP_PER_CORRECT_ANSWER * multiplier);
    const nextXp = current.xpTotal + xpGained;
    const nextRank = assignRankTier(nextXp);

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      xpTotal: nextXp,
      rank: nextRank,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    return {
      xpGained,
      newRank: nextRank,
      rankChanged: nextRank !== current.rank,
    };
  },

  // ── Fisher's Rest: checkFishingBadges ──────────────

  checkFishingBadges() {
    const state = get();
    if (!state.activeSubjectId) return [];

    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const collection: FishCollection = current.fishCollection;
    const totalFish = collection.length;
    const uniqueCount = countUniqueTypes(collection);
    const existingBadges = new Set(current.badges);
    const newlyAwarded: FishingBadgeId[] = [];

    for (const badgeId of FISHING_BADGE_IDS) {
      if (existingBadges.has(badgeId)) continue;

      const def = FISHING_BADGE_DEFS[badgeId];
      let earned = false;

      if (badgeId === 'FshFullCreel') {
        // -1 threshold means all unique fish types caught
        earned = uniqueCount >= FISH_CATALOG.length;
      } else {
        earned = totalFish >= def.threshold;
      }

      if (earned) {
        const awarded = get().awardBadge(badgeId);
        if (awarded) {
          newlyAwarded.push(badgeId);
        }
      }
    }

    return newlyAwarded;
  },

  // ── Fisher's Rest: recordCatch (Phase 17, the whole transaction) ───────────
  //
  // The replacement for the `addFish` -> `awardFishingXp` -> `checkFishingBadges`
  // chain, which **no production caller uses any more.** Those three actions are
  // unchanged; see the carve-out note on `addFish`. `recordCatch` is the only
  // production caller of `decideCatchReward`, and it is the catch transaction on
  // both lanes.

  recordCatch(input) {
    const { subjectId, identity, outcome, catalogEntry, subjectName, recallRoomId } = input;
    const policy = CATCH_OUTCOME_POLICY[outcome];
    const declined = (reason: CatchDeclinedOutcome): CatchRecordOutcome => ({
      awarded: false,
      duplicate: false,
      xpGained: 0,
      newRank: null,
      rankChanged: false,
      unlockedBadges: [],
      fishEntryId: null,
      declinedReason: reason,
      unlockedAchievements: [],
    });

    // A declined outcome writes nothing at all: no `set`, no save, no `Math.random`.
    // This is the whole of "release and failed recall do not mutate progression",
    // and it is a real early return rather than a `set` of an unchanged record,
    // which would still have re-persisted the record and re-written the mirror.
    if (!policy.mutatesProgression) {
      return declined(outcome as CatchDeclinedOutcome);
    }

    const normalizedSubjectId = subjectId.trim();
    if (normalizedSubjectId.length === 0) {
      // A catch with no subject cannot be recorded against one, and the old chain's
      // `addFish` wrote to `activeSubjectId` regardless - the exact mismatch this
      // action removes. Refuse rather than guess.
      return declined('released');
    }

    const state = get();
    const current = getSubjectProgression(state.bySubject, normalizedSubjectId);

    // Phase 17: the durable awarded-once check, taken *before* any id is minted so a
    // suppressed catch burns no `Math.random` and performs no write at all. The
    // decision is a single pure value and it lands in the same `set` below as the
    // fish entry, the XP, the rank, and the badges - so a failed write leaves the
    // reward and its guard in the same state, never one without the other, and two
    // calls in one tick cannot both decide to award.
    //
    // The clock and the id suffix are injected here rather than read inside
    // `createFishId`, so a test gets a reproducible entry id. The *format* is
    // `createFishId`'s, so an entry written here is indistinguishable in shape from
    // one written by `addFish` and `resolveFishCatalogId`'s `entry-id-prefix` branch
    // keeps resolving every pre-Phase-17 entry.
    const nowMs = Date.now();
    const decision = decideCatchReward({
      extraFields: current.extraFields,
      identity,
      outcome,
      xpTotal: current.xpTotal,
      rank: current.rank,
      collection: current.fishCollection,
      heldBadges: current.badges,
      fishEntry: createCanonicalFishEntry({
        catalogEntry,
        subjectId: normalizedSubjectId,
        subjectName,
        caughtAt: new Date(nowMs).toISOString(),
        entrySuffix: createFishEntrySuffix(nowMs, Math.random()),
      }),
      awardedAt: new Date(nowMs).toISOString(),
    });

    if (decision.outcome === 'already-awarded') {
      return {
        awarded: false,
        duplicate: true,
        xpGained: 0,
        newRank: null,
        rankChanged: false,
        unlockedBadges: [],
        fishEntryId: null,
        declinedReason: null,
        unlockedAchievements: [],
      };
    }
    if (decision.outcome === 'declined') {
      return declined(decision.declinedOutcome);
    }

    if (decision.fishEntry === null) {
      // Only reachable if `createCanonicalFishEntry` produced `null`, which it cannot
      // do - its four inputs are all required and it returns an object. Guarded
      // anyway so a future edit to the decision cannot write `null` into a collection
      // whose type says `FishEntry`.
      return declined('released');
    }

    // The ledger carries the room the recall came from, so Phase 17's local
    // "navigation back to the relevant room" and Phase 18's statistics have a
    // subject-scoped handle without re-deriving one from learner material. It is
    // deliberately **not** part of the digest.
    const withRoom = withRecallRoom({ ...decision, fishEntry: decision.fishEntry }, recallRoomId);
    const extraFields = writeCatchRewardLedgerToFields(
      // Phase 18: the kept catch and its XP join the same record write, under the same
      // `(context, species, cast)` identity the award already uses. Only an awarded catch
      // reaches this line - a declined outcome returned before any `set` - so a release and
      // a wrong recall still write nothing at all, here and everywhere else.
      writeStatisticsEventsToFields(
        current.extraFields,
        fishingStatisticsEvents({
          subjectId: normalizedSubjectId,
          identity: input.identity,
          xpAwarded: withRoom.xpAwarded,
        }),
      ),
      withRoom.ledger,
    );

    // ONE record, ONE `set`. Fish entry, XP, rank, badges, and the ledger entry
    // move together or not at all.
    const nextSubject: PersistedSubjectProgression = {
      ...current,
      fishCollection: [withRoom.fishEntry, ...current.fishCollection],
      xpTotal: withRoom.nextXpTotal,
      rank: withRoom.rank,
      badges: [...current.badges, ...withRoom.badgesUnlocked],
      extraFields,
    };
    const bySubject = { ...state.bySubject, [normalizedSubjectId]: nextSubject };

    // The flat top-level fields mirror the **active** subject only. A catch written
    // for another subject must not overwrite the header a panel reads, which is why
    // this is conditional where the three Phase 15/16 writes were not: those could
    // only ever write the active subject.
    set(
      state.activeSubjectId === normalizedSubjectId
        ? { bySubject, ...nextSubject }
        : { bySubject },
    );
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    // Phase 18: the session record's display counters, after the record write. Only an
    // awarded catch reaches this line, so a declined outcome reports nothing: Phase 17's
    // invariant is that a release and a wrong recall write nothing at all, and a
    // session-side counter is a write. A declined cast's absence from the statistics is the
    // correct record - "no catch was kept" is exactly what it means.
    emitStatisticsActivity({
      kind: 'fishing-outcome',
      catalogId: input.identity.catalogId,
      castNumber: input.identity.castNumber,
      xpAwarded: withRoom.xpAwarded,
      awarded: true,
    });

    // Cross-subject achievements are a **separate** `set` per achievement and are not
    // in this transaction, exactly as after `awardRoomClear` and `awardReviewPass`.
    // They are already idempotent (`awardBadge` returns `false` for a held badge), so
    // the exposure is a lag rather than a double count.
    const unlockedAchievements = get().checkCrossSubjectAchievements();

    return {
      awarded: true,
      duplicate: false,
      xpGained: withRoom.xpAwarded,
      newRank: withRoom.rank,
      rankChanged: withRoom.rankChanged,
      unlockedBadges: [...withRoom.badgesUnlocked],
      fishEntryId: withRoom.fishEntry.id,
      declinedReason: null,
      unlockedAchievements,
    };
  },

  awardRoomClear({
    qualityBonus,
    totalRooms,
    creatorMappedRooms,
    scribeClearedRooms,
    archaeologistFullReviewPasses,
    isBossEncounter = false,
    bossMinLootRarity,
    clear,
    roomId,
  }) {
    const state = get();
    if (!state.activeSubjectId) {
      return {
        xpGained: 0,
        newRank: 'Novice' as RankTier,
        rankChanged: false,
        unlockedBadges: [] as string[],
        loot: null as LootItem | null,
        unlockedAchievements: [] as string[],
        awarded: false,
        duplicate: false,
      };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const subjectId = state.activeSubjectId;

    // Phase 18: one identity per lane, resolved before anything is paid, and `null` whenever the
    // caller named no usable room.
    //
    // - `clear` present: the Phase 15 per-graph-generation digest, unchanged, and the better rule.
    // - `roomId` alone: the default artifact's lane. `deriveNoteSubmissionSourceIdentity` mints the
    //   weaker per-room digest from the only fact that lane has. Deriving it *here* rather than in
    //   the modal is the point: one implementation, so the two lanes cannot drift into minting
    //   different digests for one submission, which would pay twice and look like nothing.
    // - neither, **or a `roomId` that names no room**: the pre-Phase-15 unconditional award,
    //   preserved for the no-identity call shape that the byte-comparison fixtures and
    //   `tests/phase15/**` depend on.
    //
    // A blank or whitespace-only `roomId` is the second case, not the first, because it is the
    // absence of a room wearing a value's clothing: `''` and `'   '` are distinct strings, so
    // minting an identity for each produced two counted, paid submissions for one room that does
    // not exist. `undefined` already took the uncounted lane; a blank id now takes the same one, so
    // the fallback's contract stays "one lane, one behaviour" instead of growing a third answer that
    // depends on which flavour of "no room" the caller used.
    let submissionIdentity: NoteSubmissionEventIdentity | null = null;
    if (clear !== undefined) {
      submissionIdentity = { roomId: clear.roomId, clearIdentity: clear.clearIdentity };
    } else if (roomId !== undefined) {
      const sourceIdentity = deriveNoteSubmissionSourceIdentity({ roomId });
      submissionIdentity = sourceIdentity === null ? null : { roomId, clearIdentity: sourceIdentity };
    }

    // Phase 15: the durable awarded-once check, taken *before* any reward is
    // computed so a suppressed clear rolls no loot, burns no `Math.random`, and
    // performs no write at all. The decision and the ledger it produces are one
    // pure value, and both land in the single `set` below together with XP,
    // loot, badges, and `roomsCleared` - so a failed write leaves the reward and
    // its guard in the same state, never one without the other.
    let decision: RoomClearRewardDecision | null = null;
    if (clear) {
      decision = decideRoomClearReward({
        extraFields: current.extraFields,
        roomId: clear.roomId,
        clearIdentity: clear.clearIdentity,
        awardedAt: new Date().toISOString(),
      });
      if (decision.outcome === 'already-awarded') {
        return releasedRoomClear(current.rank);
      }
    }

    // Phase 18: the awarded-once check for **every** lane, including the one with no Phase 15
    // clear ledger. Taken before the reward for the same reason as the check above, and against
    // the same read of `extraFields`, so the two guards cannot disagree about one call.
    //
    // This is the guard the shipping lane never had. Without it, supplying `roomId` would have
    // recorded the submission twice and paid twice - the statistics fix would have re-opened
    // plan §5.3's duplicate-reward defect on the default artifact.
    const submissionDecision =
      submissionIdentity === null
        ? null
        : decideNoteSubmission({
            extraFields: current.extraFields,
            subjectId,
            identity: submissionIdentity,
          });
    if (submissionDecision?.outcome === 'already-recorded') {
      return releasedRoomClear(current.rank);
    }

    // Compute equip bonuses
    const equipBonuses = computeEquipBonuses(current.equippedItems ?? []);
    const effectiveQualityBonus = qualityBonus + equipBonuses.qualityBonus + current.streakCount;

    const nextStreak = current.streakCount + 1 + equipBonuses.streakBonus;
    const result = awardRoomClearProgression({
      currentXpTotal: current.xpTotal,
      existingBadges: current.badges,
      qualityBonus: effectiveQualityBonus,
      streakCount: nextStreak,
      badgeProgress: {
        totalRooms,
        creatorMappedRooms,
        scribeClearedRooms,
        archaeologistFullReviewPasses,
      },
    });

    if (!result.ok) {
      return {
        xpGained: 0,
        newRank: current.rank,
        rankChanged: false,
        unlockedBadges: [],
        loot: null,
        unlockedAchievements: [],
        awarded: false,
        duplicate: false,
      };
    }

    const value = result.value;

    // Roll for equippable loot (preferred) or legacy loot
    let loot: LootItem | null = null;
    if (isBossEncounter || qualityBonus >= 4) {
      loot = rollEquippableLoot(qualityBonus, bossMinLootRarity);
    }
    if (!loot) {
      loot = rollLoot(qualityBonus);
    }

    const inventory = loot ? [...current.inventory, loot] : current.inventory;
    const roomsCleared = current.roomsCleared + 1;
    const bossesDefeated = isBossEncounter ? current.bossesDefeated + 1 : current.bossesDefeated;

    // Phase 15: the ledger rides in the record's preserved app-owned fields, so
    // it reaches the legacy mirror (the shipping repository), the storage-v2
    // generation, and both backup products through the machinery that already
    // exists. Carrying `extraFields` forward unconditionally is also a preservation
    // fix: this action previously rebuilt the record field by field and dropped
    // every preserved unknown app-owned field on every room clear.
    const clearFields =
      decision === null
        ? current.extraFields
        : writeRoomClearRewardLedgerToFields(current.extraFields, decision.ledger);

    // Phase 18: the note and its XP are recorded as counted-once statistics events in the
    // **same record write** as the reward, under the same identity the award was decided
    // against. That is what makes "one clear paid" and "one note counted" the same fact
    // rather than two counters kept in step by hand - and it is why a suppressed clear records
    // nothing: both early returns above happen before this line.
    //
    // **Every lane that named a room.** Phase 18 shipped this restricted to `clear`, on the
    // reasoning that the no-identity lane should keep gaining no `extraFields` key. That
    // protected a fixture from recording the fact that the *shipping* artifact recorded nothing:
    // a completed note on the default build left `notesSubmitted: 0`, `xpEarned: 0`, and no
    // statistics ledger at all. A lane that records nothing is a worse defect than a lane whose
    // record shape changed, so the record shape changed. Only a caller that named **no room** -
    // the byte-comparison fixtures' call shape - still gains no key.
    const statisticsFields =
      submissionIdentity === null
        ? clearFields
        : writeStatisticsEventsToFields(clearFields, noteStatisticsEvents({
          subjectId,
          identity: submissionIdentity,
          xpAwarded: value.xpBreakdown.totalDelta,
        }));

    const nextSubject: PersistedSubjectProgression = {
      xpTotal: value.xpTotalAfter,
      rank: value.rankAfter,
      badges: value.progressionSnapshot.badges,
      inventory,
      equippedItems: current.equippedItems ?? [],
      collectedNotes: current.collectedNotes,
      streakCount: nextStreak,
      subjectsMastered: current.subjectsMastered,
      roomsCleared,
      reviewPasses: current.reviewPasses,
      artifacts: current.artifacts,
      bossesDefeated,
      fishCollection: current.fishCollection,
      ...(statisticsFields !== undefined ? { extraFields: statisticsFields } : {}),
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    // Phase 18: the session record's own display counters. Emitted **after** the record
    // write, because they live on a different record and a failure here must not roll back
    // a reward the learner earned. Emitted for every awarded clear that named a room, which
    // is what makes the shipping lane's session record non-zero; the durable statistics ledger
    // above already guarantees it happens once per identity.
    if (submissionIdentity !== null) {
      emitStatisticsActivity({
        kind: 'note-submission',
        roomId: submissionIdentity.roomId,
        xpAwarded: value.xpBreakdown.totalDelta,
      });
    }

    // Check cross-subject achievements
    const unlockedAchievements = get().checkCrossSubjectAchievements();

    return {
      xpGained: value.xpBreakdown.totalDelta,
      newRank: value.rankAfter,
      rankChanged: value.rankBefore !== value.rankAfter,
      unlockedBadges: value.unlockedBadges,
      loot,
      unlockedAchievements,
      awarded: true,
      duplicate: false,
    };
  },

  awardReviewPass(review) {
    const state = get();
    if (!state.activeSubjectId) {
      return {
        xpGained: 0,
        newRank: 'Novice' as RankTier,
        rankChanged: false,
        unlockedAchievements: [] as string[],
        awarded: false,
        duplicate: false,
      };
    }

    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);

    // Phase 16: the durable awarded-once check, taken *before* any reward is
    // computed so a suppressed pass burns no `Math.random`, performs no write, and
    // leaves `xpTotal` byte-identical. The decision is a single pure value and it
    // lands in the same `set` below as the XP, the rank, the `reviewPasses`
    // increment, and the marker clear - so a failed write leaves the reward and
    // its guard in the same state, never one without the other, and two calls in
    // one tick cannot both decide to award.
    let decision: ReviewPassRewardDecision | null = null;
    if (review) {
      decision = decideReviewPassReward({
        extraFields: current.extraFields,
        roomId: review.roomId,
        passNumber: review.passNumber,
        awardedAt: new Date().toISOString(),
      });
      if (decision.outcome === 'already-awarded') {
        return {
          xpGained: 0,
          newRank: current.rank,
          rankChanged: false,
          unlockedAchievements: [],
          awarded: false,
          duplicate: true,
        };
      }
    }

    const equipBonuses = computeEquipBonuses(current.equippedItems ?? []);
    const xpEarned = REVIEW_PASS_XP + equipBonuses.xpBonus;
    const nextXp = current.xpTotal + xpEarned;
    const nextRank = assignRankTier(nextXp);

    // The marker for *this* room clears in the same record write as the award, so
    // a finished review is never left resumable. A marker for another room is
    // untouched - `applyInterruptedReviewSessionWrite` is a no-op for a discard
    // that names a different room.
    let extraFields = current.extraFields;
    if (decision !== null && review) {
      extraFields = writeReviewPassRewardLedgerToFields(extraFields, decision.ledger);
      extraFields = applyInterruptedReviewSessionWrite(extraFields, {
        kind: 'discard',
        roomId: review.roomId,
      });
      // Phase 18: the review completion and its XP join the same record write, under the
      // same `(room, pass)` identity the award already uses. See
      // `src/core/statistics/statisticsEvents.ts` for why the ledger lives in this carrier
      // and not in a store of its own.
      extraFields = writeStatisticsEventsToFields(
        extraFields,
        reviewStatisticsEvents({
          subjectId: state.activeSubjectId,
          roomId: review.roomId,
          passNumber: review.passNumber,
          reviewIdentity: review.reviewIdentity,
          xpAwarded: xpEarned,
        }),
      );
    }

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      xpTotal: nextXp,
      rank: nextRank,
      reviewPasses: current.reviewPasses + 1,
      ...(extraFields !== undefined ? { extraFields } : {}),
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    // Phase 18: the session record's display counters, after the record write. See
    // `awardRoomClear` for why this is a separate step and why being late to it is safe.
    if (review !== undefined) {
      emitStatisticsActivity({
        kind: 'review-completion',
        roomId: review.roomId,
        passNumber: review.passNumber,
        xpAwarded: xpEarned,
      });
    }

    const unlockedAchievements = get().checkCrossSubjectAchievements();

    return {
      xpGained: xpEarned,
      newRank: nextRank,
      rankChanged: nextRank !== current.rank,
      unlockedAchievements,
      awarded: true,
      duplicate: false,
    };
  },

  readProgressionPreservedFields() {
    const state = get();
    if (!state.activeSubjectId) return undefined;
    return getSubjectProgression(state.bySubject, state.activeSubjectId).extraFields;
  },

  writeReviewSession(write) {
    const state = get();
    if (!state.activeSubjectId) return;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const extraFields = applyInterruptedReviewSessionWrite(current.extraFields, write);
    // Nothing to do when the write changed nothing, so a repeated `save` of an
    // unchanged marker is not a record write at all, and a `discard` with no marker
    // costs the device nothing.
    if (JSON.stringify(extraFields) === JSON.stringify(current.extraFields ?? {})) return;
    const nextSubject: PersistedSubjectProgression = { ...current, extraFields };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
  },

  // ── Phase 3c: Equippable loot methods ──────────────────────

  equipItem(itemId) {
    const state = get();
    if (!state.activeSubjectId) return false;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const item = current.inventory.find((i) => i.id === itemId);
    if (!item || !('equipSlot' in item)) return false;

    const equippable = item as EquippableLootItem;
    if (equippable.equipped) return false;

    // Unequip any item in the same slot
    const updatedEquipped = current.equippedItems
      ?.filter((e) => e.equipSlot !== equippable.equipSlot) ?? [];

    updatedEquipped.push({ ...equippable, equipped: true });

    // Mark item as equipped in inventory
    const updatedInventory = current.inventory.map((i) =>
      i.id === itemId ? { ...i, equipped: true } as EquippableLootItem : i,
    );

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      inventory: updatedInventory,
      equippedItems: updatedEquipped,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return true;
  },

  unequipItem(itemId) {
    const state = get();
    if (!state.activeSubjectId) return false;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const updatedEquipped = current.equippedItems?.filter((e) => e.id !== itemId) ?? [];

    const updatedInventory = current.inventory.map((i) =>
      i.id === itemId ? { ...i, equipped: false } as EquippableLootItem : i,
    );

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      inventory: updatedInventory,
      equippedItems: updatedEquipped,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return true;
  },

  getEquipBonuses() {
    const state = get();
    if (!state.activeSubjectId) return { qualityBonus: 0, xpMultiplier: 1, xpBonus: 0, streakBonus: 0 };
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    return computeEquipBonuses(current.equippedItems ?? []);
  },

  getCrossSubjectProgress() {
    const state = get();
    return computeCrossSubjectProgress({
      bySubject: state.bySubject,
      totalSubjectsCreated: Object.keys(state.bySubject).length,
    });
  },

  checkCrossSubjectAchievements() {
    const state = get();
    const progress = state.getCrossSubjectProgress();
    const newlyUnlocked = evaluateAchievementUnlocks(progress, state.crossSubjectAchievements);

    if (newlyUnlocked.length > 0) {
      const updatedAchs = [
        ...state.crossSubjectAchievements,
        ...newlyUnlocked.map((a) => a.id),
      ];
      set({ crossSubjectAchievements: updatedAchs });
      savePersistedBySubject(state.bySubject, updatedAchs);
      return newlyUnlocked.map((a) => a.id);
    }
    return [];
  },

  resetStreak: () => {
    const state = get();
    if (!state.activeSubjectId) return;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const nextSubject = { ...current, streakCount: 0 };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
  },

  reset: () => {
    const state = get();
    if (!state.activeSubjectId) {
      savePersistedBySubject({}, state.crossSubjectAchievements);
      set({
        bySubject: {},
        ...cloneDefaultSubjectProgression(),
      });
      return;
    }

    const bySubject = {
      ...state.bySubject,
      [state.activeSubjectId]: cloneDefaultSubjectProgression(),
    };
    const resetSubject = bySubject[state.activeSubjectId] ?? cloneDefaultSubjectProgression();
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    set({ bySubject, ...resetSubject });
  },
}));

function rollLoot(qualityBonus: number): LootItem | null {
  if (qualityBonus < 4) return null;
  const pool = qualityBonus >= 8 ? LOOT_POOL : LOOT_POOL.filter((l) => l.rarity !== 'epic');
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: `loot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: pick.name,
    description: pick.description,
    rarity: pick.rarity,
    acquiredAt: new Date().toISOString(),
  };
}
