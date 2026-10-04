/**
 * The DOM side of the catch transaction: one session, one command, one decision.
 *
 * ## What this module replaces
 *
 * `VillageScreen.handleKeepFish` did the whole catch, from inside a React component, in three
 * store writes with no transaction:
 *
 * ```ts
 * addFishToCollection({ name, rarity, subjectId, subjectName });  // subjectId: Object.keys(bySubject)[length - 1]
 * const xpResult = progression.awardFishingXp(rarity);
 * const newBadges = progression.checkFishingBadges();
 * ```
 *
 * Four things were wrong with that, and none of them could be fixed from inside
 * `src/ui/**` by the layer that owns the domain:
 *
 * 1. **The subject was insertion order.** `Object.keys(bySubject)[length - 1]`, described in its
 *    own comment as "the most recently active one", is the last *key* of an object - which is
 *    insertion order, so it is the most recently *created* subject record, and is unrelated to
 *    the active one. With a literal `'village'` string as the fallback for the case where no
 *    subject had a record at all.
 * 2. **Three writes, three saves, and no idempotency.** A double dispatch, a retried click, or
 *    a reload could award twice.
 * 3. **The award had no outcome attached.** `awardFishingXp` was called on the keep path
 *    whatever the recall had resolved to, which is how a keep with no question became a
 *    correct answer.
 * 4. **Two `console.log`s printed the XP, the rank, and the joined badge ids** on every single
 *    catch, into the console of a child's application.
 *
 * All four are now one call into `fishing/catch-keep`, which `src/application/fishingCommands.ts`
 * owns: the subject comes from the session context minted at pond entry, the fish entry, the XP,
 * the rank, the badges, and the ledger row are one record write, and the ledger makes it
 * idempotent per (context, catalogue id, cast number).
 *
 * ## Why the session is minted here and not by the renderer
 *
 * `fishing/catch-keep` refuses without an open session, and the session port reads a holder the
 * *caller* keeps - deliberately, so that the subject-context enforcement is testable. This
 * module owns that holder through `fishingSessionSlot`, which is what `src/store/fishingCommands.ts`
 * exports for exactly this: "a surface can clear the slot when its pond unmounts".
 *
 * `beginFishingSession` is therefore called from the screen at the moment the pond is entered -
 * after the study flow's own mount guard has passed, so a pond that is never mounted never
 * mints a context - and cleared when it closes. Nothing here reads a renderer.
 *
 * ## Why `castNumber` matters and where it comes from
 *
 * The catch identity is (context id, catalogue id, cast number). Without the cast number two
 * catches of the same species in one session would share an identity and the second would be
 * *deduplicated* - the learner would keep one fish and watch the other vanish.
 *
 * On the Pixi lane the number is the machine's own `castNumber`, carried out with the reveal.
 * The Phaser rollback lane reports no cast number at all, so the caller mints one per session;
 * both are "which cast in this session produced this catch", which is what the identity means.
 * {@link FishingCatchContext} is where that number is recorded, and it is recorded **when the
 * catch is revealed**, not when the learner decides: an identity assigned at decision time
 * would depend on the order the learner clicked in, which is not a fact about the catch.
 *
 * ## No console output, anywhere
 *
 * There is none in this file and there is none in the module it calls. The reward is reported
 * as a value the caller may render, which is the only place a learner's own progress should be
 * read aloud.
 */
import {
  fishingController,
  fishingSessionSlot,
} from '@/store/fishingCommands';
import type { FishingResult } from '@/application/fishingCommands';
import type { FishingContext } from '@/core/fishing/fishingContext';
import type { FishingRecallOutcome } from '@/application/contracts/commands';
import type { FishRarity } from '@/core/fishing/fishingTypes';

/** A catch as the DOM knows it: canonical identity, rarity, and which cast produced it. */
export interface FishingCatchContext {
  readonly catalogId: string;
  readonly rarity: FishRarity;
  /** One-based, monotonic for the life of the session. */
  readonly castNumber: number;
}

/** The three outcomes, as the modal names them. Mirrors `FishingRecallChoice`. */
export type FishingKeepChoice = 'answered-correct' | 'answered-incorrect' | 'kept-without-recall';

/** What the catch transaction reported, in the shape a surface can render. */
export interface FishingKeepReport {
  readonly ok: boolean;
  /** False when the ledger already held this catch. */
  readonly awarded: boolean;
  /** True when the award was suppressed because the catch was already recorded. */
  readonly duplicate: boolean;
  /** Zero for every outcome that pays nothing, which includes all three non-correct ones. */
  readonly xpGained: number;
  /** The outcome the command actually committed, or `null` when nothing was. */
  readonly outcome: FishingKeepOutcomeName | null;
  /** A refusal or failure sentence, or `null` on success. */
  readonly message: string | null;
}

/** The four names `catchRewards.ts` uses, spelled for the DOM. */
export type FishingKeepOutcomeName =
  | 'answered-correct'
  | 'kept-without-recall'
  | 'released'
  | 'answered-incorrect';

/** The refusal sentences, restated so a caller renders text rather than a code. */
const NO_SESSION_MESSAGE =
  'This catch could not be saved because the fishing session is no longer open. Release the fish or cast again.';
const COMMIT_FAILED_MESSAGE =
  'This catch could not be saved because the catch record was rejected. Nothing has been added to your collection.';
const UNKNOWN_CATALOG_MESSAGE =
  'This catch could not be saved because its catalogue entry could not be resolved. Nothing has been added to your collection.';

/**
 * The recall outcome to commit.
 *
 * The two answered cases are **structurally** unable to be built without a room id: the union
 * in `src/application/contracts/commands.ts` has `roomId` only on those two members, so
 * "answered correctly with no room" is not a value that can exist. That is the point of the
 * discriminated union, and this function is where it is relied on.
 *
 * So a caller that says "correct" without a room has not answered a question - there was no
 * question - and the outcome it commits is `kept-without-recall`. The fish is kept and no XP is
 * paid, which is exactly what the learner's action meant. Returning a value rather than
 * throwing keeps a malformed catch from stranding the fish in the panel forever.
 */
export function resolveRecallOutcome(
  choice: FishingKeepChoice,
  roomId: string | null,
): FishingRecallOutcome {
  if (roomId === null || roomId.trim().length === 0) return { kind: 'kept-without-recall' };
  if (choice === 'answered-correct') return { kind: 'answered-correct', roomId };
  if (choice === 'answered-incorrect') return { kind: 'answered-incorrect', roomId };
  return { kind: 'kept-without-recall' };
}

/** The open session's context, or `null`. */
export function readFishingSession(): FishingContext | null {
  return fishingSessionSlot.current;
}

/**
 * Mint the session context for a pond, and hold it.
 *
 * `subjectId` and `subjectName` are the **active subject**, deliberately, rather than the
 * village layout's nearest portal slot: `fishingCommands`' own header records that the
 * portal-slot lookup is the derivation that let eligibility and persistence disagree, and plan
 * 5.3 is the line that says so.
 *
 * Returns `null` when the context could not be created - an active subject with no name, or
 * none at all - and leaves the slot empty, so a later `catchKeep` refuses with
 * `NO_OPEN_SESSION` and a visible sentence rather than writing a fish against `'village'`.
 */
export function beginFishingSession(input: {
  readonly pondId: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly roomId?: string | null;
}): FishingContext | null {
  const begun = fishingController.sessionBegin({
    pondId: input.pondId,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    roomId: input.roomId ?? null,
  });
  if (!begun.ok) {
    fishingSessionSlot.current = null;
    return null;
  }
  fishingSessionSlot.current = begun.value.context;
  return begun.value.context;
}

/** Close the session. Called when the pond unmounts, so nothing can commit after it. */
export function endFishingSession(): void {
  fishingSessionSlot.current = null;
}

/** Turn a command refusal into a sentence a learner can read. */
function refusalMessage(result: Extract<FishingResult<never>, { ok: false }>): string {
  switch (result.error.code) {
    case 'NO_OPEN_SESSION':
      return NO_SESSION_MESSAGE;
    case 'SUBJECT_CONTEXT_MISMATCH':
      return NO_SESSION_MESSAGE;
    case 'INVALID_SESSION_CONTEXT':
      return NO_SESSION_MESSAGE;
    case 'UNKNOWN_CATALOG_ID':
      return UNKNOWN_CATALOG_MESSAGE;
    case 'CAST_STATE_INVALID':
      return COMMIT_FAILED_MESSAGE;
    default:
      return COMMIT_FAILED_MESSAGE;
  }
}

/**
 * Commit a keep, as one transaction, for one of the four outcomes.
 *
 * Three of the four write nothing, and this returns what happened rather than a bare `void`,
 * so a caller can *say* so. That is the whole of Phase 17's "release and failed recall do not
 * mutate progression" as something a surface can render: `awarded: false, xpGained: 0,
 * outcome: 'answered-incorrect'` is a statement about progression, and the pre-Phase-17
 * callback could not make that statement because it had not decided an outcome at all.
 */
export function keepFishingCatch(
  context: FishingCatchContext,
  choice: FishingKeepChoice,
  roomId: string | null,
): FishingKeepReport {
  const session = fishingSessionSlot.current;
  if (session === null) {
    return {
      ok: false,
      awarded: false,
      duplicate: false,
      xpGained: 0,
      outcome: null,
      message: NO_SESSION_MESSAGE,
    };
  }

  const kept = fishingController.catchKeep({
    subject: {
      subjectId: session.subjectId,
      subjectName: session.subjectName,
      roomId: session.roomId,
    },
    castNumber: context.castNumber,
    catalogId: context.catalogId,
    recall: resolveRecallOutcome(choice, roomId),
  });

  if (!kept.ok) {
    return {
      ok: false,
      awarded: false,
      duplicate: false,
      xpGained: 0,
      outcome: null,
      message: refusalMessage(kept as Extract<FishingResult<never>, { ok: false }>),
    };
  }

  const progression = kept.value.progression;
  return {
    ok: true,
    // A declined resolution reports `progression: null` from the command layer by design, so
    // "wrote nothing" is a value and not an `undefined` that happened to be falsy.
    awarded: progression?.awarded ?? false,
    duplicate: progression?.duplicate ?? false,
    xpGained: progression?.xpGained ?? 0,
    outcome: kept.value.outcome as FishingKeepOutcomeName,
    message: null,
  };
}

/**
 * Throw the fish back.
 *
 * `fishing/catch-release` writes nothing at all - it does not even call the progression port -
 * and returns `progression: null`. This wrapper exists so both catch decisions come from one
 * module and one place, and so a caller that reaches for "the release path" cannot reach for
 * the store's `addFish` instead by accident.
 */
export function releaseFishingCatch(context: FishingCatchContext): FishingKeepReport {
  const session = fishingSessionSlot.current;
  if (session === null) {
    return {
      ok: false,
      awarded: false,
      duplicate: false,
      xpGained: 0,
      outcome: 'released',
      message: NO_SESSION_MESSAGE,
    };
  }

  const released = fishingController.catchRelease({
    subject: {
      subjectId: session.subjectId,
      subjectName: session.subjectName,
      roomId: session.roomId,
    },
    castNumber: context.castNumber,
    catalogId: context.catalogId,
  });

  if (!released.ok) {
    return {
      ok: false,
      awarded: false,
      duplicate: false,
      xpGained: 0,
      outcome: null,
      message: refusalMessage(released as Extract<FishingResult<never>, { ok: false }>),
    };
  }

  return {
    ok: true,
    awarded: false,
    duplicate: false,
    xpGained: 0,
    outcome: 'released',
    message: null,
  };
}

/**
 * One sentence per catch outcome, for the live region beside the pond.
 *
 * ## Why this is a table and not inline in the screen
 *
 * Because **every** branch must say something, and a branch that says nothing is a silent
 * no-op from the learner's side. Four outcomes and four sentences:
 *
 * - `answered-correct` - the only one that pays, so it is the only one that states an amount.
 * - `kept-without-recall` - the fish was kept and **nothing** was earned. That has to be said
 *   plainly: the pre-Phase-17 build paid XP here and said nothing, and a learner told they
 *   kept a fish reasonably expects to have been credited for it.
 * - `answered-incorrect` - the fish went back. Said as a fact, not as a scolding; a learner
 *   who could not recall a question is exactly the learner this activity is for.
 * - `released` - nothing happened, which is the honest report and the one the release button's
 *   own hint promises.
 *
 * A **refusal** is separate and comes first, because a refused keep is not an outcome of the
 * catch - it is a failure to record one, and reporting it as "you kept it" would be a lie the
 * learner finds out about when the fish is not in their collection.
 */
export function fishingRewardSentence(report: FishingKeepReport): string {
  if (!report.ok) return report.message ?? 'That catch could not be saved.';
  switch (report.outcome) {
    case 'answered-correct':
      if (report.duplicate) {
        return 'That fish was already recorded from this cast, so nothing was added a second time.';
      }
      return report.xpGained > 0
        ? `Kept. You gained ${report.xpGained} experience for that catch.`
        : 'Kept, and added to your collection.';
    case 'kept-without-recall':
      return 'Kept without a question, so it is in your collection but earned no experience.';
    case 'answered-incorrect':
      return 'That one did not land. The fish went back and nothing was added.';
    case 'released':
      return 'Released. Nothing was added to your collection.';
    default:
      return 'Nothing was added.';
  }
}
