/**
 * The injection seam between the award sites and the statistics layer.
 *
 * ## Why a registry rather than a direct call
 *
 * The three award sites - a note that cleared its room, a completed review pass, and a
 * kept catch - each need to tell the statistics layer that they happened, and the
 * statistics layer needs to update a session record that lives in a *different* store.
 * Calling it directly would make `progressionStore` import the application layer, which
 * already imports the stores, which is a cycle whose module-initialisation order is
 * easy to get wrong and impossible to see.
 *
 * A two-call registry with **no import-time side effect** is the alternative, and it is
 * the same shape `src/services/persistence/v2/repositorySelection.ts` and `dualWrite.ts`
 * already use for exactly this reason. The core module holds no state beyond two nullable
 * function references; the application layer installs the real implementations; every
 * caller before installation is a silent no-op, which is the correct answer for a layer
 * that has not been wired up yet (a unit test of the award sites, a rollback build).
 *
 * ## What the session-side sink is for, and what it is not
 *
 * The **authoritative** count of notes, reviews, XP, and kept fish is the per-subject
 * statistics event ledger inside the progression record, written in the **same `set` of
 * one record** as the reward and sharing the reward's identity. That is the durable,
 * exactly-once answer, and it is why nothing here is needed for correctness.
 *
 * This sink feeds the **session record's display counters** - what one session card
 * shows. Those are a second copy, on a different record, written after the award, and
 * they are deliberately not the source of any total. The cost of accepting that is one
 * lost display counter if the process dies between the reward write and the session
 * write; the benefit is that no total can ever disagree with the progression record that
 * paid for it.
 *
 * ## Why there is no separate `xp-award` activity
 *
 * XP is not a fifth event here. Every activity above carries the XP that its own award
 * paid, so the session's `xpEarned` accumulates from the same call that incremented its
 * notes or reviews. A separate XP activity would double the same XP, and the *ledger*
 * side - which is where the plan's "XP awards" event lives - is written by the store
 * action from the same reward identity, so it is exactly-once there too.
 *
 * ## Privacy
 *
 * Every payload is an app-minted identifier, an integer, or a boolean. No topic, no
 * subject name, no note text, no display name, no free text of any kind.
 */

/** One thing that happened inside an active study session. */
export type StatisticsActivity =
  /** The learner entered a room. De-duplicated per session by the session record. */
  | { readonly kind: 'room-visit'; readonly roomId: string }
  /**
   * A note submission validated and cleared its room.
   *
   * Emitted only when the reward actually happened - the store action emits nothing for
   * a suppressed duplicate, so the session counter is exactly-once by the same fact that
   * makes the award exactly-once.
   */
  | {
      readonly kind: 'note-submission';
      readonly roomId: string;
      /** Absolute XP the award paid. Never negative. */
      readonly xpAwarded: number;
    }
  /** A completed full-review pass. Emitted only when the award happened. */
  | {
      readonly kind: 'review-completion';
      readonly roomId: string;
      /** The full-review pass this completion belonged to, one-based. */
      readonly passNumber: number;
      /** Absolute XP the award paid. Never negative. */
      readonly xpAwarded: number;
    }
  /**
   * A fishing outcome.
   *
   * Both `awarded` and `declined` are reported, and only an award contributes XP or a
   * kept fish. A declined outcome - a release, or a wrong recall - is recorded on the
   * session because it is a *fact about the session*, not about progression: Phase 17's
   * invariant that a declined catch writes nothing to progression is untouched by this,
   * which records nothing to progression at all.
   */
  | {
      readonly kind: 'fishing-outcome';
      /** The canonical catalogue id of the species. Never a display name. */
      readonly catalogId: string;
      /** Which cast in the pond visit this was, one-based. */
      readonly castNumber: number;
      /** Absolute XP the award paid. Zero for a declined outcome. */
      readonly xpAwarded: number;
      /** `false` for a release or a wrong recall. */
      readonly awarded: boolean;
    }
  /**
   * A bare XP amount, for a caller that knows only a number.
   *
   * The plan names "XP awards" as an event kind, and the **durable** one is the
   * `xp-award` ledger event, which each store action writes in the same record write as its
   * reward and under that reward's identity. This activity kind exists only for a session's
   * own display counter, because the historical `trackXpEarned(xp)` export has no other
   * honest implementation: it knows an amount and nothing else.
   */
  | {
      readonly kind: 'session-xp';
      /** Absolute XP. Never negative; zero records nothing. */
      readonly amount: number;
    };

/** A canonical subject became the active subject. */
export interface SubjectActivationEvent {
  /** App-minted subject id. */
  readonly subjectId: string;
  /**
   * The subject's display name, captured at activation.
   *
   * A display name is learner-visible content but it is the learner's own subject title
   * and it is already stored on the session record and on the subject record; it is
   * never logged, never hashed, and never placed in a URL.
   */
  readonly subjectName: string;
}

export type StatisticsActivitySink = (activity: StatisticsActivity) => void;
export type SubjectActivationSink = (event: SubjectActivationEvent) => void;

/**
 * Close the open study session.
 *
 * The fifth channel, and the one `studyFlow.returnToVillage` uses.
 *
 * It is a sink rather than a call into the session service because `studyFlow.ts` is a
 * renderer-neutral application module with **no store or service dependency by
 * construction**, and a `returnToVillage` that could throw because a session write failed
 * would be a worse bug than the statistics one it fixes. The sink is also idempotent - the
 * lifecycle finds nothing open the second time - so the store-driven `activeScreen`
 * transition that also ends a session is a harmless second caller rather than a double
 * write.
 */
export type SessionEndSink = (reason: SessionEndReason) => void;

/** Why a session was closed. Codes only - never a message, never learner content. */
export type SessionEndReason =
  | 'subject-changed'
  | 'returned-to-village'
  | 'route-unmount'
  | 'pagehide'
  | 'visibility-hidden'
  | 'recovered'
  | 'requested';

let activitySink: StatisticsActivitySink | null = null;
let activationSink: SubjectActivationSink | null = null;
let sessionEndSink: SessionEndSink | null = null;

/**
 * Install the session-side statistics sink, or `null` to uninstall it.
 *
 * Called once by `src/store/sessionLifecycleBinding.ts` at bootstrap. Passing `null`
 * restores the "no statistics layer is wired" behaviour, which every unit test of the
 * award sites relies on and which a rollback build uses.
 */
export function setStatisticsActivitySink(sink: StatisticsActivitySink | null): void {
  activitySink = sink;
}

/** The installed activity sink, or `null`. */
export function currentStatisticsActivitySink(): StatisticsActivitySink | null {
  return activitySink;
}

/**
 * Report one activity.
 *
 * A silent no-op when no sink is installed, which is the documented behaviour rather than
 * an oversight: the statistics layer is optional, and a caller in the application layer
 * must not have to check whether it is present.
 */
export function emitStatisticsActivity(activity: StatisticsActivity): void {
  activitySink?.(activity);
}

/**
 * Install the subject-activation sink, or `null` to uninstall it.
 *
 * Called once by `src/store/sessionLifecycleBinding.ts`. `subjectActivation.ts` reports
 * through it, which is what makes "a session starts on canonical subject activation" true
 * without `subjectActivation.ts` importing a store.
 */
export function setSubjectActivationSink(sink: SubjectActivationSink | null): void {
  activationSink = sink;
}

/** The installed activation sink, or `null`. */
export function currentSubjectActivationSink(): SubjectActivationSink | null {
  return activationSink;
}

/** Report a canonical subject activation. A silent no-op when no sink is installed. */
export function emitSubjectActivated(event: SubjectActivationEvent): void {
  activationSink?.(event);
}

/**
 * Install the session-end sink, or `null` to uninstall it.
 *
 * Called once by `src/store/sessionLifecycleBinding.ts`.
 */
export function setSessionEndSink(sink: SessionEndSink | null): void {
  sessionEndSink = sink;
}

/** The installed session-end sink, or `null`. */
export function currentSessionEndSink(): SessionEndSink | null {
  return sessionEndSink;
}

/**
 * Request that the open study session be closed.
 *
 * A silent no-op when no sink is installed, which is the documented behaviour: the
 * statistics layer is optional, and `studyFlow.returnToVillage` must not have to check
 * whether it is present.
 */
export function endStatisticsSession(reason: SessionEndReason = 'returned-to-village'): void {
  sessionEndSink?.(reason);
}

/** Uninstall every sink. Test support, and the shape a rollback takes. */
export function resetStatisticsSinks(): void {
  activitySink = null;
  activationSink = null;
  sessionEndSink = null;
}