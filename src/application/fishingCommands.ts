/**
 * Fishing application layer.
 *
 * ## The defects this exists for
 *
 * Plan 5.3 lists two fishing defects that are really *one* defect seen from three
 * directions, and this module is the fix for both:
 *
 * > "Fishing eligibility, recall selection, and persistence may use different
 * > subject contexts."
 *
 * In the current build there are **three different derivations** of the subject a
 * catch belongs to:
 *
 * | Step | Source today | What it reads |
 * |------|--------------|---------------|
 * | eligibility | `studyFlow.enterFishing` | `getFishingPondPortalMap()` - the *nearest portal slot* in the village layout, compared against `villageStore.getVillageSubjects()` |
 * | recall selection | `VillageScreen.handleKeepFishClicked` | `useProgressionStore.getState().activeSubjectId` |
 * | persistence | `VillageScreen.handleKeepFish` | `Object.keys(bySubject)[subjectIds.length - 1]` - described in its own comment as "the most recently active one", which is not a thing; that is insertion order - falling back to the literal string `'village'` |
 *
 * And then `progressionStore.addFish` writes to
 * `getSubjectProgression(state.bySubject, state.activeSubjectId)` **regardless of the
 * `subjectId` it was handed**, so the fish is stored under the active subject while
 * carrying a different `subjectId` field. The result is a collection whose entries
 * disagree with the record they are in, which is precisely what
 * `FishStandPanel`'s "is this subject deleted" check and Phase 17's "collection
 * counts use canonical catalog IDs and subject IDs" criterion read.
 *
 * The fix is `src/core/fishing/fishingContext.ts`, which existed and was wired to
 * nothing: **one context, created at pond entry, carried unchanged**. This module is
 * where it is created, where it is compared, and where a mismatch is a **typed
 * refusal** rather than a warning.
 *
 * ## The second defect
 *
 * > "Fish, XP, and badges are written through multiple non-transactional
 * > operations."
 *
 * `handleKeepFish` calls `addFish`, then `awardFishingXp`, then `checkFishingBadges`:
 * three `set` calls, three `savePersistedBySubject` calls, and no idempotency at all.
 * `fishing/catch-keep` here is **one** command whose reward is one pure decision
 * ({@link decideCatchReward}) written in **one** record by
 * `progressionStore.recordCatch`. See `src/core/fishing/catchRewards.ts`.
 *
 * ## Plain TypeScript, like `reviewCommands.ts` and `encounterCommands.ts`
 *
 * No React, no renderer, no DOM, no store import, no clock of its own. Every side
 * effect - read the snapshot, read the preserved fields, commit the reward - is an
 * injected port. No renderer imports appear anywhere in the closure of this module.
 *
 * ## Synchronous, and why that is honest here
 *
 * Like `reviewCommands.ts`, and for the same reason: the write whose atomicity
 * matters is the progression record, and it is synchronous. The one thing this
 * layer does *not* own is the recall question's material - `pullRecallQuestion`
 * needs a loaded `SubjectSnapshot`, and the caller supplies it through the payload,
 * already loaded. That keeps this layer free of an async port it would otherwise
 * have to thread through every command, and it keeps the subject-context comparison
 * at the *commit* boundary, where the decision is made.
 *
 * A persistence failure **rejects**, exactly as `await persist(next)` rejecting did
 * inside `submitNote`. The port call is not wrapped in a `try`: turning an I/O
 * failure into a typed result would be a typed lie.
 *
 * ## The subject-context enforcement point
 *
 * **Every mutating command compares the caller's candidate subject context against
 * the session's context with `isSameFishingSubject`, and refuses on a mismatch -
 * before any reward is computed.** That is one function, called from
 * {@link requireMatchingSession}, and it is the enforcement point for all four of
 * `catch-keep`, `catch-release`, `cast-complete`, and `bite-resolve`.
 *
 * The fish is then persisted under the **session's** `subjectId`, never the caller's
 * and never `activeSubjectId`. `progressionStore.recordCatch` takes the subject id as
 * a parameter for exactly this reason; the alternative - a store action that reads
 * `activeSubjectId` - is the defect.
 *
 * ## Read-only commands, and what they write
 *
 * `session-begin`, `cast-complete`, `bite-resolve`, and `state-read` write **nothing**.
 * They are read paths, and a read path that writes is how a fishing session leaves
 * progression bytes behind before the learner has caught anything.
 *
 * `catch-release` also writes nothing, and that is the whole of its contract: plan 5.2
 * requires that releasing a fish never mutates progression. It returns the full
 * outcome with `progression: null` so "released, and nothing happened" is in the type
 * rather than in a comment.
 *
 * ## Recall question selection uses the context's subject
 *
 * `bite-resolve` pulls the recall question from `payload.dungeon`, and the caller is
 * required to have loaded it for `context.subjectId`. The layer does not re-read the
 * active subject to find material, which is what made the recall and the persistence
 * disagree. When the context's subject has no cleared rooms, the outcome is
 * `recall: null` and the learner keeps the fish - as
 * `kept-without-recall`, with its own XP rule - rather than being recorded as a
 * correct answer.
 *
 * `catch-keep` reports the recall question alongside the question's room, so the
 * surface can offer the local "go back to that room" navigation the scope asks for.
 *
 * ## Privacy
 *
 * No renderer imports. No learner data in any id, key, message, or log: identities
 * are app-minted session ids, catalogue ids, room ids, subject ids, and integers, and
 * every message here is a condition sentence. Nothing fetches, uploads, or forms a
 * request. No `console` output anywhere in this module.
 */
import { getClearedRooms, pullRecallQuestion } from '@/core/fishing/fishingMechanics';
import {
  createFishingContext,
  isSameFishingSubject,
  validateFishingContext,
  withCaughtFish,
  type FishingContext,
  type FishingSubjectContext,
} from '@/core/fishing/fishingContext';
import {
  readCatchRewardLedgerFromFields,
  toCatchRewardIdentity,
  type CatchDeclinedOutcome,
  type CatchOutcome,
  type CatchResolution,
  type CatchRewardIdentity,
} from '@/core/fishing/catchRewards';
import {
  FISH_CATALOG,
  type FishCatalogEntry,
  type FishDirection,
} from '@/core/fishing/fishingTypes';
import { isFishingEligible } from '@/core/fishing/fishingStateMachine';
import type { DungeonRoomSummary, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import type { SelfCheckPrompt } from '@/core/review/types';
import type {
  FishingBiteResolvePayload,
  FishingCastCompletePayload,
  FishingCatchKeepPayload,
  FishingCatchReleasePayload,
  FishingCommand,
  FishingCommandName,
  FishingRecallOutcome,
  FishingSessionBeginPayload,
  FishingStateReadPayload,
} from './contracts/commands';

// ── Ports ────────────────────────────────────────────────────────────────────

/**
 * The fishing session, as this module sees it.
 *
 * Minted once at pond entry by {@link createFishingController}'s `sessionBegin`, and
 * handed to every later command. The controller does **not** keep it: a closure-held
 * session would make the mismatch case untestable and would let a surface commit
 * against a context it never saw. Holding it in the caller is also what makes the
 * subject-context comparison real - the candidate has to come from somewhere that
 * could disagree.
 */
export interface FishingSessionPort {
  /**
   * The open session, or `null` when no pond is open.
   *
   * Returning `null` is a typed refusal, not a crash: leaving a pond mid-command is
   * an ordinary thing for a learner to do.
   */
  readSession(): FishingContext | null;
}

/** The subject snapshot, as this module sees it. Read-only. */
export interface FishingSubjectPort {
  /**
   * The snapshot for `subjectId`, or `null` when it is not loaded.
   *
   * The caller loads it. This module never reaches for a subject other than the one
   * the session names, so it never needs a "which subject is active" question at all.
   */
  readSnapshot(subjectId: string): SubjectSnapshot | null;
}

/** What committing the catch transaction reports. */
export interface CatchCommitOutcome {
  /** False when the ledger already held this catch. */
  awarded: boolean;
  /** True when the award was suppressed because this catch was already recorded. */
  duplicate: boolean;
  xpGained: number;
  /** `null` when the ledger declined the outcome and nothing was written. */
  newRank: import('@/core/progression/types').RankTier | null;
  rankChanged: boolean;
  unlockedBadges: string[];
  /** The canonical entry that was written, or `null` when nothing was. */
  fishEntryId: string | null;
}

/**
 * The reward transaction and the durable ledger store, as this module sees them.
 *
 * `readPreservedFields` is how the command layer reads what is already durable before
 * deciding. `commitCatch` is the one record write; it takes the **subject id as a
 * parameter**, because an action that read `activeSubjectId` instead is the defect
 * this module exists to remove.
 */
export interface FishingProgressionPort {
  /** The named subject record's preserved app-owned fields, as they stand. */
  readPreservedFields(subjectId: string): Record<string, unknown> | undefined;
  /**
   * Commit the whole catch transaction: fish entry, XP, rank, badges, and the ledger
   * entry, in one record write.
   *
   * A **declined** outcome must write nothing at all. The port reports that as
   * `{ awarded: false, duplicate: false, fishEntryId: null }`.
   */
  commitCatch(input: {
    subjectId: string;
    identity: CatchRewardIdentity;
    outcome: CatchOutcome | CatchDeclinedOutcome;
    catalogEntry: FishCatalogEntry;
    subjectName: string;
    recallRoomId: string | null;
  }): CatchCommitOutcome;
}

/** Everything {@link createFishingController} needs. */
export interface FishingCommandDeps {
  session: FishingSessionPort;
  subject: FishingSubjectPort;
  progression: FishingProgressionPort;
  /** Wall clock, so every injected timestamp is deterministic in a test. */
  nowIso(): string;
  /**
   * Mint a session id. Injected so a test gets a constant and production gets
   * `crypto.randomUUID()`. Must return a non-empty opaque string.
   */
  mintSessionId(): string;
}

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * Refusal codes.
 *
 * `NO_OPEN_SESSION` is "no pond is open". `SUBJECT_CONTEXT_MISMATCH` is the one this
 * module exists to produce, and it is a refusal rather than a warning because the
 * alternative is a fish stored against the wrong subject - which is not a defect a
 * learner can see and cannot be undone by a later retry.
 */
export type FishingCommandErrorCode =
  | 'NO_OPEN_SESSION'
  | 'SUBJECT_CONTEXT_MISMATCH'
  | 'INVALID_SESSION_CONTEXT'
  | 'UNKNOWN_CATALOG_ID'
  | 'CAST_STATE_INVALID';

/** A refusal: a condition the learner can be told about, not an exception. */
export interface FishingCommandError {
  code: FishingCommandErrorCode;
  /** A condition message. Never learner content. */
  message: string;
  /** Machine-readable detail: codes and app-minted ids only, never note text. */
  details?: Record<string, unknown>;
}

/** The result of one fishing command. */
export type FishingCommandResult<T> = { ok: true; value: T } | { ok: false; error: FishingCommandError };

// ── Outcomes ─────────────────────────────────────────────────────────────────

/** A recall question resolved against the session's subject. */
export interface FishingRecallQuestion {
  prompt: SelfCheckPrompt;
  /** The room the question came from, for local navigation back to it. */
  roomId: string;
}

/** `fishing/session-begin`. */
export interface FishingSessionBeginOutcome {
  command: 'fishing/session-begin';
  /** The one context every later command is committed against. */
  context: FishingContext;
  /** Whether this subject may be fished, from the context's own cleared rooms. */
  eligible: boolean;
  /** Cleared rooms in the **context's** subject, for a surface to explain itself. */
  clearedRoomCount: number;
  /** Always `null`: entering a pond awards nothing and writes nothing. */
  progression: null;
}

/** `fishing/cast-complete`. */
export interface FishingCastCompleteOutcome {
  command: 'fishing/cast-complete';
  context: FishingContext;
  /** Which cast in the session this was, one-based. */
  castNumber: number;
  catalogEntry: FishCatalogEntry;
  fishDirection: FishDirection;
  /** Always `null`. Landing a cast awards nothing and writes nothing. */
  progression: null;
}

/** `fishing/bite-resolve`. */
export interface FishingBiteResolveOutcome {
  command: 'fishing/bite-resolve';
  context: FishingContext;
  castNumber: number;
  /**
   * `'hooked'` when the learner struck inside the window, `'missed'` when the window
   * closed first. A miss has no catch, and the two are a discriminated pair rather
   * than a nullable catch so a caller cannot award on `'missed'`.
   */
  resolution: 'hooked' | 'missed';
  catch: FishingCatchReady | null;
  /** Always `null`. Hooking awards nothing; the keep does. */
  progression: null;
}

/** A caught fish, ready to be kept or released. */
export interface FishingCatchReady {
  identity: CatchRewardIdentity;
  catalogEntry: FishCatalogEntry;
  castNumber: number;
  /**
   * The recall question for this catch, or `null` when the session's subject has no
   * cleared room to ask about.
   */
  recall: FishingRecallQuestion | null;
}

/** `fishing/catch-keep`. */
export interface FishingCatchKeepOutcome {
  command: 'fishing/catch-keep';
  context: FishingContext;
  castNumber: number;
  /** What the caller asked to record. */
  recall: FishingRecallOutcome;
  /**
   * How it resolved, as the ledger's own code.
   *
   * Always equal to {@link resolveOutcome} of the payload - the caller cannot get a
   * `kept-without-recall` unless it asked for one - and typed as the full resolution
   * union so `answered-incorrect` is visible here rather than implied by
   * `progression: null`.
   */
  outcome: CatchResolution;
  /** The commit, or `null` when nothing was written. */
  progression: CatchCommitOutcome | null;
}

/** `fishing/catch-release`. */
export interface FishingCatchReleaseOutcome {
  command: 'fishing/catch-release';
  context: FishingContext;
  castNumber: number;
  catalogEntry: FishCatalogEntry;
  /**
   * Always `null`.
   *
   * Present so "released, and nothing happened" is in the type: a release awards
   * nothing, adds no fish, and unlocks no badge, which is plan 5.2's "releasing a
   * fish never mutates progression" in the only form a caller cannot get wrong.
   */
  progression: null;
}

/** `fishing/state-read`. */
export interface FishingStateReadOutcome {
  command: 'fishing/state-read';
  context: FishingContext;
  eligibility: { eligible: boolean; clearedRoomCount: number };
  /**
   * Whether the session's subject has at least one cleared room to draw a recall
   * question from. Not eligibility - a learner with no material may still fish.
   */
  hasRecallMaterial: boolean;
  /** Catches recorded for this session in the subject's ledger, read-only. */
  recordedCatches: number;
  /** Always `null`: a read writes nothing. */
  progression: null;
}

/** Every fishing outcome, discriminated by command. */
export type FishingOutcome =
  | FishingSessionBeginOutcome
  | FishingCastCompleteOutcome
  | FishingBiteResolveOutcome
  | FishingCatchKeepOutcome
  | FishingCatchReleaseOutcome
  | FishingStateReadOutcome;

/** The result of one named fishing command. */
export type FishingResult<C extends FishingCommandName> = FishingCommandResult<
  Extract<FishingOutcome, { command: C }>
>;

// ── Shared answers ───────────────────────────────────────────────────────────

const NO_OPEN_SESSION_MESSAGE = 'No fishing session is open.';
const SUBJECT_CONTEXT_MISMATCH_MESSAGE =
  'This catch belongs to a different subject than the pond session.';
const INVALID_SESSION_CONTEXT_MESSAGE = 'The fishing session is missing its subject.';
const UNKNOWN_CATALOG_ID_MESSAGE = 'That fish is not in the catalog.';
const CAST_STATE_INVALID_MESSAGE = 'That cast has not landed a fish yet.';

/** The no-open-session refusal. */
function noOpenSession<C extends FishingCommandName>(): FishingResult<C> {
  return { ok: false, error: { code: 'NO_OPEN_SESSION', message: NO_OPEN_SESSION_MESSAGE } };
}

/**
 * The open session, or a typed refusal.
 *
 * The half of the precondition every fishing command shares: there is a pond open,
 * and its context is complete. Split from {@link requireMatchingSession} so
 * `fishing/state-read` - which carries no candidate context and therefore asserts
 * nothing to compare - can use it without inventing a sentinel subject.
 */
function requireOpenSession(
  deps: FishingCommandDeps,
): FishingCommandResult<{ context: FishingContext }> {
  const context = deps.session.readSession();
  if (!context) return noOpenSession() as FishingCommandResult<never>;

  if (!validateFishingContext(context).ok) {
    return {
      ok: false,
      error: { code: 'INVALID_SESSION_CONTEXT', message: INVALID_SESSION_CONTEXT_MESSAGE },
    };
  }

  return { ok: true, value: { context } };
}

/**
 * The session, the snapshot it names, and the cast's identity - or a typed refusal.
 *
 * **The subject-context enforcement point.** `isSameFishingSubject` is called here and
 * nowhere else, so all four subject-bearing commands enforce it from one place, before
 * any reward is computed and before any id is minted. A step that re-derived a
 * different subject - the `activeSubjectId` read, the `Object.keys(...)[n - 1]` read,
 * the nearest-portal read - stops here instead of persisting a fish against the wrong
 * subject.
 */
function requireMatchingSession(
  deps: FishingCommandDeps,
  candidate: FishingSubjectContext,
): FishingCommandResult<{ context: FishingContext; snapshot: SubjectSnapshot | null }> {
  const opened = requireOpenSession(deps);
  if (!opened.ok) return opened as FishingCommandResult<never>;
  const { context } = opened.value;

  if (!isSameFishingSubject(context, candidate)) {
    return {
      ok: false,
      error: {
        code: 'SUBJECT_CONTEXT_MISMATCH',
        message: SUBJECT_CONTEXT_MISMATCH_MESSAGE,
        // Both ids are app-minted. `subjectName` is deliberately absent: it is the
        // one human-readable field here and a mismatch message does not need it.
        details: { sessionSubjectId: context.subjectId, candidateSubjectId: candidate.subjectId },
      },
    };
  }

  // The snapshot is read for the *session's* subject, never the caller's. Reading
  // the caller's would be the same defect one layer down.
  const snapshot = deps.subject.readSnapshot(context.subjectId);
  return { ok: true, value: { context, snapshot } };
}

/** Cleared, reviewable rooms in a subject. Empty when the subject is not loaded. */
function clearedRoomsOf(snapshot: SubjectSnapshot | null): RoomMetadata[] {
  if (!snapshot) return [];
  try {
    return getClearedRooms(snapshot.rooms);
  } catch {
    // `getClearedRooms` reads `rooms` and the validation flags. A half-migrated
    // record should make a cast unavailable, not throw through a learner's click.
    return [];
  }
}

/** The subject's room summaries, for recall material. */
function dungeonRoomsOf(snapshot: SubjectSnapshot | null): DungeonRoomSummary[] {
  return snapshot?.dungeon.rooms ?? [];
}

/**
 * The recall question for a catch, or `null` when there is no material.
 *
 * Resolved against the **session's** subject. `pullRecallQuestion` uses
 * `Math.random` internally - three draws, and plan 17 lists that as a defect of its
 * own - so it is called from here, once, for one catch, rather than per render.
 * Fixing its determinism is a follow-up in `src/core/fishing/fishingMechanics.ts` and
 * is deliberately not smuggled in here; see the note in the report.
 */
function recallFor(
  snapshot: SubjectSnapshot | null,
  context: FishingContext,
): FishingRecallQuestion | null {
  const clearedRooms = clearedRoomsOf(snapshot);
  if (clearedRooms.length === 0) return null;
  try {
    const pulled = pullRecallQuestion({
      clearedRooms,
      dungeonRooms: dungeonRoomsOf(snapshot),
      // The context's subject name, from the context. Never the active subject's.
      subjectName: context.subjectName,
    });
    return pulled === null ? null : { prompt: pulled.prompt, roomId: pulled.roomId };
  } catch {
    return null;
  }
}

/** The catalogue entry for a canonical id. */
function requireCatalogEntry(catalogId: string): FishCatalogEntry | null {
  return FISH_CATALOG.find((entry) => entry.id === catalogId) ?? null;
}

/** A catch's identity, built from the session and the cast that produced it. */
function identityFor(context: FishingContext, catalogId: string, castNumber: number): CatchRewardIdentity {
  return toCatchRewardIdentity({ contextId: context.contextId, catalogId, castNumber });
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * `fishing/session-begin` - enter the pond and mint the one context.
 *
 * Read-only with respect to progression: it mints a context in the caller's
 * session slot and awards nothing. `subjectId` and `subjectName` are the **subject
 * the pond was entered from**, supplied by the caller from the subject it activated,
 * which is what stops the nearest-portal-slot lookup from deciding who the learner is
 * fishing as.
 */
function runSessionBegin(
  deps: FishingCommandDeps,
  payload: FishingSessionBeginPayload,
): FishingResult<'fishing/session-begin'> {
  let context: FishingContext;
  try {
    context = createFishingContext({
      contextId: deps.mintSessionId(),
      pondId: payload.pondId,
      enteredAt: deps.nowIso(),
      subjectId: payload.subjectId,
      subjectName: payload.subjectName,
      roomId: payload.roomId ?? null,
    });
  } catch {
    // `createFishingContext` throws on an empty subject id or name, and on an empty
    // pond id. Those are caller conditions, so they are refusals here rather than
    // exceptions, and the message is a condition sentence.
    return {
      ok: false,
      error: { code: 'INVALID_SESSION_CONTEXT', message: INVALID_SESSION_CONTEXT_MESSAGE },
    };
  }

  // Eligibility from the context's own subject, never from the village layout.
  const snapshot = deps.subject.readSnapshot(context.subjectId);
  const clearedRoomCount = clearedRoomsOf(snapshot).length;

  return {
    ok: true,
    value: {
      command: 'fishing/session-begin',
      context,
      eligible: isFishingEligible(clearedRoomCount),
      clearedRoomCount,
      progression: null,
    },
  };
}

/**
 * `fishing/cast-complete` - the bobber landed and a fish is approaching.
 *
 * The catalogue roll and the direction come from the **state machine**, not from this
 * layer: the machine owns the seeded stream, and re-rolling here would both consume a
 * second stream and take the reproducibility the machine exists to provide away. The
 * command carries the rolled result, and the identity is built here so the cast has an
 * identity before anything is awarded.
 */
function runCastComplete(
  deps: FishingCommandDeps,
  payload: FishingCastCompletePayload,
): FishingResult<'fishing/cast-complete'> {
  const session = requireMatchingSession(deps, payload.subject);
  if (!session.ok) return session as FishingResult<'fishing/cast-complete'>;
  const { context } = session.value;

  const catalogEntry = requireCatalogEntry(payload.catalogId);
  if (!catalogEntry) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_CATALOG_ID',
        message: UNKNOWN_CATALOG_ID_MESSAGE,
        details: { catalogId: payload.catalogId },
      },
    };
  }
  const castNumber = Math.trunc(payload.castNumber);
  if (!Number.isFinite(payload.castNumber) || castNumber < 1) {
    return { ok: false, error: { code: 'CAST_STATE_INVALID', message: CAST_STATE_INVALID_MESSAGE } };
  }

  // The context gains the rolled fish's identity, so the surface has one value to
  // carry for the rest of the catch. `withCaughtFish` leaves the subject half
  // untouched, which is what keeps `isSameFishingSubject` meaningful.
  return {
    ok: true,
    value: {
      command: 'fishing/cast-complete',
      context: withCaughtFish(context, { catalogId: catalogEntry.id, rarity: catalogEntry.rarity }),
      castNumber,
      catalogEntry,
      fishDirection: payload.fishDirection,
      progression: null,
    },
  };
}

/**
 * `fishing/bite-resolve` - hook or miss.
 *
 * `'hooked'` reports the catch, ready to be kept or released. `'missed'` reports no
 * catch at all: a discriminated `resolution` with a nullable `catch`, so a caller
 * cannot award on a miss by forgetting a null check.
 *
 * The recall question is pulled here, once, from the context's subject.
 */
function runBiteResolve(
  deps: FishingCommandDeps,
  payload: FishingBiteResolvePayload,
): FishingResult<'fishing/bite-resolve'> {
  const session = requireMatchingSession(deps, payload.subject);
  if (!session.ok) return session as FishingResult<'fishing/bite-resolve'>;
  const { context, snapshot } = session.value;

  if (payload.resolution === 'missed') {
    return {
      ok: true,
      value: {
        command: 'fishing/bite-resolve',
        context,
        castNumber: Math.trunc(payload.castNumber),
        resolution: 'missed',
        catch: null,
        progression: null,
      },
    };
  }

  // `catalogId` is optional in the payload only so the `'missed'` arm needs none. A
  // `'hooked'` resolution without one has no fish, and the cast is not in a state
  // where a catch could exist.
  if (typeof payload.catalogId !== 'string') {
    return { ok: false, error: { code: 'CAST_STATE_INVALID', message: CAST_STATE_INVALID_MESSAGE } };
  }

  const catalogEntry = requireCatalogEntry(payload.catalogId);
  if (!catalogEntry) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_CATALOG_ID',
        message: UNKNOWN_CATALOG_ID_MESSAGE,
        details: { catalogId: payload.catalogId },
      },
    };
  }

  const castNumber = Math.trunc(payload.castNumber);
  return {
    ok: true,
    value: {
      command: 'fishing/bite-resolve',
      context: withCaughtFish(context, {
        catalogId: catalogEntry.id,
        rarity: catalogEntry.rarity,
      }),
      castNumber,
      resolution: 'hooked',
      catch: {
        identity: identityFor(context, catalogEntry.id, castNumber),
        catalogEntry,
        castNumber,
        recall: recallFor(snapshot, context),
      },
      progression: null,
    },
  };
}

/**
 * `fishing/catch-keep` - the whole transaction, in one record write.
 *
 * Three things happen, in this order:
 *
 * 1. **The subject context is checked.** A mismatch is a typed refusal, before
 *    anything is minted.
 * 2. **The recall outcome is resolved to one of three codes.** `kept-without-recall`
 *    is a member of the payload's discriminated union, not an inference from a
 *    missing question: the learner keeping a fish with no material available is a
 *    distinct event from answering a question, and the ledger records it as one.
 * 3. **One pure decision, one write.** {@link decideCatchReward} computes the fish
 *    entry, the XP, the rank, the badge unlocks, and the ledger entry as a single
 *    value; `progressionStore.recordCatch` writes them in one `set` of one record.
 *
 * The XP rule for `kept-without-recall` is zero, and its argument is on
 * `CATCH_XP_BY_OUTCOME` in `src/core/fishing/catchRewards.ts`.
 */
function runCatchKeep(
  deps: FishingCommandDeps,
  payload: FishingCatchKeepPayload,
): FishingResult<'fishing/catch-keep'> {
  const session = requireMatchingSession(deps, payload.subject);
  if (!session.ok) return session as FishingResult<'fishing/catch-keep'>;
  const { context } = session.value;

  const catalogEntry = requireCatalogEntry(payload.catalogId);
  if (!catalogEntry) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_CATALOG_ID',
        message: UNKNOWN_CATALOG_ID_MESSAGE,
        details: { catalogId: payload.catalogId },
      },
    };
  }

  const castNumber = Math.trunc(payload.castNumber);
  const outcome = resolveOutcome(payload.recall);
  const recallRoomId = recallRoomIdFor(payload.recall, outcome);

  const progression = deps.progression.commitCatch({
    // **The session's** subject id, not `payload.subject.subjectId` and not
    // `activeSubjectId`. This single line is the fix for the defect the whole module
    // exists for.
    subjectId: context.subjectId,
    identity: identityFor(context, catalogEntry.id, castNumber),
    outcome,
    catalogEntry,
    // The context's subject name. The record's display text, from the one context.
    subjectName: context.subjectName,
    recallRoomId,
  });

  const declined = CATCH_DECLINED_OUTCOMES.has(outcome as CatchDeclinedOutcome);

  return {
    ok: true,
    value: {
      command: 'fishing/catch-keep',
      context: withCaughtFish(context, {
        catalogId: catalogEntry.id,
        rarity: catalogEntry.rarity,
      }),
      castNumber,
      recall: payload.recall,
      outcome,
      // A declined resolution reports `null`: nothing was written, and the type says
      // so. The commit **was** still requested, because the store is the authority on
      // what a declined outcome does and the command layer does not duplicate the
      // policy.
      progression: declined ? null : progression,
    },
  };
}

/**
 * `fishing/catch-release` - throw the fish back.
 *
 * **Writes nothing and awards nothing, and says so in the type.** Not one port is
 * called: there is no `commitCatch` with a `released` outcome, because going through
 * the reward transaction to be told "no" would be a path where a future edit could
 * start writing. `tests/phase17/fishingCommands.test.ts` proves it by diffing the
 * whole progression value across the command.
 */
function runCatchRelease(
  deps: FishingCommandDeps,
  payload: FishingCatchReleasePayload,
): FishingResult<'fishing/catch-release'> {
  const session = requireMatchingSession(deps, payload.subject);
  if (!session.ok) return session as FishingResult<'fishing/catch-release'>;
  const { context } = session.value;

  const catalogEntry = requireCatalogEntry(payload.catalogId);
  if (!catalogEntry) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_CATALOG_ID',
        message: UNKNOWN_CATALOG_ID_MESSAGE,
        details: { catalogId: payload.catalogId },
      },
    };
  }

  return {
    ok: true,
    value: {
      command: 'fishing/catch-release',
      context,
      castNumber: Math.trunc(payload.castNumber),
      catalogEntry,
      progression: null,
    },
  };
}

/** `fishing/state-read`. Reads the session, the eligibility, and the ledger. */
function runStateRead(
  deps: FishingCommandDeps,
  payload: FishingStateReadPayload,
): FishingResult<'fishing/state-read'> {
  // **No candidate context is compared.** A read asserts nothing about who is asking,
  // so it uses `requireOpenSession` and not `requireMatchingSession`. A surface that
  // *does* hold a context may still pass one, and the mismatch refusal then applies -
  // which is the useful behaviour for a surface restoring a pond across a subject
  // change.
  const opened = requireOpenSession(deps);
  if (!opened.ok) return opened as FishingResult<'fishing/state-read'>;
  const { context } = opened.value;

  if (payload.subject !== undefined && !isSameFishingSubject(context, payload.subject)) {
    return {
      ok: false,
      error: {
        code: 'SUBJECT_CONTEXT_MISMATCH',
        message: SUBJECT_CONTEXT_MISMATCH_MESSAGE,
        details: {
          sessionSubjectId: context.subjectId,
          candidateSubjectId: payload.subject.subjectId,
        },
      },
    };
  }

  const snapshot = deps.subject.readSnapshot(context.subjectId);
  const preservedFields = deps.progression.readPreservedFields(context.subjectId);
  const clearedRoomCount = clearedRoomsOf(snapshot).length;

  return {
    ok: true,
    value: {
      command: 'fishing/state-read',
      context,
      eligibility: { eligible: isFishingEligible(clearedRoomCount), clearedRoomCount },
      hasRecallMaterial: clearedRoomCount > 0,
      recordedCatches: readCatchRewardLedgerFromFields(preservedFields).entries.length,
      progression: null,
    },
  };
}

// ── Outcome resolution ───────────────────────────────────────────────────────

/**
 * The one place a caller's recall union becomes a ledger outcome code.
 *
 * `kept-without-recall` is passed through as itself rather than being inferred from
 * a missing question. That distinction is the phase's scope line, and a caller that
 * wanted to quietly promote "no material" to "correct" would have to write it here
 * explicitly, in the one function whose name says what it resolves.
 */
export function resolveOutcome(recall: FishingRecallOutcome): CatchResolution {
  switch (recall.kind) {
    case 'answered-correct':
      return 'answered-correct';
    case 'answered-incorrect':
      // Declined, not written. See `CATCH_DECLINED_OUTCOMES`.
      return 'answered-incorrect';
    case 'kept-without-recall':
      return 'kept-without-recall';
    default: {
      const unhandled: never = recall;
      return unhandled;
    }
  }
}

/**
 * The resolutions the reward transaction refuses to write.
 *
 * Named as a set rather than derived from `CATCH_OUTCOME_POLICY` so the command
 * layer's branch below reads as the decision it is: a declined resolution reports
 * `progression: null`, because there is no commit to report.
 */
const CATCH_DECLINED_OUTCOMES: ReadonlySet<CatchDeclinedOutcome> = new Set([
  'released',
  'answered-incorrect',
]);

/**
 * The room to record against a catch.
 *
 * The app-minted room id the caller reported answering, or `null`. Only an
 * `answered-*` recall can name one; a `kept-without-recall` has no room by
 * construction, which is checked here so a payload cannot smuggle one in.
 *
 * The room is **not** validated against the session's snapshot. It is app-minted and
 * carried so Phase 17's "navigation back to the relevant room" has a handle and
 * Phase 18's statistics have a subject-scoped key; whether the room is cleared is a
 * question the surface already answered when it pulled the question, and
 * re-deriving it here would be a second eligibility path - which is the shape of the
 * defect this module removes.
 */
function recallRoomIdFor(
  recall: FishingRecallOutcome,
  outcome: CatchResolution,
): string | null {
  // Only an answered recall has a room by construction: `kept-without-recall` has no
  // `roomId` in its type, and a `released` resolution never reaches this function.
  // The check on `recall` is what makes a payload unable to smuggle one in.
  if (recall.kind === 'kept-without-recall') return null;
  if (outcome === 'released') return null;
  const roomId = recall.roomId;
  if (typeof roomId !== 'string') return null;
  const trimmed = roomId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Controller ───────────────────────────────────────────────────────────────

/** The fishing surface. */
export interface FishingController {
  /** `fishing/session-begin` - enter the pond, mint the one context. */
  sessionBegin(payload: FishingSessionBeginPayload): FishingResult<'fishing/session-begin'>;
  /** `fishing/cast-complete` - the cast landed; report the rolled fish. */
  castComplete(payload: FishingCastCompletePayload): FishingResult<'fishing/cast-complete'>;
  /** `fishing/bite-resolve` - hook or miss a bite. */
  biteResolve(payload: FishingBiteResolvePayload): FishingResult<'fishing/bite-resolve'>;
  /** `fishing/catch-keep` - keep the fish and take the reward, once. */
  catchKeep(payload: FishingCatchKeepPayload): FishingResult<'fishing/catch-keep'>;
  /** `fishing/catch-release` - throw it back. Awards nothing, writes nothing. */
  catchRelease(payload: FishingCatchReleasePayload): FishingResult<'fishing/catch-release'>;
  /** `fishing/state-read` - the session, its eligibility, and its ledger count. */
  stateRead(payload: FishingStateReadPayload): FishingResult<'fishing/state-read'>;
  /** Execute any fishing command held as a tagged value. */
  dispatch(command: FishingCommand): FishingCommandResult<FishingOutcome>;
}

/**
 * Build the fishing controller.
 *
 * @param deps Injected ports and clock. No defaults: the application layer must not
 * reach for a real store, a real `Date`, or a real `Math.random` on its own.
 */
export function createFishingController(deps: FishingCommandDeps): FishingController {
  const sessionBeginCommand = (payload: FishingSessionBeginPayload) => runSessionBegin(deps, payload);
  const castCompleteCommand = (payload: FishingCastCompletePayload) => runCastComplete(deps, payload);
  const biteResolveCommand = (payload: FishingBiteResolvePayload) => runBiteResolve(deps, payload);
  const catchKeepCommand = (payload: FishingCatchKeepPayload) => runCatchKeep(deps, payload);
  const catchReleaseCommand = (payload: FishingCatchReleasePayload) => runCatchRelease(deps, payload);
  const stateReadCommand = (payload: FishingStateReadPayload) => runStateRead(deps, payload);

  return {
    sessionBegin: sessionBeginCommand,
    castComplete: castCompleteCommand,
    biteResolve: biteResolveCommand,
    catchKeep: catchKeepCommand,
    catchRelease: catchReleaseCommand,
    stateRead: stateReadCommand,
    // Both entry points reach the same runner for each command, so `dispatch` and the
    // named methods cannot drift apart: one implementation per command.
    dispatch: (command) => {
      switch (command.type) {
        case 'fishing/session-begin':
          return sessionBeginCommand(command.payload);
        case 'fishing/cast-complete':
          return castCompleteCommand(command.payload);
        case 'fishing/bite-resolve':
          return biteResolveCommand(command.payload);
        case 'fishing/catch-keep':
          return catchKeepCommand(command.payload);
        case 'fishing/catch-release':
          return catchReleaseCommand(command.payload);
        case 'fishing/state-read':
          return stateReadCommand(command.payload);
        default: {
          // Structural exhaustiveness: a `fishing/*` command added to the payload map
          // without a runner here fails `npm run typecheck` at this line, instead of
          // silently returning `undefined` to a caller that awaited it.
          const unhandled: never = command;
          return unhandled;
        }
      }
    },
  };
}