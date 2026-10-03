/**
 * The idempotent room-clear reward ledger.
 *
 * ## The defect this exists for
 *
 * `NoteEditorModal.handleSubmit` called `progressionStore.awardRoomClear` after
 * *any* `submitNote` result with `finalPass`. A valid note could therefore be
 * awarded again by a resubmission, by a React StrictMode double dispatch, or by
 * a retried write, and each of those incremented `roomsCleared`, rolled loot,
 * and re-ran badge unlocks. `collectArtifactNote` was already idempotent per
 * `${dungeonId}:${roomId}`; the clear reward was not.
 *
 * ## Where the ledger lives, and why
 *
 * **Inside the canonical per-subject progression record, in its preserved
 * unknown-app-owned-field carrier (`extraFields`), under the static-vocabulary
 * key `roomClearRewardLedger`.** That location was chosen over three
 * alternatives, and the reasons are the whole point of this module's header:
 *
 * - **Alongside the record in a new storage-v2 store.** Rejected: a new object
 *   store is a data-format change, and it is outside Phase 15's boundary.
 * - **Inside `RoomMetadata` on the subject.** Rejected: subject schema stays
 *   `1.1.0`, and a reward is progression state, not subject-graph state. It
 *   would also put a write on the note path for something the subject snapshot
 *   has no opinion about.
 * - **A separate `localStorage` key beside the progression key.** Rejected: the
 *   production repository is the legacy `localStorage` mirror, and a second key
 *   has no migration, no generation participation, and no backup participation.
 *
 * The chosen location gets every durability requirement for free, because the
 * unknown-field preservation machinery already exists and is already tested:
 *
 * - `savePersistedBySubject` flattens `extraFields` into the legacy record, so
 *   the ledger survives a reload in the **default** (legacy-repository) build,
 *   which is the configuration that actually ships.
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
 * **No canonical-progression version change is needed or made.** The envelope
 * shape (`version` / `bySubject` / `crossSubjectAchievements`) is untouched, the
 * thirteen legacy record keys are untouched, and the field is absent until a
 * caller supplies a clear identity, so every byte-comparison fixture
 * (`tests/migrations/legacyWriteShape.test.ts`,
 * `tests/migrations/qaLegacyByteComparison.test.ts`) is unaffected.
 *
 * ## Why the ledger is the same record as the reward
 *
 * XP, loot, badges, the `roomsCleared` increment, and this ledger are written in
 * one `set` of one record. There is therefore **no partial-reward window**: a
 * failed write persists the reward *and* its guard together or neither, so a
 * later retry can never find a reward without its guard and award it twice.
 * The decision is also a single pure function
 * ({@link decideRoomClearReward}) applied synchronously, which is what makes a
 * *concurrent* double dispatch safe: two calls in the same tick both read the
 * committed state, so the second observes the first's ledger entry.
 *
 * ## Privacy
 *
 * Nothing the learner wrote is ever hashed, keyed, or logged. A ledger entry is
 * a room id (minted by the app), an opaque digest of the room's *graph
 * neighbourhood*, and an injected timestamp. See {@link deriveRoomClearIdentity}.
 */
import type { DungeonMetadata } from '@/core/validation/persistence';

/**
 * The preserved app-owned field the ledger is carried under.
 *
 * Static vocabulary, deliberately not learner-influenced: it is a contract
 * between this module, the canonical normalizer's unknown-field carrier, and any
 * future reader. It is never derived from a room, a note, or a subject.
 */
export const ROOM_CLEAR_REWARD_LEDGER_KEY = 'roomClearRewardLedger';

/**
 * Ledger envelope version.
 *
 * Bumped only if the *shape* of the ledger changes. It is carried so a future
 * reader can refuse an envelope it does not understand rather than silently
 * treating it as empty, which would re-open the duplicate-reward hole.
 */
export const ROOM_CLEAR_REWARD_LEDGER_VERSION = 1;

/**
 * Version tag mixed into every clear-identity digest.
 *
 * Bumped when the identity *rule* changes, so identities minted under the old
 * rule cannot collide with new ones and an old entry is simply never matched
 * again (which is the safe direction: a stale entry cannot suppress a reward it
 * was not written for).
 */
export const ROOM_CLEAR_IDENTITY_VERSION = 1;

/** Prefix every derived identity carries, so it is recognisable in a dump. */
const CLEAR_IDENTITY_PREFIX = 'clear-';

/** One awarded room clear. */
export interface RoomClearRewardEntry {
  /**
   * The cleared room's app-minted id.
   *
   * Never learner content: room ids are minted by the Creator and the tutorial
   * fixture, and are not derived from a topic.
   */
  roomId: string;
  /**
   * The digest of the graph generation the clear was validated in.
   *
   * Opaque by construction: the reader learns nothing from it about the graph,
   * and it is not reversible into room ids or topics.
   */
  clearIdentity: string;
  /** ISO timestamp from the caller's clock. Injected, never read here. */
  awardedAt: string;
}

/** The durable awarded-once ledger for one subject. */
export interface RoomClearRewardLedger {
  version: number;
  /**
   * Awarded clears, newest first.
   *
   * Unbounded on purpose. Each entry is roughly fifty bytes, a subject's rooms
   * are counted in tens, and a generation is minted per graph mutation rather
   * than per submit, so realistic subjects stay in the hundreds of bytes. A cap
   * would be a correctness hole: evicting an entry would let a very old clear
   * award a second time.
   */
  entries: RoomClearRewardEntry[];
}

/** A ledger for a subject that has never awarded a room clear. */
export function emptyRoomClearRewardLedger(): RoomClearRewardLedger {
  return { version: ROOM_CLEAR_REWARD_LEDGER_VERSION, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read a ledger out of any persisted value.
 *
 * Total by construction, because it is called on data this module did not
 * write: a v1/v2/v3 payload, a storage-v2 record, a hand-edited backup, or
 * `undefined`. Anything unrecognized reads as the empty ledger, which is the
 * honest answer ("this subject has no recorded clears") rather than a refusal -
 * a ledger this build cannot read has, from the reward's point of view, never
 * been written.
 */
export function readRoomClearRewardLedger(raw: unknown): RoomClearRewardLedger {
  if (!isRecord(raw)) return emptyRoomClearRewardLedger();
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .filter(isRecord)
        .map((entry) => ({
          roomId: toTrimmedString(entry.roomId),
          clearIdentity: toTrimmedString(entry.clearIdentity),
          awardedAt: toTrimmedString(entry.awardedAt),
        }))
        .filter((entry) => entry.roomId.length > 0 && entry.clearIdentity.length > 0)
    : [];
  return { version: ROOM_CLEAR_REWARD_LEDGER_VERSION, entries };
}

/** Read the ledger a canonical record's preserved fields carry, if any. */
export function readRoomClearRewardLedgerFromFields(
  extraFields: Record<string, unknown> | undefined,
): RoomClearRewardLedger {
  if (!extraFields) return emptyRoomClearRewardLedger();
  return readRoomClearRewardLedger(extraFields[ROOM_CLEAR_REWARD_LEDGER_KEY]);
}

/**
 * Return the preserved fields with `ledger` written under the ledger key.
 *
 * Every other preserved field is carried through untouched, so the ledger
 * cannot cost the device an unknown app-owned field written by a later phase.
 */
export function writeRoomClearRewardLedgerToFields(
  extraFields: Record<string, unknown> | undefined,
  ledger: RoomClearRewardLedger,
): Record<string, unknown> {
  return { ...(extraFields ?? {}), [ROOM_CLEAR_REWARD_LEDGER_KEY]: ledger };
}

/** Whether this exact (room, clear generation) has already been awarded. */
export function hasRoomClearReward(
  ledger: RoomClearRewardLedger,
  roomId: string,
  clearIdentity: string,
): boolean {
  return ledger.entries.some(
    (entry) => entry.roomId === roomId && entry.clearIdentity === clearIdentity,
  );
}

/** The most recent entry for a room, or `null` when it has never been awarded. */
export function latestRoomClearRewardForRoom(
  ledger: RoomClearRewardLedger,
  roomId: string,
): RoomClearRewardEntry | null {
  return ledger.entries.find((entry) => entry.roomId === roomId) ?? null;
}

/**
 * Append a clear to the ledger, newest first.
 *
 * Idempotent for a repeated (room, clear identity): replaying the same entry is
 * a no-op rather than a duplicate, so a retry that re-derives the same decision
 * cannot grow the ledger.
 */
export function recordRoomClearReward(
  ledger: RoomClearRewardLedger,
  entry: RoomClearRewardEntry,
): RoomClearRewardLedger {
  if (hasRoomClearReward(ledger, entry.roomId, entry.clearIdentity)) return ledger;
  return { version: ROOM_CLEAR_REWARD_LEDGER_VERSION, entries: [entry, ...ledger.entries] };
}

/**
 * The whole award-or-suppress decision, as one pure function.
 *
 * Returning the *next* ledger (rather than a boolean) is what makes the caller a
 * single synchronous read-modify-write: there is no window between deciding and
 * writing, so two calls in the same tick cannot both decide to award.
 */
export type RoomClearRewardDecision =
  | { readonly outcome: 'awarded'; readonly ledger: RoomClearRewardLedger }
  | { readonly outcome: 'already-awarded'; readonly ledger: RoomClearRewardLedger };

/**
 * Decide whether this clear may be awarded, and what the ledger becomes.
 *
 * @param extraFields The subject record's preserved fields, as read.
 * @param roomId The room being cleared.
 * @param clearIdentity The digest of the generation the clear was validated in.
 * @param awardedAt ISO timestamp for a newly written entry, from the caller's clock.
 */
export function decideRoomClearReward(input: {
  extraFields: Record<string, unknown> | undefined;
  roomId: string;
  clearIdentity: string;
  awardedAt: string;
}): RoomClearRewardDecision {
  const ledger = readRoomClearRewardLedgerFromFields(input.extraFields);
  if (hasRoomClearReward(ledger, input.roomId, input.clearIdentity)) {
    return { outcome: 'already-awarded', ledger };
  }
  return {
    outcome: 'awarded',
    ledger: recordRoomClearReward(ledger, {
      roomId: input.roomId,
      clearIdentity: input.clearIdentity,
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

/** Token separator that cannot occur in a room id or a relation type. */
const IDENTITY_SEPARATOR = '';

/**
 * Derive the identity of a clear: *which generation of the graph was this note
 * validated against?*
 *
 * ## What goes in
 *
 * The room id, the room's direct neighbours, and every edge incident to the
 * room **or to one of its neighbours**. That is exactly the set
 * `propagateRevalidationAfterGraphMutation` can reach: it seeds
 * `impactedRoomIds` with the touched rooms and then adds the edge neighbours of
 * those, so anything outside this window cannot mark this room
 * `NeedsRevalidation`.
 *
 * Only app-minted room ids and the static `relationType` vocabulary go in.
 * **No topic, no note text, no artifact markdown** - see this module's header on
 * privacy, and `tests/unit/roomClearRewards.test.ts` for the test that pins it.
 *
 * ## What it buys
 *
 * - A **resubmission of a still-valid note** sees an unchanged graph, so the
 *   digest is unchanged and the award is suppressed.
 * - A **double dispatch** (StrictMode, a double click, two concurrent submits)
 *   also sees an unchanged graph, and is suppressed for the same reason.
 * - A **graph change that invalidated the note** changes the window's edges, so
 *   the learner's re-write is a *new* identity and is awarded again. The room id
 *   alone would not do this; the "clear generation" half is what makes the
 *   ledger per (room, valid clear) rather than per room.
 *
 * The digest is total: a room id the dungeon does not list still produces a
 * stable identity rather than throwing, because a view model may ask about a
 * room that has just been removed.
 */
export function deriveRoomClearIdentity(input: {
  roomId: string;
  dungeon: DungeonMetadata;
}): string {
  const { roomId, dungeon } = input;
  const listed = dungeon.rooms.some((room) => room.roomId === roomId);
  if (!listed) {
    return `${CLEAR_IDENTITY_PREFIX}${fnv1a32(
      [`v${ROOM_CLEAR_IDENTITY_VERSION}`, 'unlisted', roomId].join(IDENTITY_SEPARATOR),
    )}`;
  }

  const neighbours = new Set<string>();
  for (const edge of dungeon.edges) {
    if (edge.fromRoomId === roomId) neighbours.add(edge.toRoomId);
    if (edge.toRoomId === roomId) neighbours.add(edge.fromRoomId);
  }

  // The window: the room, its neighbours, and every edge touching either.
  const window = new Set<string>([roomId, ...neighbours]);
  const tokens: string[] = [`v${ROOM_CLEAR_IDENTITY_VERSION}`, `room:${roomId}`];
  for (const id of [...window].sort()) {
    tokens.push(`context:${id}`);
  }
  const edgeTokens = dungeon.edges
    .filter((edge) => window.has(edge.fromRoomId) || window.has(edge.toRoomId))
    .map((edge) => `${edge.fromRoomId}>${edge.toRoomId}:${edge.relationType}`)
    .sort();
  for (const token of edgeTokens) {
    tokens.push(`edge:${token}`);
  }

  return `${CLEAR_IDENTITY_PREFIX}${fnv1a32(tokens.join(IDENTITY_SEPARATOR))}`;
}