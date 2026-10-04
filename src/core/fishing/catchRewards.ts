/**
 * The idempotent catch-reward ledger.
 *
 * ## The defects this exists for
 *
 * `VillageScreen.handleKeepFish` - the whole catch transaction, in three calls:
 *
 * ```ts
 * addFishToCollection({ name, rarity, subjectId, subjectName });   // set #1 + save #1
 * const xpResult = progression.awardFishingXp(rarity);            // set #2 + save #2
 * const newBadges = progression.checkFishingBadges();             // set #3..n, one per badge
 * console.log(`[Fishing] XP gained: ${xpResult.xpGained} ...`);   // and a log line
 * ```
 *
 * Three separate `set` calls and up to `3 + FISHING_BADGE_IDS.length` separate
 * `savePersistedBySubject()` calls, with **no guard of any kind**. Plan 5.3 calls
 * this out as "fish, XP, and badges are written through multiple non-transactional
 * operations", and three consequences follow:
 *
 * 1. **A partial reward.** A failure between (1) and (2) persists a fish with no XP;
 *    a failure between (2) and (3) persists XP with an unbadged collection. Neither
 *    can be repaired without a second write that the learner may never make.
 * 2. **No idempotency at all.** `awardFishingXp` has no guard whatsoever - not even
 *    the guard `collectArtifactNote` and Phase 15's `awardRoomClear` already have.
 *    A double dispatch, a retried click, or a React StrictMode double render pays
 *    twice. Plan 17's exit criterion is "fish, XP, and badges are awarded exactly
 *    once", and nothing in the current build can enforce it.
 * 3. **A console log on every catch**, printing XP, rank, and joined badge ids.
 *    Removed here: the typed outcome is the report, and a log line on a
 *    learner-visible action is a place learner behaviour could leak.
 *
 * This ledger is the same kind of object as `src/core/progression/roomClearRewards.ts`
 * and `src/core/review/reviewPassRewards.ts` and exists for the same reason: a reward
 * that can be minted twice has to be guarded durably, **in the same record write as
 * the reward itself**.
 *
 * ## Where the ledger lives, and why
 *
 * **Inside the canonical per-subject progression record, in its preserved
 * unknown-app-owned-field carrier (`extraFields`), under the static-vocabulary key
 * `catchRewardLedger`.** Chosen over three alternatives, with the same reasoning the
 * other two modules use:
 *
 * - **Alongside the record in a new storage-v2 store.** Rejected: a new object store
 *   is a data-format change, and it is outside Phase 17's boundary (working rule 3:
 *   do not combine renderer work with unrelated data-format work). Phase 17 adds no
 *   store, no store member, and no generation member.
 * - **Inside the fish collection array.** Rejected, and this one deserves the
 *   explicit argument rather than the boilerplate: the natural home for "this fish
 *   was already paid for" is the fish. But `addFishToCollection` only records a
 *   *kept* fish, and a released fish or a failed recall must write **nothing at
 *   all** - plan 17's exit criterion is "release and failed recall do not mutate
 *   progression". An audit trail that only exists for the one outcome that already
 *   left a trace buys no idempotency for the outcomes that leave none, and it would
 *   make the collection's own semantics depend on it. Also, a second implementation
 *   of this ledger would have to honour *both* carriers, so the durability argument
 *   would be made twice and either could be the one that is missing.
 * - **A separate `localStorage` key beside the progression key.** Rejected: the
 *   production repository is the legacy `localStorage` mirror, and a second key has
 *   no migration, no generation participation, and no backup participation - so the
 *   suppression would not survive the very reload window it exists to cover.
 *
 * The *subject* record was rejected on the same evidence as in Phase 16: `withRooms`
 * in `src/store/subjectStore.ts` rebuilds every snapshot as `{ dungeon, rooms }`
 * and `migrateToV11` is configured `unknownTopLevelFields: 'drop'`, so an unknown
 * top-level key on a subject snapshot does not survive the next room write.
 *
 * The chosen location gets every durability requirement free, because the
 * unknown-field machinery already exists and is already tested: `savePersistedBySubject`
 * flattens `extraFields` into the legacy mirror (the shipping repository), so
 * suppression survives a reload; `publishProgressionToActiveGeneration` writes the
 * whole canonical record, `extraFields` included; `validateProgressionRecord` only
 * requires the record to normalize and the normalizer is total, so validation needs
 * nothing from this module; both backup products carry progression records verbatim
 * and subject-copy ID remapping rewrites the whole `bySubject` subtree, so a copy
 * carries the awarded-once history; and the blank `.kdtemplate` product carries
 * graph structure only, so correctly does **not** carry this ledger.
 *
 * **No canonical-progression version change is needed or made.**
 * `src/core/progression/canonicalProgression.ts` and
 * `src/services/persistence/v2/validation.ts` are byte-identical to their pre-Phase-17
 * contents, and `CURRENT_SCHEMA_VERSION` stays `1.1.0`. The field is absent until a
 * caller supplies a catch identity, so every byte-comparison fixture is unaffected.
 *
 * ## Why the ledger is the same record as the reward
 *
 * The fish entry, the XP, the rank, the badge unlocks, and this ledger land in one
 * `set` of one record, in `progressionStore.recordCatch`. There is therefore **no
 * partial-reward window**: a failed write persists the reward *and* its guard
 * together or neither, so a later retry can never find a fish without its ledger
 * entry and award XP for it again. The decision is one pure function
 * ({@link decideCatchReward}) applied synchronously, which is what makes a
 * *concurrent* double dispatch safe: two calls in the same tick both read the
 * committed record, so the second observes the first's entry.
 *
 * **What cannot be made atomic, stated plainly:**
 *
 * - **Cross-subject achievements.** `checkCrossSubjectAchievements` runs after the
 *   record write and is a separate `set` per achievement, exactly as it does after
 *   `awardRoomClear` and `awardReviewPass`. It is already idempotent
 *   (`awardBadge` returns `false` for a badge already held), so the exposure is a
 *   lag, not a double count.
 * - **The renderer.** Nothing here can prevent a canvas from being torn down between
 *   the catch and the keep. That is why the catch identity is minted by the state
 *   machine at cast time and travels with the catch, rather than being minted at
 *   keep time: the identity of *this* catch survives losing the renderer, so the
 *   keep still suppresses.
 * - **The two repositories.** `savePersistedBySubject` writes storage-v2
 *   fire-and-forget and mirrors to `localStorage` afterwards. The in-memory record
 *   is the transaction boundary; a storage-v2 write that fails leaves the in-memory
 *   record correct and the persisted copy stale. That is pre-existing store
 *   behaviour, identical for the room-clear and review ledgers, and is not changed
 *   here.
 *
 * ## The catch identity, and why each component is in it
 *
 * One catch is one awardable unit, and the identity has to survive a reload and
 * must not be mintable twice. It is the digest of exactly three components:
 *
 * | Component | Why it is there |
 * |-----------|-----------------|
 * | `contextId` | One pond visit. Without it, the first catch of a session in *any* subject and the first catch of a session in *any* other subject derive the same digest, and the second is suppressed forever. `FishingContext.contextId` is app-minted at pond entry and is never a learner value. |
 * | `catalogId` | The species. Without it, cast 3 of a Moss Carp and cast 3 of a Lunar Trout derive the same digest, and the second is suppressed. |
 * | `castNumber` | Which cast in the session this was. Without it, **the common case fails**: two Moss Carp catches in one pond session derive the same digest and the second is suppressed. This is the component the old `createFishId` was accidentally supplying through `Date.now()`, which is why it could not be reused. |
 *
 * **Why not the fish entry id.** `createFishId` is
 * `Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)`. It is
 * neither deterministic nor injectable, so a test could not reproduce it and a
 * *different* run of the same catch would mint a different id - which is precisely
 * the property an awarded-once guard needs and cannot have. The new path builds the
 * entry id from an injected clock and an injected suffix (see
 * {@link createCanonicalFishEntry}), and keys the award on
 * {@link deriveCatchIdentity} instead.
 *
 * **Why `castNumber` and not a renderer-held ordinal.** A counter the renderer owns
 * is lost on a reload, and a reload between the catch and the keep would then mint a
 * fresh ordinal and pay twice. The state machine's `castNumber` is monotonic for the
 * life of a session and never rewound - not even by `reset` - so it is stable for as
 * long as the session is, and a retry of *the same catch* re-derives *the same*
 * number from the catch it was about, not from a re-read.
 *
 * **Nothing else goes in.** No topic, no subject name, no fish display name, no
 * learner text, no timestamp. See this module's privacy note and
 * `tests/phase17/catchRewards.test.ts`, which pins it.
 *
 * ## What XP a keep-without-recall awards
 *
 * The scope requires a distinct recorded outcome for a fish kept without recall
 * material. It does not say the fish is worthless, so the decision needs an argument.
 *
 * **The rule: `kept-without-recall` awards zero XP, keeps the fish, and still counts
 * toward every fishing badge.** The fish is genuinely earned - it is a real catch of
 * a real species, it enters the collection, and it moves `FshFirstCatch`,
 * `FshAngler`, `FshMasterAngler`, and `FshFullCreel` - so keeping it is a real
 * progression event, just not a learning one.
 *
 * The case against paying it:
 *
 * 1. **XP in this game is paid for learning evidence.** A cleared room's note, an
 *    artifact pickup, a completed review pass, a correct recall. Each has a study
 *    act behind it. A keep with no material has none: there was no question to
 *    answer, so there is nothing to have demonstrated.
 * 2. **Paying for the absence of a question pays for not progressing.** The
 *    eligibility gate requires one cleared room in the subject, so the only subjects
 *    a learner *cannot* fish are the ones with no recall material. Paying XP in
 *    exactly that case rewards skipping the work that would have produced the
 *    material. That is an exploit path, not a reward.
 * 3. **It would make the constant lie.** `FSH_XP_PER_CORRECT_ANSWER = 5` is named for
 *    what it pays for. Paid for a correct answer it is accurate and this phase
 *    leaves the name alone; paid for "there was no question" it would be wrong at the
 *    one place a reader looks.
 *
 * **So the constant keeps its name, and it is only ever paid for a correct answer.**
 * The per-outcome rate lives in {@link CATCH_XP_BY_OUTCOME} rather than by renaming
 * a shared constant, because the shared constant is also read by the rollback lane's
 * `awardFishingXp`, which must keep behaving exactly as it did.
 *
 * ## The two outcomes that write nothing
 *
 * `released` and `answered-incorrect` both have `mutatesProgression: false`. A
 * released fish never mutates progression is plan 5.2, verbatim. A *failed* recall
 * never mutating progression is plan 17's exit criterion, verbatim
 * ("Release and failed recall do not mutate progression"). Because the fish
 * collection lives in the progression record, a failed recall does not keep the fish
 * either: the fish goes back, and the UI is expected to say so and to offer the
 * local recall-question navigation back to the relevant room.
 *
 * That is the one **behaviour change** this ledger carries, and it is worth being
 * explicit about it, because `FishingRecallModal`'s "I need to review" button
 * currently keeps the fish and pays XP like a correct answer - the same defect shape
 * as its no-question branch, which reports a keep as `'correct'`. The rollback lane
 * (`VITE_PIXI_FISHING=false`, the Phaser scene and `VillageScreen.handleKeepFish`)
 * is untouched and still behaves exactly as it does today; this rule governs the new
 * path only.
 *
 * ## Privacy
 *
 * Nothing the learner wrote is ever hashed, keyed, or logged. A ledger entry holds an
 * app-minted session id, a catalogue id, an integer cast number, a rarity, an
 * app-minted entry id, an XP amount, an app-minted room id or `null`, an outcome code,
 * and an injected timestamp. There is no console output anywhere in this module or
 * on the new store action.
 */
import { assignRankTier } from '@/core/progression/progressionEngine';
import {
  FISHING_BADGE_DEFS,
  FISHING_BADGE_IDS,
  FSH_XP_PER_CORRECT_ANSWER,
  type FishingBadgeId,
  type RankTier,
} from '@/core/progression/types';
import { countCanonicalCatalogTypes } from './fishCollectionService';
import { FISH_CATALOG, FISH_RARITY_XP_MULTIPLIER, type CanonicalFishEntry, type FishCatalogEntry, type FishCollection, type FishRarity } from './fishingTypes';

// ── The ledger ───────────────────────────────────────────────────────────────

/**
 * The preserved app-owned field the ledger is carried under.
 *
 * Static vocabulary, deliberately not learner-influenced: a contract between this
 * module, the canonical normalizer's unknown-field carrier, and any future reader.
 * Never derived from a fish, a topic, a note, or a subject.
 */
export const CATCH_REWARD_LEDGER_KEY = 'catchRewardLedger';

/**
 * Ledger envelope version.
 *
 * Bumped only if the *shape* of the ledger changes. Carried so a future reader can
 * refuse an envelope it does not understand rather than silently treating it as
 * empty, which would re-open the duplicate-reward hole.
 */
export const CATCH_REWARD_LEDGER_VERSION = 1;

/**
 * Version tag mixed into every catch-identity digest.
 *
 * Bumped when the identity *rule* changes, so identities minted under the old rule
 * cannot collide with new ones and an old entry is simply never matched again -
 * which is the safe direction: a stale entry cannot suppress a reward it was not
 * written for.
 */
export const CATCH_IDENTITY_VERSION = 1;

/** Prefix every derived catch identity carries, so it is recognisable in a dump. */
const CATCH_IDENTITY_PREFIX = 'catch-';

/**
 * A resolution that **writes**: the fish is kept and recorded.
 *
 * Each is a code, never learner text. The two resolutions that write nothing are
 * {@link CatchDeclinedOutcome}.
 */
export type CatchOutcome =
  /** Kept after the learner answered the recall question correctly. */
  | 'answered-correct'
  /**
   * Kept with no recall material available. See the module header: this is a real
   * catch, so the fish and its badges land, and it is not a learning event, so it
   * pays no XP.
   */
  | 'kept-without-recall';

/**
 * A resolution that **writes nothing at all**.
 *
 * `released` is the learner throwing the fish back. `answered-incorrect` is the
 * learner failing the recall: the fish goes back too, because the fish collection
 * lives in the progression record and plan 17's exit criterion is that a failed recall
 * does not mutate progression.
 */
export type CatchDeclinedOutcome = 'released' | 'answered-incorrect';

/** Every resolution a catch can have. */
export type CatchResolution = CatchOutcome | CatchDeclinedOutcome;

/**
 * What each outcome does to the record.
 *
 * One table, consumed by {@link decideCatchReward}, so the policy is stated once
 * rather than spread across branches.
 */
export interface CatchOutcomePolicy {
  /** Whether the fish joins the collection. */
  readonly keepsFish: boolean;
  /** Base XP before the rarity multiplier. */
  readonly xpBase: number;
  /** Whether the fishing badges are re-evaluated. */
  readonly awardsBadges: boolean;
  /**
   * Whether anything is written.
   *
   * `false` for `released` and `answered-incorrect`, which is the whole of plan 5.2's
   * "releasing a fish never mutates progression" and plan 17's "release and failed
   * recall do not mutate progression".
   */
  readonly mutatesProgression: boolean;
}

/** The base XP per outcome, before the rarity multiplier. */
export const CATCH_XP_BY_OUTCOME: Readonly<Record<CatchOutcome, number>> = {
  'answered-correct': FSH_XP_PER_CORRECT_ANSWER,
  'kept-without-recall': 0,
};

/** What each outcome does. See the module header's argument for the XP column. */
export const CATCH_OUTCOME_POLICY: Readonly<Record<CatchResolution, CatchOutcomePolicy>> = {
  'answered-correct': {
    keepsFish: true,
    xpBase: CATCH_XP_BY_OUTCOME['answered-correct'],
    awardsBadges: true,
    mutatesProgression: true,
  },
  'kept-without-recall': {
    keepsFish: true,
    xpBase: CATCH_XP_BY_OUTCOME['kept-without-recall'],
    awardsBadges: true,
    mutatesProgression: true,
  },
  'released': {
    keepsFish: false,
    xpBase: 0,
    awardsBadges: false,
    mutatesProgression: false,
  },
  'answered-incorrect': {
    keepsFish: false,
    xpBase: 0,
    awardsBadges: false,
    mutatesProgression: false,
  },
};

/** The XP a keep of `rarity` under `outcome` earns, rounded like the old action. */
export function catchXpFor(outcome: CatchOutcome, rarity: FishRarity): number {
  const multiplier = FISH_RARITY_XP_MULTIPLIER[rarity] ?? 1.0;
  return Math.round(CATCH_XP_BY_OUTCOME[outcome] * multiplier);
}

/** One recorded catch. */
export interface CatchRewardEntry {
  /**
   * The pond session this catch came from. App-minted at pond entry.
   *
   * Never learner content.
   */
  contextId: string;
  /** The canonical catalogue id. Catalogue content, not learner content. */
  catalogId: string;
  /**
   * Which cast in the session this was, one-based.
   *
   * A **cast number**, not a raw counter, for the reason
   * {@link deriveCatchIdentity} gives.
   */
  castNumber: number;
  /** The rarity the catalogue rolled. Catalogue content. */
  rarity: FishRarity;
  /** The digest of (context id, catalogue id, cast number). */
  catchIdentity: string;
  /** How it resolved. A code. */
  outcome: CatchOutcome;
  /** The XP this catch actually paid, so a replay can be checked against it. */
  xpAwarded: number;
  /**
   * The app-minted id of the persisted fish entry.
   *
   * Lets a reader tie a ledger row to the entry it paid for without re-deriving an
   * id from anything.
   */
  fishEntryId: string;
  /**
   * The room whose recall question was answered, or `null` when there was none.
   *
   * An app-minted room id - never a topic. Carried so Phase 18's statistics and
   * Phase 17's "navigation back to the relevant room" have a subject-scoped handle
   * without re-deriving one from learner material.
   */
  recallRoomId: string | null;
  /** ISO timestamp from the caller's clock. Injected, never read here. */
  awardedAt: string;
}

/** The durable awarded-once ledger for one subject. */
export interface CatchRewardLedger {
  version: number;
  /**
   * Recorded catches, newest first.
   *
   * Unbounded on purpose. Each entry is roughly two hundred bytes and a serious
   * angler plays for years, so this stays well inside a kilobyte in any realistic
   * subject - but a cap would be a correctness hole, because evicting an entry would
   * let that catch award a second time. The room-clear and review ledgers take the
   * same position.
   */
  entries: CatchRewardEntry[];
}

/** A ledger for a subject that has never kept a fish. */
export function emptyCatchRewardLedger(): CatchRewardLedger {
  return { version: CATCH_REWARD_LEDGER_VERSION, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toCastNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function toXp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function toRarity(value: unknown): FishRarity {
  return value === 'rare' || value === 'epic' ? value : 'common';
}

function toOutcome(value: unknown): CatchOutcome {
  return value === 'kept-without-recall' ? 'kept-without-recall' : 'answered-correct';
}

function toOptionalTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read a ledger out of any persisted value.
 *
 * Total by construction, because it is called on data this module did not write: a
 * legacy progression payload, a storage-v2 record, a hand-edited backup, or
 * `undefined`. Anything unrecognized reads as the empty ledger, which is the honest
 * answer - "this subject has never kept a fish" - rather than a refusal: a ledger
 * this build cannot read has, from the reward's point of view, never been written.
 *
 * A `version` this build does not know is likewise read as empty rather than
 * half-parsed. That is a deliberate choice over refusing the whole record: a future
 * ledger version in a restored backup must not make a subject unreadable, and the
 * consequence is bounded - the next catch appends a v1 entry alongside whatever this
 * reader skipped, so at worst one catch from the future version pays once more.
 */
export function readCatchRewardLedger(raw: unknown): CatchRewardLedger {
  if (!isRecord(raw)) return emptyCatchRewardLedger();
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .filter(isRecord)
        .map((entry) => ({
          contextId: toTrimmedString(entry.contextId),
          catalogId: toTrimmedString(entry.catalogId),
          castNumber: toCastNumber(entry.castNumber),
          rarity: toRarity(entry.rarity),
          catchIdentity: toTrimmedString(entry.catchIdentity),
          outcome: toOutcome(entry.outcome),
          xpAwarded: toXp(entry.xpAwarded),
          fishEntryId: toTrimmedString(entry.fishEntryId),
          recallRoomId: toOptionalTrimmedString(entry.recallRoomId),
          awardedAt: toTrimmedString(entry.awardedAt),
        }))
        // `castNumber` and `contextId` are both part of the identity, so an entry
        // missing either cannot be matched and is dropped rather than trusted:
        // keeping it would grow the ledger with rows that suppress nothing.
        .filter(
          (entry) =>
            entry.contextId.length > 0 &&
            entry.catalogId.length > 0 &&
            entry.catchIdentity.length > 0 &&
            entry.castNumber > 0,
        )
    : [];
  return { version: CATCH_REWARD_LEDGER_VERSION, entries };
}

/** Read the ledger a canonical record's preserved fields carry, if any. */
export function readCatchRewardLedgerFromFields(
  extraFields: Record<string, unknown> | undefined,
): CatchRewardLedger {
  if (!extraFields) return emptyCatchRewardLedger();
  return readCatchRewardLedger(extraFields[CATCH_REWARD_LEDGER_KEY]);
}

/**
 * Return the preserved fields with `ledger` written under the ledger key.
 *
 * Every other preserved field is carried through untouched, so this ledger cannot
 * cost the device the room-clear ledger, the review-pass ledger, the
 * interrupted-review marker, or any unknown app-owned field a later phase writes.
 */
export function writeCatchRewardLedgerToFields(
  extraFields: Record<string, unknown> | undefined,
  ledger: CatchRewardLedger,
): Record<string, unknown> {
  return { ...(extraFields ?? {}), [CATCH_REWARD_LEDGER_KEY]: ledger };
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * The identity of one catch: (session, species, cast).
 *
 * Required by the command layer and optional on the store action only in the sense
 * that the *store* takes the finished identity; see the module header for why each
 * of the three components is there, and for why the fish entry id is not this.
 */
export interface CatchRewardIdentity {
  /** The pond session the catch came from. */
  readonly contextId: string;
  /** The canonical catalogue id of the species. */
  readonly catalogId: string;
  /** Which cast in the session, one-based. */
  readonly castNumber: number;
  /** {@link deriveCatchIdentity} for the three fields above. */
  readonly catchIdentity: string;
}

/** Whether this exact catch has already been recorded. */
export function hasCatchReward(ledger: CatchRewardLedger, identity: CatchRewardIdentity): boolean {
  return ledger.entries.some((entry) => entry.catchIdentity === identity.catchIdentity);
}

/** The most recent entry for a session, or `null` when it has never kept a fish. */
export function latestCatchRewardForContext(
  ledger: CatchRewardLedger,
  contextId: string,
): CatchRewardEntry | null {
  return ledger.entries.find((entry) => entry.contextId === contextId) ?? null;
}

/** How many catches a session has recorded. */
export function countCatchRewardsForContext(ledger: CatchRewardLedger, contextId: string): number {
  return ledger.entries.filter((entry) => entry.contextId === contextId).length;
}

/**
 * Append a catch to the ledger, newest first.
 *
 * Idempotent for a repeated identity: replaying the same entry is a no-op rather
 * than a duplicate, so a retry that re-derives the same decision cannot grow the
 * ledger.
 */
export function recordCatchReward(
  ledger: CatchRewardLedger,
  entry: CatchRewardEntry,
): CatchRewardLedger {
  if (hasCatchReward(ledger, entry)) return ledger;
  return { version: CATCH_REWARD_LEDGER_VERSION, entries: [entry, ...ledger.entries] };
}

/**
 * Replace the row carrying `entry`'s identity, or append it if there is none.
 *
 * Distinct from {@link recordCatchReward}, which **keeps** the existing row on a repeat.
 * That is the right behaviour for a replay and the wrong behaviour for a correction:
 * {@link withRecallRoom} rewrites a row's descriptive fields after
 * `decideCatchReward` chose them, and must not lose the row's earlier entries or
 * duplicate it.
 */
export function replaceCatchReward(
  ledger: CatchRewardLedger,
  entry: CatchRewardEntry,
): CatchRewardLedger {
  const others = ledger.entries.filter((existing) => existing.catchIdentity !== entry.catchIdentity);
  return { version: CATCH_REWARD_LEDGER_VERSION, entries: [entry, ...others] };
}

/**
 * FNV-1a, 32-bit, rendered as eight lowercase hex digits.
 *
 * Chosen for the same reason as in the other two ledgers: five pure lines, no
 * import, identical in every bundle and in every test. Deliberately
 * **non-cryptographic** - the identity guards against an accidental duplicate
 * reward, not an adversary, and nothing about the digest is a secret.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Token separator that cannot occur in a session id, a catalogue id, or a number. */
const IDENTITY_SEPARATOR = '';

/**
 * Derive the identity of a catch.
 *
 * **What goes in: an app-minted session id, a catalogue id, and an integer cast
 * number. Nothing else.** No topic, no subject name, no fish display name, no learner
 * text, no timestamp - the timestamp is stored on the entry but is deliberately not
 * an identity component, because a catch re-derived a millisecond later must still
 * suppress.
 *
 * **What it buys:**
 *
 * - A **double dispatch**, a retried click, or a StrictMode double render all
 *   re-derive the same number from the same catch, so the digest is unchanged and the
 *   award is suppressed.
 * - A **reload** reads the same ledger back out of the persisted record, so the
 *   suppression survives the window that used to pay twice.
 * - **Two catches of the same species in one session** have different cast numbers,
 *   so the second pays. This is the case a fish-id-based or name-based identity gets
 *   wrong.
 * - The digest is **total**: any string input produces a stable identity rather than
 *   throwing, so a malformed context cannot crash a keep.
 */
export function deriveCatchIdentity(input: {
  contextId: string;
  catalogId: string;
  castNumber: number;
}): string {
  const castNumber = Number.isFinite(input.castNumber)
    ? Math.max(0, Math.trunc(input.castNumber))
    : 0;
  return `${CATCH_IDENTITY_PREFIX}${fnv1a32(
    [
      `v${CATCH_IDENTITY_VERSION}`,
      `session:${input.contextId}`,
      `catalog:${input.catalogId}`,
      `cast:${castNumber}`,
    ].join(IDENTITY_SEPARATOR),
  )}`;
}

/**
 * Build the whole identity the ledger and the store both key on.
 *
 * One function so a caller cannot build a `castNumber` and a `catchIdentity` that
 * disagree - a mismatch would either suppress an award it was not written for or
 * award one twice.
 */
export function toCatchRewardIdentity(input: {
  contextId: string;
  catalogId: string;
  castNumber: number;
}): CatchRewardIdentity {
  const castNumber = Number.isFinite(input.castNumber)
    ? Math.max(0, Math.trunc(input.castNumber))
    : 0;
  return {
    contextId: input.contextId,
    catalogId: input.catalogId,
    castNumber,
    catchIdentity: deriveCatchIdentity(input),
  };
}

// ── The persisted fish entry ─────────────────────────────────────────────────

/**
 * Build the canonical fish entry a keep persists.
 *
 * **The fix for "fish catalog identity is discarded or represented inconsistently".**
 * `progressionStore.addFish` mints its id from
 * `name.toLowerCase().replace(/\s+/g, '-')` - the *display name*, not the catalogue
 * id - and never sets `catalogId`, so `resolveFishCatalogId` falls through its
 * `entry-id-prefix` branch to `catalog-name-match`. It works today only because
 * every catalogue name happens to slug to its own id, which is a coincidence and not
 * a contract.
 *
 * Here the id's prefix **is** the catalogue id and `catalogId` is set explicitly, so
 * identity never depends on either coincidence.
 *
 * The clock and the suffix are **injected**, unlike `createFishId`'s
 * `Date.now()`/`Math.random()` pair, because the entry id must be reproducible in a
 * test. The caller mints the suffix; the store uses the same
 * `Date.now()`-and-`Math.random()` shape `createFishId` produces so the persisted id
 * format is unchanged and the `entry-id-prefix` resolution branch keeps working for
 * every entry written before this phase.
 */
export function createCanonicalFishEntry(input: {
  catalogEntry: FishCatalogEntry;
  subjectId: string;
  subjectName: string;
  /** ISO timestamp from the caller's clock. */
  caughtAt: string;
  /** The id suffix. Injected, so the caller owns the randomness. */
  entrySuffix: string;
}): CanonicalFishEntry {
  return {
    id: `${input.catalogEntry.id}:${input.entrySuffix}`,
    name: input.catalogEntry.name,
    rarity: input.catalogEntry.rarity,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    caughtAt: input.caughtAt,
    catalogId: input.catalogEntry.id,
  };
}

/**
 * The suffix shape `createFishId` produces, from an injected clock and an injected
 * random value.
 *
 * Two arguments rather than none, so `src/store` can keep minting ids with the real
 * clock and `Math.random` while a test mints them with constants. The *format* is
 * preserved deliberately: an entry written by this phase is indistinguishable in
 * shape from one written by `addFish`, so nothing downstream has to learn a second
 * id grammar.
 */
export function createFishEntrySuffix(nowMs: number, random: number): string {
  const time = Math.max(0, Math.trunc(nowMs)).toString(36);
  const noise = Math.max(0, Math.min(0.9999999, random)).toString(36).slice(2, 8);
  return `${time}-${noise}`;
}

// ── Badges ───────────────────────────────────────────────────────────────────

/**
 * Which fishing badges a collection has earned that are not already held.
 *
 * Two things differ from `progressionStore.checkFishingBadges`, both deliberate:
 *
 * 1. **The unique count is canonical.** `checkFishingBadges` uses
 *    `countUniqueTypes`, which counts distinct *display names*.
 *    {@link countCanonicalCatalogTypes} counts distinct *catalogue ids*. Plan 17's
 *    exit criterion is "collection counts use canonical catalog IDs and subject IDs",
 *    and two names that resolve to one catalogue id is exactly the inconsistency the
 *    criterion names. `FshFullCreel` is the only badge that reads it.
 * 2. **It is pure.** `checkFishingBadges` awards through `awardBadge`, one `set` and
 *    one `savePersistedBySubject` per badge. Here the badges are returned so the
 *    caller can add them in the same record write as the fish and the XP, which is
 *    the whole point of the transaction.
 *
 * The threshold and label tables are the shared constants, so a badge's meaning
 * cannot differ between the two paths.
 */
export function evaluateFishingBadgeUnlocks(input: {
  collection: FishCollection;
  heldBadges: readonly string[];
}): FishingBadgeId[] {
  const held = new Set(input.heldBadges);
  const totalFish = input.collection.length;
  const uniqueCanonicalTypes = countCanonicalCatalogTypes(input.collection);

  const unlocked: FishingBadgeId[] = [];
  for (const badgeId of FISHING_BADGE_IDS) {
    if (held.has(badgeId)) continue;
    const def = FISHING_BADGE_DEFS[badgeId];
    const earned =
      badgeId === 'FshFullCreel'
        ? uniqueCanonicalTypes >= FISH_CATALOG.length
        : totalFish >= def.threshold;
    if (earned) unlocked.push(badgeId);
  }
  return unlocked;
}

// ── The decision ─────────────────────────────────────────────────────────────

/** An award: everything the one record write needs, computed as a single value. */
export interface AwardedCatchRewardDecision {
  readonly outcome: 'awarded';
  readonly ledger: CatchRewardLedger;
  readonly identity: CatchRewardIdentity;
  /** The record's XP after this catch. */
  readonly nextXpTotal: number;
  readonly rank: RankTier;
  readonly rankChanged: boolean;
  readonly xpAwarded: number;
  /** The entry to prepend to the collection. Never `null` on an award. */
  readonly fishEntry: CanonicalFishEntry;
  readonly badgesUnlocked: readonly FishingBadgeId[];
  readonly recorded: CatchRewardEntry;
}

/** What a keep did, as one pure value the store writes in a single record. */
export type CatchRewardDecision =
  | AwardedCatchRewardDecision
  | {
      readonly outcome: 'already-awarded';
      readonly ledger: CatchRewardLedger;
      readonly identity: CatchRewardIdentity;
      /** Always `0`. A suppressed catch pays nothing. */
      readonly xpAwarded: 0;
      readonly fishEntry: null;
      readonly badgesUnlocked: readonly FishingBadgeId[];
    }
  | {
      readonly outcome: 'already-awarded';
      readonly ledger: CatchRewardLedger;
      readonly identity: CatchRewardIdentity;
      /** Always `0`. A suppressed catch pays nothing. */
      readonly xpAwarded: 0;
      readonly fishEntry: null;
      readonly badgesUnlocked: readonly FishingBadgeId[];
    }
  | {
      /** Nothing was written, and nothing should be. */
      readonly outcome: 'declined';
      readonly declinedOutcome: CatchDeclinedOutcome;
      readonly identity: CatchRewardIdentity;
      readonly xpAwarded: 0;
      readonly fishEntry: null;
      readonly badgesUnlocked: readonly FishingBadgeId[];
      /**
       * The ledger as read, unchanged.
       *
       * Carried so a caller can prove it wrote nothing, and so the decision value is
       * a complete description of what the record looks like either way.
       */
      readonly ledger: CatchRewardLedger;
    };

/**
 * The whole award-or-suppress-or-decline decision, as one pure function.
 *
 * Returning the *next* ledger rather than a boolean is what makes the caller a single
 * synchronous read-modify-write: there is no window between deciding and writing, so
 * two calls in the same tick cannot both decide to award.
 *
 * A suppressed or declined decision mints no id and burns no `Math.random`: the
 * `fishEntry` argument is accepted as an already-built entry, and
 * `progressionStore.recordCatch` only builds it *after* this returns `awarded`. The
 * same discipline as Phase 15's and Phase 16's ledgers.
 *
 * @param extraFields The subject record's preserved fields, as read.
 * @param identity Which catch this is.
 * @param outcome How the catch resolved.
 * @param xpTotal The record's XP before this catch.
 * @param rank The record's rank before this catch, for `rankChanged`.
 * @param collection The record's collection before this catch.
 * @param heldBadges The record's badges before this catch.
 * @param fishEntry The entry to persist, or `null` when the outcome may be declined -
 *   building an id is a side effect, and a declined catch must not perform one.
 */
export function decideCatchReward(input: {
  extraFields: Record<string, unknown> | undefined;
  identity: CatchRewardIdentity;
  outcome: CatchResolution;
  xpTotal: number;
  rank: RankTier;
  collection: FishCollection;
  heldBadges: readonly string[];
  /** `null` when the caller could not build one, which the decision surfaces. */
  fishEntry: CanonicalFishEntry | null;
  awardedAt: string;
}): CatchRewardDecision {
  const policy = CATCH_OUTCOME_POLICY[input.outcome];
  const ledger = readCatchRewardLedgerFromFields(input.extraFields);

  if (!policy.mutatesProgression) {
    // The ledger is read but not written, and returned unchanged so a caller that
    // holds it can compare. Nothing here writes; `progressionStore.recordCatch` is
    // what refuses to call `set` for a declined outcome.
    return {
      outcome: 'declined',
      declinedOutcome: input.outcome as CatchDeclinedOutcome,
      identity: input.identity,
      xpAwarded: 0,
      fishEntry: null,
      badgesUnlocked: [],
      ledger,
    };
  }

  if (hasCatchReward(ledger, input.identity)) {
    return {
      outcome: 'already-awarded',
      ledger,
      identity: input.identity,
      xpAwarded: 0,
      fishEntry: null,
      badgesUnlocked: [],
    };
  }

  if (input.fishEntry === null) {
    // A keep that cannot build an entry has nothing to record. Refusing here rather
    // than writing a ledger row with no fish would be the alternative, and it is
    // worse: the row would suppress a retry that could have succeeded.
    return {
      outcome: 'already-awarded',
      ledger,
      identity: input.identity,
      xpAwarded: 0,
      fishEntry: null,
      badgesUnlocked: [],
    };
  }

  const outcome = input.outcome as CatchOutcome;
  const xpAwarded = catchXpFor(outcome, input.fishEntry.rarity);
  const nextXpTotal = input.xpTotal + xpAwarded;
  const rank = assignRankTier(nextXpTotal);

  const nextCollection: FishCollection = [input.fishEntry, ...input.collection];
  const badgesUnlocked = policy.awardsBadges
    ? evaluateFishingBadgeUnlocks({ collection: nextCollection, heldBadges: input.heldBadges })
    : [];

  const recorded: CatchRewardEntry = {
    contextId: input.identity.contextId,
    catalogId: input.identity.catalogId,
    castNumber: input.identity.castNumber,
    rarity: input.fishEntry.rarity,
    catchIdentity: input.identity.catchIdentity,
    outcome,
    xpAwarded,
    fishEntryId: input.fishEntry.id,
    recallRoomId: null,
    awardedAt: input.awardedAt,
  };

  return {
    outcome: 'awarded',
    ledger: recordCatchReward(ledger, recorded),
    identity: input.identity,
    nextXpTotal,
    rank,
    rankChanged: rank !== input.rank,
    xpAwarded,
    fishEntry: input.fishEntry,
    badgesUnlocked,
    recorded,
  };
}

/**
 * The decision with the recall room attached to the recorded entry.
 *
 * {@link decideCatchReward} leaves `recallRoomId` `null` because the room is
 * presentation-adjacent input the pure decision does not need. The store sets it in
 * the one write it makes, from the app-minted room id the command layer resolved
 * **against the context's subject**. Splitting it this way keeps the digest's inputs
 * and the row's descriptive fields distinguishable at a glance.
 */
export function withRecallRoom(
  decision: CatchRewardDecision,
  recallRoomId: string | null,
): AwardedCatchRewardDecision {
  if (decision.outcome !== 'awarded') {
    throw new Error('withRecallRoom requires an awarded decision.');
  }
  const recallRoom =
    recallRoomId !== null && recallRoomId.trim().length > 0 ? recallRoomId.trim() : null;
  const recorded: CatchRewardEntry = { ...decision.recorded, recallRoomId: recallRoom };
  return {
    ...decision,
    // `replaceCatchReward` rewrites **this** row and carries every other entry through.
    // Rebuilding the ledger from empty here would silently drop every earlier catch,
    // and `recordCatchReward` would be a no-op because the row is already present.
    ledger: replaceCatchReward(decision.ledger, recorded),
    recorded,
  };
}