/**
 * The idempotent review-pass reward ledger.
 *
 * ## The defect this exists for
 *
 * `studyFlow.finalizePendingReview` decided whether to award review XP with a
 * *live read* - `room.reviewPassCount < summarizeReviewAnalytics(...).fullReviewPasses + 1`
 * - and then called `void store.recordReviewPass(roomId)` (an unawaited async
 * subject-store write) before `store.awardReviewPass()`. Three separate failures
 * follow from that ordering:
 *
 * 1. Two finalizations in the same tick both read the same committed
 *    `reviewPassCount` and both award, because the increment lands in the async
 *    subject write and the decision was already made.
 * 2. A retried close, a reopened panel, or a reload window awards again: there
 *    was no durable guard at all, only a comparison against a counter the flow
 *    did not control.
 * 3. `store.awardReviewPass()` itself was unconditional, so anything that could
 *    reach it could mint XP, `reviewPasses`, and a rank change at will.
 *
 * This ledger is the same kind of object as `src/core/progression/roomClearRewards.ts`
 * and exists for the same reason: plan 5.2 requires "review completion is recorded
 * exactly once per room per pass", and that cannot be enforced by a comparison
 * against a counter an asynchronous writer owns.
 *
 * ## Where the ledger lives, and why
 *
 * **Inside the canonical per-subject progression record, in its preserved
 * unknown-app-owned-field carrier (`extraFields`), under the static-vocabulary
 * key `reviewPassRewardLedger`.** Chosen over three alternatives:
 *
 * - **Alongside the record in a new storage-v2 store.** Rejected: a new object
 *   store is a data-format change, and it is outside Phase 16's boundary (plan
 *   working rule 3: do not combine renderer work with unrelated data-format
 *   work).
 * - **Inside `RoomMetadata` on the subject.** Rejected: the subject schema stays
 *   `1.1.0` (working rule 4), and a reward is progression state, not
 *   subject-graph state. It would also put an XP-write decision inside the
 *   subject snapshot, which has no opinion about XP.
 * - **A separate `localStorage` key beside the progression key.** Rejected: the
 *   production repository is the legacy `localStorage` mirror, and a second key
 *   has no migration, no generation participation, and no backup participation.
 *
 * **The subject record was considered and rejected on evidence, not on taste.**
 * The subject path has no unknown-field carrier at all: `withRooms` in
 * `src/store/subjectStore.ts` rebuilds every snapshot as `{ dungeon, rooms }`,
 * and `migrateToV11` in `src/services/persistence/subjectPersistence.ts` is
 * configured `unknownTopLevelFields: 'drop'`. An unknown top-level key on a
 * subject snapshot is therefore dropped by the first room write, so a marker or
 * ledger placed there would not survive the interaction it was written during.
 * The progression record's carrier is the only carrier this phase can use, and
 * it is a *different store* from the subject record - which is why the durable
 * side of a review lives here while the SM-2 side lives in `RoomMetadata`.
 *
 * The chosen location gets every durability requirement for free, because the
 * unknown-field preservation machinery already exists and is already tested:
 *
 * - `savePersistedBySubject` flattens `extraFields` into the legacy record, so
 *   the ledger survives a reload in the **default** (legacy-repository) build,
 *   which is the configuration that ships.
 * - `publishProgressionToActiveGeneration` writes the whole normalized canonical
 *   record, `extraFields` included, so storage-v2 carries it too.
 * - `validateProgressionRecord` only requires the record to normalize, and the
 *   normalizer is total, so validation needs nothing from this module.
 * - The full-device and subject backup products carry the progression records
 *   verbatim, and subject-copy ID remapping rewrites this subject's whole
 *   `bySubject` subtree, so a copy carries the awarded-once history.
 * - The blank `.kdtemplate` product carries graph structure only and therefore
 *   correctly does **not** carry the ledger. That is the required behaviour, not
 *   a gap.
 *
 * **No canonical-progression version change is needed or made.**
 * `src/core/progression/canonicalProgression.ts` and
 * `src/services/persistence/v2/validation.ts` are byte-identical to their
 * pre-Phase-16 contents: the envelope shape (`version` / `bySubject` /
 * `crossSubjectAchievements`) is untouched, the thirteen legacy record keys are
 * untouched, and this field is absent until a caller supplies a review identity,
 * so every byte-comparison fixture is unaffected.
 *
 * ## Why the ledger is the same record as the reward
 *
 * XP, the rank, the `reviewPasses` increment, the cleared interrupted-review
 * marker, and this ledger are written in one `set` of one record by
 * `progressionStore.awardReviewPass`. There is therefore **no partial-reward
 * window**: a failed write persists the reward *and* its guard together or
 * neither, so a later retry can never find a reward without its guard and award
 * it twice. The decision is a single pure function ({@link decideReviewPassReward})
 * applied synchronously, which is what makes a *concurrent* double dispatch
 * safe: two calls in the same tick both read the committed state, so the second
 * observes the first's ledger entry.
 *
 * The SM-2 update on the **subject** side is not in that transaction, and cannot
 * be: it is an async write to a different store. The consequence is stated
 * plainly in `src/application/reviewCommands.ts` rather than papered over - the
 * durable guard is on the progression side, and it is the side that pays.
 *
 * ## Privacy
 *
 * Nothing the learner wrote is ever hashed, keyed, or logged. A ledger entry is a
 * room id (minted by the app), an integer pass number, an opaque digest of those
 * two, and an injected timestamp. See {@link deriveReviewPassIdentity}.
 */

/**
 * The preserved app-owned field the ledger is carried under.
 *
 * Static vocabulary, deliberately not learner-influenced: it is a contract
 * between this module, the canonical normalizer's unknown-field carrier, and any
 * future reader. It is never derived from a room, a note, a topic, or a subject.
 */
export const REVIEW_PASS_REWARD_LEDGER_KEY = 'reviewPassRewardLedger';

/**
 * Ledger envelope version.
 *
 * Bumped only if the *shape* of the ledger changes. It is carried so a future
 * reader can refuse an envelope it does not understand rather than silently
 * treating it as empty, which would re-open the duplicate-reward hole.
 */
export const REVIEW_PASS_REWARD_LEDGER_VERSION = 1;

/**
 * Version tag mixed into every review-identity digest.
 *
 * Bumped when the identity *rule* changes, so identities minted under the old
 * rule cannot collide with new ones and an old entry is simply never matched
 * again (which is the safe direction: a stale entry cannot suppress a reward it
 * was not written for).
 */
export const REVIEW_PASS_IDENTITY_VERSION = 1;

/** Prefix every derived identity carries, so it is recognisable in a dump. */
const REVIEW_IDENTITY_PREFIX = 'rpass-';

/** One awarded review pass. */
export interface ReviewPassRewardEntry {
  /**
   * The reviewed room's app-minted id.
   *
   * Never learner content: room ids are minted by the Creator and the tutorial
   * fixture, and are not derived from a topic.
   */
  roomId: string;
  /**
   * Which full-review pass the award belongs to, one-based.
   *
   * A **pass number**, not a raw counter. See
   * {@link deriveReviewPassIdentity} for why that distinction is the whole
   * point of this ledger.
   */
  passNumber: number;
  /**
   * The digest of (room id, pass number).
   *
   * Opaque by construction: the reader learns nothing from it about the subject,
   * and it is not reversible into room ids, topics, or note content.
   */
  reviewIdentity: string;
  /** ISO timestamp from the caller's clock. Injected, never read here. */
  awardedAt: string;
}

/** The durable awarded-once ledger for one subject. */
export interface ReviewPassRewardLedger {
  version: number;
  /**
   * Awarded review passes, newest first.
   *
   * Unbounded on purpose, and for a stronger reason than the room-clear ledger's:
   * an entry here is one (room, pass) pair, so a subject that is reviewed
   * repeatedly grows one entry per room per pass rather than one per room. A cap
   * would be a correctness hole - evicting an entry would let a very old pass
   * award a second time. Realistic subjects stay in the low kilobytes: 30 rooms
   * x 40 passes is 1200 entries.
   */
  entries: ReviewPassRewardEntry[];
}

/** A ledger for a subject that has never awarded a review pass. */
export function emptyReviewPassRewardLedger(): ReviewPassRewardLedger {
  return { version: REVIEW_PASS_REWARD_LEDGER_VERSION, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toPassNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Read a ledger out of any persisted value.
 *
 * Total by construction, because it is called on data this module did not write:
 * a v1/v2/v3 progression payload, a storage-v2 record, a hand-edited backup, or
 * `undefined`. Anything unrecognized reads as the empty ledger, which is the
 * honest answer ("this subject has no recorded review passes") rather than a
 * refusal - a ledger this build cannot read has, from the reward's point of view,
 * never been written.
 */
export function readReviewPassRewardLedger(raw: unknown): ReviewPassRewardLedger {
  if (!isRecord(raw)) return emptyReviewPassRewardLedger();
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .filter(isRecord)
        .map((entry) => ({
          roomId: toTrimmedString(entry.roomId),
          passNumber: toPassNumber(entry.passNumber),
          reviewIdentity: toTrimmedString(entry.reviewIdentity),
          awardedAt: toTrimmedString(entry.awardedAt),
        }))
        // `passNumber` is part of the identity, so an entry without a usable one
        // cannot be matched and is dropped rather than trusted: keeping it would
        // grow the ledger with rows that suppress nothing.
        .filter(
          (entry) => entry.roomId.length > 0 && entry.reviewIdentity.length > 0 && entry.passNumber > 0,
        )
    : [];
  return { version: REVIEW_PASS_REWARD_LEDGER_VERSION, entries };
}

/** Read the ledger a canonical record's preserved fields carry, if any. */
export function readReviewPassRewardLedgerFromFields(
  extraFields: Record<string, unknown> | undefined,
): ReviewPassRewardLedger {
  if (!extraFields) return emptyReviewPassRewardLedger();
  return readReviewPassRewardLedger(extraFields[REVIEW_PASS_REWARD_LEDGER_KEY]);
}

/**
 * Return the preserved fields with `ledger` written under the ledger key.
 *
 * Every other preserved field is carried through untouched, so this ledger cannot
 * cost the device the room-clear ledger, the interrupted-review marker, or any
 * unknown app-owned field a later phase writes.
 */
export function writeReviewPassRewardLedgerToFields(
  extraFields: Record<string, unknown> | undefined,
  ledger: ReviewPassRewardLedger,
): Record<string, unknown> {
  return { ...(extraFields ?? {}), [REVIEW_PASS_REWARD_LEDGER_KEY]: ledger };
}

/**
 * The identity of one review pass: the room, the pass, and the digest of both.
 *
 * Required by the command layer and optional on the store action, mirroring the
 * Phase 15 `RoomClearRewardIdentity` carve-out. See
 * `progressionStore.awardReviewPass`.
 */
export interface ReviewPassRewardIdentity {
  /** The room being reviewed. */
  readonly roomId: string;
  /** Which full-review pass, one-based. */
  readonly passNumber: number;
  /** {@link deriveReviewPassIdentity} for the two fields above. */
  readonly reviewIdentity: string;
}

/** Whether this exact (room, pass) has already been awarded. */
export function hasReviewPassReward(
  ledger: ReviewPassRewardLedger,
  roomId: string,
  passNumber: number,
): boolean {
  return ledger.entries.some(
    (entry) => entry.roomId === roomId && entry.passNumber === passNumber,
  );
}

/** The most recent entry for a room, or `null` when it has never been awarded. */
export function latestReviewPassRewardForRoom(
  ledger: ReviewPassRewardLedger,
  roomId: string,
): ReviewPassRewardEntry | null {
  return ledger.entries.find((entry) => entry.roomId === roomId) ?? null;
}

/**
 * Append a review pass to the ledger, newest first.
 *
 * Idempotent for a repeated (room, pass): replaying the same entry is a no-op
 * rather than a duplicate, so a retry that re-derives the same decision cannot
 * grow the ledger.
 */
export function recordReviewPassReward(
  ledger: ReviewPassRewardLedger,
  entry: ReviewPassRewardEntry,
): ReviewPassRewardLedger {
  if (hasReviewPassReward(ledger, entry.roomId, entry.passNumber)) return ledger;
  return { version: REVIEW_PASS_REWARD_LEDGER_VERSION, entries: [entry, ...ledger.entries] };
}

/**
 * The whole award-or-suppress decision, as one pure function.
 *
 * Returning the *next* ledger (rather than a boolean) is what makes the caller a
 * single synchronous read-modify-write: there is no window between deciding and
 * writing, so two calls in the same tick cannot both decide to award.
 */
export type ReviewPassRewardDecision =
  | { readonly outcome: 'awarded'; readonly ledger: ReviewPassRewardLedger }
  | { readonly outcome: 'already-awarded'; readonly ledger: ReviewPassRewardLedger };

/**
 * Decide whether this review pass may be awarded, and what the ledger becomes.
 *
 * @param extraFields The subject record's preserved fields, as read.
 * @param roomId The room being reviewed.
 * @param passNumber Which full-review pass this review belongs to, one-based.
 * @param awardedAt ISO timestamp for a newly written entry, from the caller's clock.
 */
export function decideReviewPassReward(input: {
  extraFields: Record<string, unknown> | undefined;
  roomId: string;
  passNumber: number;
  awardedAt: string;
}): ReviewPassRewardDecision {
  const ledger = readReviewPassRewardLedgerFromFields(input.extraFields);
  if (hasReviewPassReward(ledger, input.roomId, input.passNumber)) {
    return { outcome: 'already-awarded', ledger };
  }
  return {
    outcome: 'awarded',
    ledger: recordReviewPassReward(ledger, {
      roomId: input.roomId,
      passNumber: input.passNumber,
      reviewIdentity: deriveReviewPassIdentity({ roomId: input.roomId, passNumber: input.passNumber }),
      awardedAt: input.awardedAt,
    }),
  };
}

/**
 * FNV-1a, 32-bit, rendered as eight lowercase hex digits.
 *
 * Chosen because it is a five-line pure function with no import, so the digest is
 * identical in every bundle and in every test. It is a *non-cryptographic*
 * digest on purpose: the identity guards against an accidental duplicate reward,
 * not against an adversary, and nothing about the digest is a secret.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Token separator that cannot occur in a room id or a pass number. */
const IDENTITY_SEPARATOR = '';

/**
 * Derive the identity of a review pass: *which pass of the dungeon was this room
 * reviewed in?*
 *
 * ## Why a pass number and not a raw counter
 *
 * The obvious identity - (room, `reviewPassCount`) - is wrong in the exact case
 * this ledger exists to handle. `reviewPassCount` is incremented by
 * `subjectStore.recordReviewPass`, which is an **async write to the subject
 * store**, so it does not move within the tick that decides the award. Two
 * finalizations of the *same* pass therefore see the *same* counter and must be
 * suppressed, while a genuine *new* pass must be awarded - and those two cases
 * are indistinguishable from the counter alone.
 *
 * The pass number is `summarizeReviewPassProgress(...).fullReviewPasses + 1`
 * computed from the **pre-increment** analytics, which is:
 *
 * - **stable** for every room in one pass, because it is a property of the whole
 *   subject's review totals, not of one room's counter;
 * - **identical across same-tick duplicates**, because both read the same
 *   committed totals;
 * - **different on the next pass**, because the totals grew.
 *
 * That is exactly the semantics plan 5.2 asks for: "review completion is recorded
 * exactly once per room per pass".
 *
 * ## What goes in
 *
 * **App-minted room ids and an integer pass number. Nothing else.** No topic, no
 * note text, no artifact markdown, no artifact id, no subject name. See this
 * module's header on privacy, and `tests/phase16/reviewPassRewards.test.ts` for
 * the test that pins it.
 *
 * ## What it buys
 *
 * - A **reopened panel, a retried close, or a StrictMode double dispatch** all
 *   derive the same pass number from the same committed totals, so the digest is
 *   unchanged and the award is suppressed.
 * - A **reload** reads the same ledger back out of the persisted record, so the
 *   suppression survives the window that used to award twice.
 * - The digest is total: a room id with any content at all still produces a stable
 *   identity rather than throwing.
 */
export function deriveReviewPassIdentity(input: {
  roomId: string;
  passNumber: number;
}): string {
  const passNumber = Number.isFinite(input.passNumber)
    ? Math.max(0, Math.trunc(input.passNumber))
    : 0;
  return `${REVIEW_IDENTITY_PREFIX}${fnv1a32(
    [
      `v${REVIEW_PASS_IDENTITY_VERSION}`,
      `room:${input.roomId}`,
      `pass:${passNumber}`,
    ].join(IDENTITY_SEPARATOR),
  )}`;
}

/**
 * Build the whole identity the ledger and the store both key on.
 *
 * One function so a caller cannot build a `passNumber` and a `reviewIdentity`
 * that disagree - a mismatch would either suppress an award it was not written
 * for or award one twice.
 */
export function toReviewPassRewardIdentity(input: {
  roomId: string;
  passNumber: number;
}): ReviewPassRewardIdentity {
  const passNumber = Number.isFinite(input.passNumber)
    ? Math.max(0, Math.trunc(input.passNumber))
    : 0;
  return {
    roomId: input.roomId,
    passNumber,
    reviewIdentity: deriveReviewPassIdentity({ roomId: input.roomId, passNumber }),
  };
}
