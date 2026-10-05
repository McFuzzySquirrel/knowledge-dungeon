/**
 * The centralized, idempotent statistics-event ledger.
 *
 * ## The defect this exists for
 *
 * Plan 5.3 lists "session tracking functions are not wired into real gameplay", and
 * that was the visible half. The invisible half is worse: **every statistic the
 * dashboard shows was structurally always zero.** `startSession`,
 * `trackRoomVisit`, `trackNoteSubmission`, `trackReviewCompletion`, and
 * `trackXpEarned` each began `if (!currentSession) return;` and **nothing in the
 * application ever set `currentSession`** - `startSession` had no production caller
 * at all. So `computeSessionStats` read an empty list and reported zero study
 * minutes, zero rooms, zero notes, zero reviews, and zero XP, forever, no matter what
 * the learner did.
 *
 * A second defect sat underneath: the counters were plain `+= 1`. Phases 15, 16, and
 * 17 each made the *reward* for a note, a review, and a catch exactly-once with a
 * durable ledger, and none of them touched the counters. So even once a session
 * existed, a StrictMode double dispatch would have counted two notes where one
 * reward was paid, and a retried close would have counted two reviews - the
 * statistics would have disagreed with the progression record that pays for it.
 *
 * ## What this ledger is, and what it is not
 *
 * It is a **record of things that happened exactly once**, keyed by an identity
 * derived deterministically from the components of the thing itself, stored in the
 * per-subject progression record's preserved app-owned-field carrier
 * (`extraFields`) under the static key `statisticsEventLedger`.
 *
 * It is **not** a second copy of the reward ledgers. Every event identity here is
 * *derived from* the identity the corresponding reward already uses - the room-clear
 * identity, the review-pass identity, or the catch identity - so:
 *
 * - there is no way for the statistic and the reward to disagree about whether
 *   something happened once or twice;
 * - the event is written in the **same `set` of one record** as the reward and its
 *   guard, so there is no partial-write window in which a reward exists with no
 *   statistic or a statistic exists with no reward;
 * - the ledger's growth is bounded by the reward ledgers' growth, which is the
 *   property that makes it safe to keep unbounded (see below).
 *
 * Room visits are the one kind that is **not** in this ledger, and the reason is
 * worth stating because it is a deliberate rejection of the obvious design. A room
 * visit is a *set membership*, not an award: the session record already carries
 * `roomsVisited` as a per-session de-duplicated array, that array is already in both
 * backup products and the storage-v2 generation, and adding a durable ledger entry
 * per room entry would mean one whole-progression-record write every time the player
 * walks into a room - a write whose size grows with the learner's fish collection and
 * inventory, for a fact that is already stored once per session. See
 * `src/application/sessionLifecycle.ts` for how a room visit is recorded instead.
 *
 * ## Where the ledger lives, and why
 *
 * **Inside the canonical per-subject progression record, in `extraFields`, under the
 * static-vocabulary key `statisticsEventLedger`.** The same carrier
 * `roomClearRewardLedger`, `reviewPassRewardLedger`, `catchRewardLedger`, and
 * `interruptedReviewSession` already use, for the same reasons, all of which are
 * documented on those modules and are not repeated in full here - with one addition
 * that is specific to this ledger:
 *
 * - `savePersistedBySubject` flattens `extraFields` into the legacy `localStorage`
 *   record, so the ledger survives a reload in the **default** (legacy-repository)
 *   build, which is the configuration that ships.
 * - `publishProgressionToActiveGeneration` writes the whole normalized canonical
 *   record, `extraFields` included, so storage-v2 carries it too.
 * - `validateProgressionRecord` requires only that the record normalize, and the
 *   normalizer is total, so no validation change is needed.
 * - Both backup products carry progression records verbatim, so a `.kdbak` and a
 *   `.kdsubject` carry the events with no archive change at all. The blank
 *   `.kdtemplate` product carries graph structure only and therefore correctly does
 *   **not** carry the ledger.
 * - A subject-copy import rewrites the whole `bySubject` subtree, so a copy carries
 *   the counted-once history of the subject it was copied from.
 *
 * The rejected alternatives are the three the other ledgers reject: a new
 * storage-v2 store (a data-format change, and Phase 18 is not a format change - the
 * statistics ride records that already exist), a field on the subject snapshot
 * (schema stays `1.1.0`, and `withRooms` rebuilds every snapshot as
 * `{ dungeon, rooms }` so an unknown top-level key would not survive the next room
 * write), and a separate `localStorage` key (no generation participation, no backup
 * participation, so the suppression would not survive the reload window it exists to
 * cover).
 *
 * **No canonical-progression version change is needed or made.** The envelope shape
 * (`version` / `bySubject` / `crossSubjectAchievements`) is untouched, the thirteen
 * legacy record keys are untouched, and the field is absent until a caller records an
 * event, so every byte-comparison fixture is unaffected.
 *
 * ## Why the ledger is unbounded
 *
 * Because one event is recorded **only** when the corresponding reward was awarded,
 * and the reward ledgers are themselves unbounded for the same reason
 * (`src/core/progression/roomClearRewards.ts` argues it at length): evicting an entry
 * would let a very old note, review, or catch be counted - and paid - a second time. A
 * cap would therefore be a correctness hole, not a storage optimisation. The growth is
 * bounded in practice by exactly the reward ledgers' growth, and by the fact that a
 * declined catch records nothing here at all.
 *
 * ## Privacy
 *
 * Nothing the learner wrote is ever hashed, keyed, or logged. Every identity input is
 * an app-minted id (a subject, a room, a pass number, a catalogue id, a context id, a
 * cast number) or a non-negative amount of XP. No topic, no subject name, no note text,
 * no artifact markdown, and no free text of any kind enters a digest or a stored field.
 * `localDateKey` is a calendar date and nothing else.
 */

/**
 * The preserved app-owned field the ledger is carried under.
 *
 * Static vocabulary, deliberately not learner-influenced: it is a contract between
 * this module, the canonical normalizer's unknown-field carrier, and any future reader.
 */
export const STATISTICS_EVENT_LEDGER_KEY = 'statisticsEventLedger';

/** Ledger envelope version. Bumped only if the *shape* changes. */
export const STATISTICS_EVENT_LEDGER_VERSION = 1;

/**
 * Version tag mixed into every event identity digest.
 *
 * Bumped when the identity *rule* changes, so identities minted under the old rule
 * cannot collide with new ones and an old entry is simply never matched again - the
 * safe direction, because a stale entry cannot suppress a count it was not written
 * for.
 */
export const STATISTICS_EVENT_IDENTITY_VERSION = 1;

/** Prefix every derived event identity carries, so it is recognisable in a dump. */
const EVENT_IDENTITY_PREFIX = 'sevt-';

/**
 * The kinds of thing a statistics event records.
 *
 * A closed set, and deliberately not extensible at the call site: a surface that
 * wanted to record "opened the statistics panel" would have to add a member here, and
 * adding one is a reviewable change to a persisted vocabulary rather than a
 * convenience.
 */
export type StatisticsEventKind =
  /** A note submission that validated and cleared its room. */
  | 'note-submission'
  /** A completed full-review pass for a room. */
  | 'review-completion'
  /** An XP award, carrying the amount and the event that paid for it. */
  | 'xp-award'
  /** A kept fishing catch. Declined outcomes record nothing here. */
  | 'fishing-outcome';

/** Where an XP award came from. Mirrors the three award sites. */
export type StatisticsXpSource = 'note-submission' | 'review-completion' | 'fishing-outcome';

/** The identity of a note submission, as the reward site already computed it. */
export interface NoteSubmissionEventIdentity {
  /** The cleared room's app-minted id. */
  readonly roomId: string;
  /**
   * A digest naming *which submission of this room* this is, supplied by the award site.
   *
   * Either rule may mint it: `deriveRoomClearIdentity`'s per-graph-generation digest where the
   * caller knows the graph, or {@link deriveNoteSubmissionSourceIdentity}'s room-only digest where
   * it does not. The event never re-derives it and never reads it back - it is hashed into the
   * event id, and the id is the counted-once key. The stored event carries `roomId`, not this
   * digest, so widening what a caller may pass here cannot invalidate a persisted event.
   */
  readonly clearIdentity: string;
}

/** The identity of a review completion, as the reward site already computed it. */
export interface ReviewCompletionEventIdentity {
  /** The reviewed room's app-minted id. */
  readonly roomId: string;
  /** Which full-review pass this completion belongs to, one-based. */
  readonly passNumber: number;
  /** {@link deriveReviewPassIdentity}'s digest for the two fields above. */
  readonly reviewIdentity: string;
}

/** The identity of a kept catch, as the reward site already computed it. */
export interface FishingOutcomeEventIdentity {
  /** The catalogue id of the species caught. */
  readonly catalogId: string;
  /** The pond visit the cast belonged to. */
  readonly contextId: string;
  /** Which cast in that pond visit this was, one-based. */
  readonly castNumber: number;
  /** {@link deriveCatchIdentity}'s digest for the three fields above. */
  readonly catchIdentity: string;
}

/** One recorded statistics event. Discriminated by `kind`. */
export type StatisticsEvent =
  | StatisticsXpAwardEvent
  | StatisticsNoteSubmissionEvent
  | StatisticsReviewCompletionEvent
  | StatisticsFishingOutcomeEvent;

interface StatisticsEventBase {
  /** The deterministic identity digest. See {@link deriveStatisticsEventId}. */
  readonly eventId: string;
  /**
   * The local calendar day the event was recorded on.
   *
   * A local key, not a UTC one, so "which day did the learner do this" answers the
   * question the learner would answer. See `src/core/statistics/localCalendar.ts`.
   */
  readonly localDate: string;
  /** ISO timestamp from the caller's clock. Injected, never read here. */
  readonly recordedAt: string;
}

/** A note submission that validated and cleared its room. */
export interface StatisticsNoteSubmissionEvent extends StatisticsEventBase {
  readonly kind: 'note-submission';
  /** The cleared room's app-minted id. */
  readonly roomId: string;
  /** XP this submission paid, as an absolute amount. Never negative. */
  readonly xpAwarded: number;
}

/** A completed full-review pass. */
export interface StatisticsReviewCompletionEvent extends StatisticsEventBase {
  readonly kind: 'review-completion';
  /** The reviewed room's app-minted id. */
  readonly roomId: string;
  /** The full-review pass this completion belonged to, one-based. */
  readonly passNumber: number;
  /** XP this completion paid, as an absolute amount. Never negative. */
  readonly xpAwarded: number;
}

/** A kept fishing catch. */
export interface StatisticsFishingOutcomeEvent extends StatisticsEventBase {
  readonly kind: 'fishing-outcome';
  /** The catalogue id of the species caught. Never a display name. */
  readonly catalogId: string;
  /** The pond visit the cast belonged to. */
  readonly contextId: string;
  /** Which cast in that pond visit this was, one-based. */
  readonly castNumber: number;
  /** XP this catch paid, as an absolute amount. Never negative. */
  readonly xpAwarded: number;
}

/** An XP award, carrying the amount and the event that paid for it. */
export interface StatisticsXpAwardEvent extends StatisticsEventBase {
  readonly kind: 'xp-award';
  /** Which award paid this XP. */
  readonly source: StatisticsXpSource;
  /** Absolute XP. Never negative, and 0 is permitted for an award that paid nothing. */
  readonly amount: number;
}

/** The durable counted-once ledger for one subject. */
export interface StatisticsEventLedger {
  readonly version: number;
  /** Recorded events, newest first. Unbounded; see the module header. */
  readonly events: readonly StatisticsEvent[];
}

/** A ledger for a subject that has recorded nothing. */
export function emptyStatisticsEventLedger(): StatisticsEventLedger {
  return { version: STATISTICS_EVENT_LEDGER_VERSION, events: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function toPositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : 0;
}

const EVENT_KINDS: readonly StatisticsEventKind[] = [
  'note-submission',
  'review-completion',
  'fishing-outcome',
  'xp-award',
];

function isEventKind(value: unknown): value is StatisticsEventKind {
  return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * FNV-1a, 32-bit, rendered as eight lowercase hex digits.
 *
 * Five lines of pure function with no import, so the digest is identical in every
 * bundle and in every test - the same choice, and for the same reason, as
 * `fnv1a32` in `roomClearRewards.ts` and `reviewPassRewards.ts`. It is
 * *non-cryptographic* on purpose: the identity guards against an accidental double
 * count, not against an adversary, and nothing about the digest is a secret.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Token separator that cannot occur in a component.
 *
 * The components are app-minted ids and integers, none of which can contain a
 * newline, so the tokens cannot run together and two different identities cannot
 * produce the same token list.
 */
const IDENTITY_SEPARATOR = '\n';

/**
 * Derive a statistics event's identity from the identity of the award it describes.
 *
 * ## Why the award's identity and not something of its own
 *
 * If this minted a fresh identity - a timestamp, a counter, a `Math.random` suffix -
 * then the statistic and the reward would be two independent answers to "did this
 * happen once", and they could differ: a retried write could pay once and record
 * twice, or record once and pay twice. Deriving from the reward's identity makes the
 * question unanswerable, because there is only one identity for "this note, in this
 * graph generation".
 *
 * ## What goes in
 *
 * App-minted identifiers and integers only: the event kind, the subject id, and the
 * components of the identity the award site already computed. **No topic, no note
 * text, no artifact markdown, no subject name, no free text.** For an XP award the
 * components are the paying event's own identity, so the XP event is suppressed by
 * exactly the same rule as the event that caused it.
 *
 * ## Why it is total
 *
 * Every component is coerced to a trimmed string or a non-negative integer, so a
 * caller that passes an unusable component gets a stable identity rather than an
 * exception, and the ledger records something countable instead of losing the count.
 */
export function deriveStatisticsEventId(input: {
  readonly kind: StatisticsEventKind;
  readonly subjectId: string;
  readonly sourceIdentity: readonly string[];
}): string {
  const tokens = [
    `v${STATISTICS_EVENT_IDENTITY_VERSION}`,
    `kind:${input.kind}`,
    `subject:${input.subjectId}`,
    ...input.sourceIdentity.map((token) => `id:${token}`),
  ];
  return `${EVENT_IDENTITY_PREFIX}${fnv1a32(tokens.join(IDENTITY_SEPARATOR))}`;
}

/** The identity components for a note-submission event. */
export function noteSubmissionEventSourceIdentity(
  identity: NoteSubmissionEventIdentity,
): readonly string[] {
  return [`room:${identity.roomId}`, `clear:${identity.clearIdentity}`];
}

/**
 * Prefix a lane-scoped note-submission identity carries.
 *
 * Distinct from `deriveRoomClearIdentity`'s `clear-` prefix on purpose, and the reason is not
 * tidiness: a dump of a subject's preserved fields then says which rule minted a given identity,
 * and the two key spaces provably cannot collide even if a future caller passed a room id where a
 * clear identity was expected.
 */
const NOTE_SUBMISSION_SOURCE_IDENTITY_PREFIX = 'csub-';

/**
 * Version tag mixed into every lane-scoped note-submission identity digest.
 *
 * The same contract as `ROOM_CLEAR_IDENTITY_VERSION` in `@/core/progression/roomClearRewards`, and
 * deliberately a separate constant: the two rules mint identities for different reasons and must be
 * free to version independently.
 */
export const NOTE_SUBMISSION_SOURCE_IDENTITY_VERSION = 1;

/**
 * Derive the identity of a note submission for a lane that knows the room but **not** the graph.
 *
 * Phase 18. `deriveRoomClearIdentity` is the better identity, and where it can be computed it must
 * be: it distinguishes "the same note submitted again" from "a new clear after the graph changed".
 * But it needs `DungeonMetadata`, and the **default production artifact**'s submit path does not
 * hand a graph to the reward site. Asking `NoteEditorModal` to derive the same digest would mean a
 * second implementation of a domain decision inside a React component, free to drift from the
 * command lane's - and a drifted digest does not fail loudly, it pays twice. So this rule is
 * weaker on purpose: the room is the only fact that lane has, and a room pays once per subject.
 *
 * ## Why it lives here and not beside `deriveRoomClearIdentity`
 *
 * It is the same kind of value, and the natural home would be `@/core/progression/roomClearRewards`.
 * That module is frozen byte-identical by Phase 17's carrier gate
 * (`tests/phase17/fishingPhaseInvariants.test.ts`), and a Phase 18 identity is not a licence to
 * unfreeze another phase's carrier. It also belongs here on its own terms: it answers "under what
 * identity is this submission counted", which is this module's question, and it is only ever used to
 * fill {@link NoteSubmissionEventIdentity}'s source slot.
 *
 * ## What each component earns
 *
 * - `v1` - so a future change to the rule mints a different digest and cannot collide with these
 *   entries. A stale entry then never matches a new submission, which is the safe direction: it
 *   cannot suppress a submission it was not written for.
 * - `room:${roomId}` - the whole fact. **Not** the subject: {@link deriveStatisticsEventId} already
 *   carries `subject:${subjectId}`, so repeating it here would buy nothing.
 * - the `csub-` prefix - recognisability in a dump, and a key space that provably cannot overlap
 *   the `clear-` one.
 *
 * The separator is a newline, which cannot occur inside a room id. (`deriveRoomClearIdentity`
 * joins with an empty string; that separator is frozen along with the digests already persisted
 * against it, and changing it would re-key every clear ever awarded and pay those rooms twice.)
 *
 * ## What it deliberately does not do
 *
 * It does not make a re-clear after a graph edit payable a second time. That is the trade this lane
 * takes, and it is the safe direction: a lane that under-pays is a reporting question, whereas a
 * lane that re-pays is the duplicate-reward defect Phase 15 was written to close. The command lane
 * keeps the per-generation behaviour.
 *
 * ## Why it returns `null` for a value that names no room
 *
 * A digest is not a validation. `''` and `'   '` are two different strings, so hashing
 * `room:${roomId}` without looking at it mints **two distinct, payable identities** for one
 * non-existent room - each counted, each paid. Trimming first would not help either: it would mint
 * *one* payable identity for a value that still names nothing, and the caller would have no way to
 * tell that the identity is vacuous.
 *
 * So the question is asked here, once, where the identity is minted, and the answer is `null`:
 * "there is no identity for this". Every caller inherits the rule, including a future one, and the
 * store routes `null` to the same uncounted lane an absent `roomId` takes - which is what
 * `roomId: undefined` already did.
 *
 * Blankness uses the same {@link toTrimmedString} semantics as {@link readStatisticsEventLedger}, so
 * "the reader would drop it" and "the derivation refuses it" are one rule rather than two that can
 * disagree. A **padded** id (`' room-1 '`) is *not* normalised: it is a different string, it gets a
 * different identity, and silently folding it into `'room-1'` would merge two ids on the strength of
 * a guess about which one the caller meant.
 *
 * ## Privacy
 *
 * An app-minted room id. No topic, no note text, no artifact markdown.
 */
export function deriveNoteSubmissionSourceIdentity(input: {
  readonly roomId: string;
}): string | null {
  const roomId = toTrimmedString(input.roomId);
  if (roomId.length === 0) return null;
  return `${NOTE_SUBMISSION_SOURCE_IDENTITY_PREFIX}${fnv1a32(
    [
      `v${NOTE_SUBMISSION_SOURCE_IDENTITY_VERSION}`,
      // The **raw** id, not the trimmed one, so the digest is a function of exactly what the caller
      // passed. The trim above is a blankness test, not a canonicalisation rule.
      `room:${input.roomId}`,
    ].join('\n'),
  )}`;
}

/**
 * The id a note submission *will* be recorded under - derivable before its XP is known.
 *
 * A reward site has to decide whether to pay **before** it computes what the award is worth,
 * because a suppressed award must roll no loot and write nothing. That is the whole point of
 * taking the awarded-once check first, and it is why this function exists separately from
 * {@link toNoteSubmissionEvent}: the event carries an `xpAwarded` the site cannot know yet, while
 * its identity depends only on facts it already has.
 *
 * Both go through {@link deriveStatisticsEventId} with the same kind and the same source
 * identity, so the id computed here is by construction the id the event ends up carrying.
 */
export function noteSubmissionEventId(input: {
  readonly subjectId: string;
  readonly identity: NoteSubmissionEventIdentity;
}): string {
  return deriveStatisticsEventId({
    kind: 'note-submission',
    subjectId: input.subjectId,
    sourceIdentity: noteSubmissionEventSourceIdentity(input.identity),
  });
}

/** The identity components for a review-completion event. */
export function reviewCompletionEventSourceIdentity(
  identity: ReviewCompletionEventIdentity,
): readonly string[] {
  return [
    `room:${identity.roomId}`,
    `pass:${toPositiveInteger(identity.passNumber)}`,
    `review:${identity.reviewIdentity}`,
  ];
}

/** The identity components for a fishing-outcome event. */
export function fishingOutcomeEventSourceIdentity(
  identity: FishingOutcomeEventIdentity,
): readonly string[] {
  return [
    `catalog:${identity.catalogId}`,
    `context:${identity.contextId}`,
    `cast:${toPositiveInteger(identity.castNumber)}`,
    `catch:${identity.catchIdentity}`,
  ];
}

/**
 * Read a ledger out of any persisted value.
 *
 * Total by construction, because it is called on data this module did not write: a
 * v1/v2/v3 progression payload, a storage-v2 record, a restored backup, or
 * `undefined`. An unrecognized envelope reads as the empty ledger, which is the honest
 * answer ("nothing has been counted") rather than a refusal - a ledger this build
 * cannot read has, from the counting point of view, never been written.
 *
 * An entry whose `eventId` is unusable is **dropped**, because an entry that cannot
 * be matched suppresses nothing and would grow the ledger with rows that count
 * nothing. This is also the hardening that matters for restored input: the
 * pre-Phase-18 session reader accepted any object with a string `sessionId`, so a
 * hand-edited `.kdbak` could put arbitrary values where numbers are expected.
 */
export function readStatisticsEventLedger(raw: unknown): StatisticsEventLedger {
  if (!isRecord(raw)) return emptyStatisticsEventLedger();
  const entries = Array.isArray(raw.events) ? raw.events.filter(isRecord) : [];
  const events: StatisticsEvent[] = [];
  for (const entry of entries) {
    const eventId = toTrimmedString(entry.eventId);
    const localDate = toTrimmedString(entry.localDate);
    if (eventId.length === 0 || localDate.length === 0) continue;
    if (!isEventKind(entry.kind)) continue;
    const recordedAt = toTrimmedString(entry.recordedAt);
    const base = { eventId, localDate, recordedAt };
    if (entry.kind === 'note-submission') {
      const roomId = toTrimmedString(entry.roomId);
      if (roomId.length === 0) continue;
      events.push({ ...base, kind: 'note-submission', roomId, xpAwarded: toNonNegativeInteger(entry.xpAwarded) });
      continue;
    }
    if (entry.kind === 'review-completion') {
      const roomId = toTrimmedString(entry.roomId);
      const passNumber = toPositiveInteger(entry.passNumber);
      if (roomId.length === 0 || passNumber === 0) continue;
      events.push({
        ...base,
        kind: 'review-completion',
        roomId,
        passNumber,
        xpAwarded: toNonNegativeInteger(entry.xpAwarded),
      });
      continue;
    }
    if (entry.kind === 'fishing-outcome') {
      const catalogId = toTrimmedString(entry.catalogId);
      const contextId = toTrimmedString(entry.contextId);
      const castNumber = toPositiveInteger(entry.castNumber);
      if (catalogId.length === 0 || contextId.length === 0 || castNumber === 0) continue;
      events.push({
        ...base,
        kind: 'fishing-outcome',
        catalogId,
        contextId,
        castNumber,
        xpAwarded: toNonNegativeInteger(entry.xpAwarded),
      });
      continue;
    }
    const source = entry.source;
    if (source !== 'note-submission' && source !== 'review-completion' && source !== 'fishing-outcome') {
      continue;
    }
    events.push({ ...base, kind: 'xp-award', source, amount: toNonNegativeInteger(entry.amount) });
  }
  return { version: STATISTICS_EVENT_LEDGER_VERSION, events };
}

/** Read the ledger a canonical record's preserved fields carry, if any. */
export function readStatisticsEventLedgerFromFields(
  extraFields: Record<string, unknown> | undefined,
): StatisticsEventLedger {
  if (!extraFields) return emptyStatisticsEventLedger();
  return readStatisticsEventLedger(extraFields[STATISTICS_EVENT_LEDGER_KEY]);
}

/**
 * Return the preserved fields with `ledger` written under the ledger key.
 *
 * Every other preserved field is carried through untouched, so this ledger cannot cost
 * the device the room-clear ledger, the review-pass ledger, the catch ledger, the
 * interrupted-review marker, or any unknown app-owned field a later phase writes.
 */
export function writeStatisticsEventLedgerToFields(
  extraFields: Record<string, unknown> | undefined,
  ledger: StatisticsEventLedger,
): Record<string, unknown> {
  return { ...(extraFields ?? {}), [STATISTICS_EVENT_LEDGER_KEY]: ledger };
}

/** Whether an event with this exact identity has already been recorded. */
export function hasStatisticsEvent(ledger: StatisticsEventLedger, eventId: string): boolean {
  return ledger.events.some((event) => event.eventId === eventId);
}

/**
 * Append an event to the ledger, newest first.
 *
 * Idempotent for a repeated identity: replaying the same event is a no-op rather than
 * a duplicate, so a retry that re-derives the same decision cannot grow the ledger.
 */
export function recordStatisticsEvent(
  ledger: StatisticsEventLedger,
  event: StatisticsEvent,
): StatisticsEventLedger {
  if (hasStatisticsEvent(ledger, event.eventId)) return ledger;
  return { version: STATISTICS_EVENT_LEDGER_VERSION, events: [event, ...ledger.events] };
}

/**
 * The whole record-or-suppress decision, as one pure function.
 *
 * Returning the *next* ledger (rather than a boolean) is what makes the caller a
 * single synchronous read-modify-write: there is no window between deciding and
 * writing, so two calls in the same tick cannot both decide to record.
 */
export type StatisticsEventDecision =
  | { readonly outcome: 'recorded'; readonly ledger: StatisticsEventLedger }
  | { readonly outcome: 'already-recorded'; readonly ledger: StatisticsEventLedger };

/**
 * Decide whether an event may be recorded, and what the ledger becomes.
 *
 * @param extraFields The subject record's preserved fields, as read.
 * @param event The event to record. Its `eventId` is the identity.
 */
export function decideStatisticsEvent(input: {
  readonly extraFields: Record<string, unknown> | undefined;
  readonly event: StatisticsEvent;
}): StatisticsEventDecision {
  const ledger = readStatisticsEventLedgerFromFields(input.extraFields);
  if (hasStatisticsEvent(ledger, input.event.eventId)) {
    return { outcome: 'already-recorded', ledger };
  }
  return { outcome: 'recorded', ledger: recordStatisticsEvent(ledger, input.event) };
}

/**
 * Whether this exact note submission has already been recorded - and therefore already paid.
 *
 * ## Why the count is the guard
 *
 * Phase 18 found the shipped lane awarding room-clear progression with **no** durable
 * awarded-once check: the default artifact's submit path carries no clear identity, so plan
 * §5.3's "a valid note can be resubmitted and award room-clear progression again" was still open
 * there, and supplying an identity without a guard would have fixed the missing statistics by
 * re-opening the double count.
 *
 * The statistics event ledger is therefore the awarded-once ledger, not a copy of one beside it.
 * "This note submission was counted" and "this submission was paid" become the same fact, read and
 * written in the same record as the XP - so there is no window in which a retry can find a
 * recorded event whose award was rolled back, or an awarded XP with no count beside it.
 *
 * ## `release`, not `duplicate`
 *
 * The suppressed branch names itself {@link NoteSubmissionAwardDecision}, and the store reports it
 * as its established `duplicate: true`. Same shape as {@link decideRoomClearReward} and
 * {@link decideStatisticsEvent}, so a caller that already handles a duplicate clear handles this.
 *
 * @param extraFields The subject record's preserved fields, as read.
 * @param identity The room and clear identity the award is being decided under. The caller
 *   supplies it; nothing here re-derives it.
 */
export function decideNoteSubmission(input: {
  readonly extraFields: Record<string, unknown> | undefined;
  readonly subjectId: string;
  readonly identity: NoteSubmissionEventIdentity;
}): NoteSubmissionAwardDecision {
  const eventId = noteSubmissionEventId({ subjectId: input.subjectId, identity: input.identity });
  const ledger = readStatisticsEventLedgerFromFields(input.extraFields);
  return hasStatisticsEvent(ledger, eventId)
    ? { outcome: 'already-recorded', eventId }
    : { outcome: 'record', eventId };
}

/**
 * The whole record-or-release decision for a note submission, as one pure value.
 *
 * No `ledger` member, unlike {@link StatisticsEventDecision}: the guard is asked *before* the
 * award is computed, so there is nothing to hand back to write yet. The write happens later,
 * through {@link decideStatisticsEvent}, against the same identity.
 */
export type NoteSubmissionAwardDecision =
  | { readonly outcome: 'record'; readonly eventId: string }
  | { readonly outcome: 'already-recorded'; readonly eventId: string };

// ── Event constructors ─────────────────────────────────────────────────────
//
// One function per kind, so a caller cannot build an event whose `eventId` was
// derived from components the event itself does not carry. That mismatch is the
// failure mode {@link deriveStatisticsEventId} exists to prevent, and these
// constructors are where it is prevented rather than merely documented.

/** Build a note-submission event. */
export function toNoteSubmissionEvent(input: {
  readonly subjectId: string;
  readonly identity: NoteSubmissionEventIdentity;
  readonly localDate: string;
  readonly recordedAt: string;
  readonly xpAwarded: number;
}): StatisticsNoteSubmissionEvent {
  return {
    kind: 'note-submission',
    eventId: deriveStatisticsEventId({
      kind: 'note-submission',
      subjectId: input.subjectId,
      sourceIdentity: noteSubmissionEventSourceIdentity(input.identity),
    }),
    localDate: input.localDate,
    recordedAt: input.recordedAt,
    roomId: input.identity.roomId,
    xpAwarded: toNonNegativeInteger(input.xpAwarded),
  };
}

/** Build a review-completion event. */
export function toReviewCompletionEvent(input: {
  readonly subjectId: string;
  readonly identity: ReviewCompletionEventIdentity;
  readonly localDate: string;
  readonly recordedAt: string;
  readonly xpAwarded: number;
}): StatisticsReviewCompletionEvent {
  return {
    kind: 'review-completion',
    eventId: deriveStatisticsEventId({
      kind: 'review-completion',
      subjectId: input.subjectId,
      sourceIdentity: reviewCompletionEventSourceIdentity(input.identity),
    }),
    localDate: input.localDate,
    recordedAt: input.recordedAt,
    roomId: input.identity.roomId,
    passNumber: toPositiveInteger(input.identity.passNumber),
    xpAwarded: toNonNegativeInteger(input.xpAwarded),
  };
}

/** Build a fishing-outcome event. */
export function toFishingOutcomeEvent(input: {
  readonly subjectId: string;
  readonly identity: FishingOutcomeEventIdentity;
  readonly localDate: string;
  readonly recordedAt: string;
  readonly xpAwarded: number;
}): StatisticsFishingOutcomeEvent {
  return {
    kind: 'fishing-outcome',
    eventId: deriveStatisticsEventId({
      kind: 'fishing-outcome',
      subjectId: input.subjectId,
      sourceIdentity: fishingOutcomeEventSourceIdentity(input.identity),
    }),
    localDate: input.localDate,
    recordedAt: input.recordedAt,
    catalogId: input.identity.catalogId,
    contextId: input.identity.contextId,
    castNumber: toPositiveInteger(input.identity.castNumber),
    xpAwarded: toNonNegativeInteger(input.xpAwarded),
  };
}

/** Build an XP-award event for an award that has already been decided. */
export function toXpAwardEvent(input: {
  readonly subjectId: string;
  readonly source: StatisticsXpSource;
  /** The identity components of the event that paid the XP. */
  readonly sourceIdentity: readonly string[];
  readonly localDate: string;
  readonly recordedAt: string;
  readonly amount: number;
}): StatisticsXpAwardEvent {
  return {
    kind: 'xp-award',
    eventId: deriveStatisticsEventId({
      kind: 'xp-award',
      subjectId: input.subjectId,
      sourceIdentity: input.sourceIdentity,
    }),
    localDate: input.localDate,
    recordedAt: input.recordedAt,
    source: input.source,
    amount: toNonNegativeInteger(input.amount),
  };
}

// ── Reads over a ledger ────────────────────────────────────────────────────

/** Every event of one kind, in ledger order (newest first). */
export function eventsOfKind<K extends StatisticsEventKind>(
  ledger: StatisticsEventLedger,
  kind: K,
): Extract<StatisticsEvent, { kind: K }>[] {
  return ledger.events.filter((event): event is Extract<StatisticsEvent, { kind: K }> => event.kind === kind);
}

/** Count of events of one kind. */
export function countEventsOfKind(ledger: StatisticsEventLedger, kind: StatisticsEventKind): number {
  let count = 0;
  for (const event of ledger.events) if (event.kind === kind) count += 1;
  return count;
}

/** Total XP recorded by `xp-award` events. The authoritative XP total for a subject. */
export function totalXpAwarded(ledger: StatisticsEventLedger): number {
  let total = 0;
  for (const event of ledger.events) {
    if (event.kind !== 'xp-award') continue;
    total += event.amount;
  }
  return total;
}

/** Distinct app-minted room ids carrying a note-submission event, newest first. */
export function distinctNoteRooms(ledger: StatisticsEventLedger): string[] {
  const seen = new Set<string>();
  const rooms: string[] = [];
  for (const event of ledger.events) {
    if (event.kind !== 'note-submission' || seen.has(event.roomId)) continue;
    seen.add(event.roomId);
    rooms.push(event.roomId);
  }
  return rooms;
}

/** Distinct app-minted room ids carrying a review-completion event, newest first. */
export function distinctReviewRooms(ledger: StatisticsEventLedger): string[] {
  const seen = new Set<string>();
  const rooms: string[] = [];
  for (const event of ledger.events) {
    if (event.kind !== 'review-completion' || seen.has(event.roomId)) continue;
    seen.add(event.roomId);
    rooms.push(event.roomId);
  }
  return rooms;
}

/** Distinct catalogue ids carrying a fishing-outcome event, newest first. */
export function distinctFishingCatalogIds(ledger: StatisticsEventLedger): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const event of ledger.events) {
    if (event.kind !== 'fishing-outcome' || seen.has(event.catalogId)) continue;
    seen.add(event.catalogId);
    ids.push(event.catalogId);
  }
  return ids;
}

/** Distinct local day keys carrying any event, ascending. */
export function activeDateKeys(ledger: StatisticsEventLedger): string[] {
  return [...new Set(ledger.events.map((event) => event.localDate))].sort();
}