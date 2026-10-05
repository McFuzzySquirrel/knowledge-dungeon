/**
 * The wired study-session lifecycle.
 *
 * ## The defect this exists for
 *
 * Plan 5.3 lists "session tracking functions are not wired into real gameplay" as a
 * defect that must not be carried forward, and the pre-Phase-18 state was worse than
 * "not wired":
 *
 * - `startSession`, `endCurrentSession`, `trackRoomVisit`, `trackNoteSubmission`,
 *   `trackReviewCompletion`, and `trackXpEarned` had **zero production callers**.
 * - Every `track*` began `if (!currentSession) return;` and **nothing anywhere set
 *   `currentSession`**, so even a caller would have recorded nothing.
 * - `computeSessionStats` was therefore reading an empty list and reporting zero study
 *   minutes, zero rooms, zero notes, zero reviews, and zero XP - permanently, on every
 *   device, regardless of what the learner did.
 *
 * This module is the wiring, and it is renderer-neutral: no React, no store import, no
 * DOM, no renderer. Everything it touches is an injected port, following
 * `subjectActivation.ts`, so the whole lifecycle is unit-testable without a browser.
 *
 * ## Where a session starts and ends
 *
 * **Starts** on canonical subject activation - `subjectActivation.ts`, which is the one
 * implementation of "make this subject active" and which `useLoadSubjectFlow` and the
 * village world both already call. No second activation path exists or is added here.
 *
 * **Ends** on five signals, all of which funnel through {@link
 * SessionLifecycleController.endSession}:
 *
 * | Signal | Why it is a real end, not a guess |
 * | --- | --- |
 * | a different subject is activated | the learner is somewhere else; keeping one record for two subjects would make `subjectId` a lie |
 * | return to the village | `studyFlow.returnToVillage` releases the active subject |
 * | the dungeon route unmounts | the app-level equivalent, driven by the `activeScreen` store transition |
 * | `pagehide` | the only close event a browser fires reliably; `beforeunload` is unreliable and hostile to the back/forward cache |
 * | a reliable visibility transition | `visibilitychange` to `hidden`, which is the transition a browser guarantees before it may freeze or discard a page |
 *
 * All five are idempotent, and the reason is structural rather than defensive: `endSession`
 * clears the controller's active session **before** it persists anything, so a second
 * signal in the same tick finds nothing to end. A `pagehide` that follows a
 * `visibilitychange`, a React StrictMode double effect cleanup, and a repeated close event
 * all write once.
 *
 * ## Why a session is written on every event, not only at the end
 *
 * A session record is persisted when it starts and after **every** activity, with
 * `endedAt: null` and `lastActivityAt` updated. That is what makes "never lose an
 * unterminated session" true:
 *
 * - `pagehide` and `visibilitychange` close the record for an ordinary exit, so the
 *   common case is a closed record.
 * - A crash, a force-quit, or a mobile OS reclaiming the tab leaves an `endedAt: null`
 *   record behind. {@link SessionLifecycleController.recoverUnterminatedSessions} finds
 *   it on the next start and closes it **at its own `lastActivityAt`**, not at the
 *   recovery time - so a learner who studied for four minutes and closed the laptop for
 *   two days does not have two days counted as study time. Without `lastActivityAt` the
 *   only honest alternatives were "close at now", which over-counts badly, and "close at
 *   start", which reports zero; the field exists because neither is accurate.
 *
 * `lastActivityAt` is an **additive optional field**, absent from every record written
 * before this phase and from every fixture, so no byte-comparison or archive fixture
 * changes.
 *
 * ## Why the session id is deterministic
 *
 * {@link defaultMintSessionId} is `session-<start ms in base 36>-<digest of the subject
 * id>`: the same (start instant, subject) always produces the same id, and the id factory
 * is injected so a test gets a reproducible one. The pre-Phase-18 id was
 * `Date.now() + Math.random()`, which is neither deterministic nor injectable and cannot
 * be reproduced by a test.
 *
 * Determinism buys one extra guarantee for free: because a session is persisted **keyed by
 * its own id**, two starts in the same millisecond for the same subject converge on one
 * record rather than racing to write two. The controller's own guards
 * ({@link SessionLifecycleController.handleSubjectActivated}) already prevent that, so the
 * property is belt and braces rather than load-bearing.
 *
 * ## Privacy
 *
 * A session record holds app-minted ids, four integers, a room-id list, and timestamps. No
 * topic, no note text, no artifact markdown, no keystroke, no trait, and no measurement
 * beyond elapsed time and counts. Nothing here performs a network request; the controller
 * has no I/O of its own beyond its injected persistence port.
 */
import type { SubjectActivationEvent } from '@/core/statistics/activitySink';
import type { StatisticsActivity } from '@/core/statistics/activitySink';

// ── The record ─────────────────────────────────────────────────────────────

/**
 * The session record the lifecycle owns.
 *
 * Declared structurally rather than imported from the session service, so
 * `src/application/` does not depend on `src/services/sessionTracker.ts`. The service's
 * `SessionRecord` extends it with the two optional fields it also declares, and
 * `tests/phase18/sessionLifecycle.test.ts` pins that the two agree.
 */
export interface LifecycleSessionRecord {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly subjectName: string;
  /** ISO 8601 start timestamp. */
  readonly startedAt: string;
  /** ISO 8601 end timestamp, or `null` while the session is open. */
  readonly endedAt: string | null;
  /** Distinct room ids, in first-visit order. */
  readonly roomsVisited: readonly string[];
  readonly notesSubmitted: number;
  readonly reviewsCompleted: number;
  readonly xpEarned: number;
  /**
   * ISO 8601 timestamp of the most recent recorded activity.
   *
   * Optional so every pre-Phase-18 record stays valid, and absent until an activity has
   * been recorded, so a session that started and ended cleanly writes exactly the
   * pre-Phase-18 field set.
   */
  readonly lastActivityAt?: string;
}

/** Why a session was closed. Codes only - never a message, never learner content. */
export type SessionEndReason =
  | 'subject-changed'
  | 'returned-to-village'
  | 'route-unmount'
  | 'pagehide'
  | 'visibility-hidden'
  | 'recovered'
  | 'requested';

/** What closing a session reports. */
export interface SessionEndOutcome {
  /** `true` when a session was open and has now been closed. */
  readonly ended: boolean;
  /** The closed record, or `null` when there was nothing open. */
  readonly record: LifecycleSessionRecord | null;
  readonly reason: SessionEndReason;
}

// ── Ports ──────────────────────────────────────────────────────────────────

/**
 * Where a session record is persisted.
 *
 * The port is **keyed by `sessionId`** and never returns a merged list to the caller. That
 * is the fix for the pre-Phase-18 read-modify-write race: `endCurrentSession` used to read
 * the whole stored list, push its own session onto that read, and write the result, so two
 * concurrent closes each published a list built from their own read and the second write
 * dropped the first session. A keyed write cannot lose a record, and the controller holds
 * one record at a time anyway.
 */
export interface SessionPersistencePort {
  /** Write or replace the record with this id. Must be idempotent for the same id. */
  write(record: LifecycleSessionRecord): Promise<void>;
  /** Every stored record, oldest last. Never rejects; returns `[]` on a read failure. */
  read(): Promise<readonly LifecycleSessionRecord[]>;
}

/**
 * What "is a subject active right now" means to the lifecycle.
 *
 * One read, injected, so a resume-from-background can restart a session without the
 * lifecycle importing the session store.
 */
export interface SessionSubjectPort {
  /** The active subject, or `null` when none is active. */
  readActiveSubject(): SubjectActivationEvent | null;
}

// ── Injected effects ───────────────────────────────────────────────────────

export interface SessionLifecycleDeps {
  /** The clock, in epoch milliseconds. Injected so every test is deterministic. */
  readonly nowMs: () => number;
  /** ISO form of {@link nowMs}. Defaults to the ISO form of `nowMs()`. */
  readonly nowIso?: () => string;
  /** Session-id factory. Defaults to {@link defaultMintSessionId}. */
  readonly mintSessionId?: (input: { startedAtMs: number; subjectId: string }) => string;
  /** Durability. Injected, so the controller has no I/O of its own. */
  readonly persistence: SessionPersistencePort;
  /** Lets a resume-from-background restart a session. */
  readonly subject: SessionSubjectPort;
  /**
   * Called after every persisted state change, for a surface that wants to follow the
   * active session. Codes and counts only - see the privacy note on this module.
   */
  readonly onChange?: (record: LifecycleSessionRecord | null) => void;
}

/** FNV-1a, 32-bit, eight lowercase hex digits. Same function the reward ledgers use. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The default session-id factory: deterministic in (start instant, subject).
 *
 * Two subjects starting in the same millisecond get different ids because the subject id
 * is hashed; the same subject starting twice in the same millisecond gets the same id,
 * which - because persistence is keyed by id - converges on one record rather than two.
 */
export function defaultMintSessionId(input: { startedAtMs: number; subjectId: string }): string {
  return `session-${input.startedAtMs.toString(36)}-${fnv1a32(input.subjectId)}`;
}

// ── The controller ─────────────────────────────────────────────────────────

/** Every operation a host binds. All of them are safe to call more than once. */
export interface SessionLifecycleController {
  /** The open session, or `null`. A copy; mutating it does nothing. */
  readonly activeSession: () => LifecycleSessionRecord | null;

  /**
   * Report that a subject became the active subject.
   *
   * Idempotent in both directions, which is the whole StrictMode story:
   *
   * - the **same** subject again returns the session already open and writes nothing, so
   *   a double-invoked activation cannot produce two records or two session ids;
   * - a **different** subject closes the open session with reason `subject-changed` and
   *   starts one for the new subject.
   *
   * An empty `subjectId` is refused and nothing is written.
   */
  readonly handleSubjectActivated: (event: SubjectActivationEvent) => LifecycleSessionRecord | null;

  /**
   * Record one activity against the open session.
   *
   * Returns `false` - and writes nothing - when there is no open session, so an award
   * that happens without a lifecycle wired (a unit test, a rollback build, a subject with
   * no session) costs the device nothing and reports honestly that it was not recorded.
   *
   * `room-visit` is de-duplicated by the record's own `roomsVisited` set, so walking into
   * the same room fifty times records one room. The other three kinds are expected to
   * arrive at most once per award, which the durable reward ledger already guarantees.
   */
  readonly recordActivity: (activity: StatisticsActivity) => boolean;

  /** Close the open session. Idempotent: a second call with nothing open reports `false`. */
  readonly endSession: (reason: SessionEndReason) => SessionEndOutcome;

  /** {@link endSession} with reason `returned-to-village`. */
  readonly handleReturnToVillage: () => SessionEndOutcome;

  /** {@link endSession} with reason `route-unmount`. */
  readonly handleRouteUnmount: () => SessionEndOutcome;

  /** {@link endSession} with reason `pagehide`. */
  readonly handlePageHide: () => SessionEndOutcome;

  /**
   * {@link endSession} with reason `visibility-hidden`, then start a fresh session when a
   * subject is still active.
   *
   * This is the "reliable visibility transition" the plan names, and the two halves are
   * what make backgrounded time not count as study time: the tab-away window is outside
   * both records. It is a no-op when no subject is active, so a visibility change on the
   * welcome screen starts nothing.
   */
  readonly handleVisibilityHidden: () => SessionEndOutcome;

  /**
   * Close every stored record whose `endedAt` is `null`, at its own `lastActivityAt`.
   *
   * Returns the ids it closed. Idempotent: a record that is already closed is not
   * returned and not rewritten, so calling it twice in one boot - or on every boot - costs
   * nothing. A record with no usable `lastActivityAt` is closed at its `startedAt`, which
   * reports zero minutes rather than inventing a duration.
   */
  readonly recoverUnterminatedSessions: () => Promise<readonly string[]>;
}

export function createSessionLifecycleController(
  deps: SessionLifecycleDeps,
): SessionLifecycleController {
  const nowMs = deps.nowMs;
  const nowIso = deps.nowIso ?? (() => new Date(nowMs()).toISOString());
  const mintSessionId = deps.mintSessionId ?? defaultMintSessionId;
  const onChange = deps.onChange ?? ((): void => undefined);

  let open: {
    sessionId: string;
    subjectId: string;
    subjectName: string;
    startedAt: string;
    endedAt: string | null;
    rooms: string[];
    notesSubmitted: number;
    reviewsCompleted: number;
    xpEarned: number;
    lastActivityAt: string | null;
  } | null = null;

  function snapshot(): LifecycleSessionRecord | null {
    if (open === null) return null;
    const record: LifecycleSessionRecord = {
      sessionId: open.sessionId,
      subjectId: open.subjectId,
      subjectName: open.subjectName,
      startedAt: open.startedAt,
      endedAt: open.endedAt,
      roomsVisited: [...open.rooms],
      notesSubmitted: open.notesSubmitted,
      reviewsCompleted: open.reviewsCompleted,
      xpEarned: open.xpEarned,
      ...(open.lastActivityAt === null ? {} : { lastActivityAt: open.lastActivityAt }),
    };
    return record;
  }

  function publish(record: LifecycleSessionRecord | null): void {
    // Persist before notifying, so a subscriber that reads storage sees the record that
    // matches the callback it just received.
    void deps.persistence.write(record as LifecycleSessionRecord).catch(() => {
      // A persistence failure must not break the session: the in-memory record stays
      // correct and the next activity re-publishes it. Swallowed deliberately, and the
      // port is responsible for reporting its own failure the way every other port in
      // this codebase is.
    });
    onChange(record);
  }

  function endSession(reason: SessionEndReason): SessionEndOutcome {
    if (open === null) return { ended: false, record: null, reason };
    const closing = open;
    // Cleared **before** any await or any callback, so a second end signal arriving in
    // the same tick - `pagehide` after `visibilitychange`, a StrictMode double cleanup -
    // finds nothing to end. This single ordering is what makes all five end signals
    // idempotent without a guard per signal.
    open = null;
    const endedAt = nowIso();
    closing.endedAt = endedAt;
    if (closing.lastActivityAt === null) closing.lastActivityAt = endedAt;
    const record = snapshotOf(closing);
    publish(record);
    return { ended: true, record, reason };
  }

  function snapshotOf(closing: NonNullable<typeof open>): LifecycleSessionRecord {
    return {
      sessionId: closing.sessionId,
      subjectId: closing.subjectId,
      subjectName: closing.subjectName,
      startedAt: closing.startedAt,
      endedAt: closing.endedAt,
      roomsVisited: [...closing.rooms],
      notesSubmitted: closing.notesSubmitted,
      reviewsCompleted: closing.reviewsCompleted,
      xpEarned: closing.xpEarned,
      ...(closing.lastActivityAt === null ? {} : { lastActivityAt: closing.lastActivityAt }),
    };
  }

  function handleSubjectActivated(event: SubjectActivationEvent): LifecycleSessionRecord | null {
    const subjectId = typeof event.subjectId === 'string' ? event.subjectId.trim() : '';
    if (subjectId.length === 0) return null;
    // Same subject, already open: the StrictMode double-invocation and the retried
    // activation both land here, and neither writes.
    if (open !== null && open.subjectId === subjectId) return snapshot();
    if (open !== null) endSession('subject-changed');
    const startedAtMs = nowMs();
    open = {
      sessionId: mintSessionId({ startedAtMs, subjectId }),
      subjectId,
      subjectName: typeof event.subjectName === 'string' ? event.subjectName : '',
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
      rooms: [],
      notesSubmitted: 0,
      reviewsCompleted: 0,
      xpEarned: 0,
      lastActivityAt: null,
    };
    const record = snapshot();
    if (record !== null) publish(record);
    return record;
  }

  function toAmount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
  }

  function recordActivity(activity: StatisticsActivity): boolean {
    if (open === null) return false;
    let changed = false;
    switch (activity.kind) {
      case 'room-visit': {
        const roomId = typeof activity.roomId === 'string' ? activity.roomId.trim() : '';
        // A room with no id cannot be counted and must not become an empty-string entry
        // that a later unique-room count would have to filter out.
        if (roomId.length > 0 && !open.rooms.includes(roomId)) {
          open.rooms.push(roomId);
          changed = true;
        }
        break;
      }
      case 'note-submission': {
        const roomId = typeof activity.roomId === 'string' ? activity.roomId.trim() : '';
        if (roomId.length > 0 && !open.rooms.includes(roomId)) open.rooms.push(roomId);
        open.notesSubmitted += 1;
        open.xpEarned += toAmount(activity.xpAwarded);
        changed = true;
        break;
      }
      case 'review-completion': {
        const roomId = typeof activity.roomId === 'string' ? activity.roomId.trim() : '';
        if (roomId.length > 0 && !open.rooms.includes(roomId)) open.rooms.push(roomId);
        open.reviewsCompleted += 1;
        open.xpEarned += toAmount(activity.xpAwarded);
        changed = true;
        break;
      }
      case 'fishing-outcome': {
        // A declined outcome is recorded as a fact about the session - the learner was
        // here and cast a line - but pays nothing, because Phase 17's invariant is that
        // a released fish or a wrong recall awards nothing at all.
        if (!activity.awarded) break;
        const catalogId = typeof activity.catalogId === 'string' ? activity.catalogId.trim() : '';
        if (catalogId.length === 0) break;
        open.xpEarned += toAmount(activity.xpAwarded);
        changed = true;
        break;
      }
      case 'session-xp': {
        // A bare XP bump for a caller that knows only an amount. It moves the session's
        // `xpEarned` and nothing else: no room, no note, no review. The authoritative XP
        // total is the `xp-award` event in the progression record, which the store action
        // writes in the same record write as the award itself - so this counter is
        // presentation for one session card and is never summed into a device total.
        const amount = toAmount(activity.amount);
        if (amount === 0) break;
        open.xpEarned += amount;
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    open.lastActivityAt = nowIso();
    const record = snapshot();
    if (record !== null) publish(record);
    return true;
  }

  function handleVisibilityHidden(): SessionEndOutcome {
    const outcome = endSession('visibility-hidden');
    // Backgrounded time must not become study time, and the tab-away window has to land
    // outside both records. Restarting here - rather than waiting for the next activation
    // signal, which may never come - is what makes the session survive the background at
    // all: without it, every award after the resume would find no open session and record
    // nothing.
    const active = deps.subject.readActiveSubject();
    if (active !== null) handleSubjectActivated(active);
    return outcome;
  }

  async function recoverUnterminatedSessions(): Promise<readonly string[]> {
    const records = await deps.persistence.read();
    const closed: string[] = [];
    for (const record of records) {
      if (record.endedAt !== null) continue;
      const endedAt = record.lastActivityAt ?? record.startedAt;
      const recovered: LifecycleSessionRecord = {
        ...record,
        endedAt,
        ...(record.lastActivityAt === undefined ? { lastActivityAt: record.startedAt } : {}),
      };
      await deps.persistence.write(recovered);
      closed.push(record.sessionId);
    }
    return closed;
  }

  return {
    activeSession: snapshot,
    handleSubjectActivated,
    recordActivity,
    endSession,
    handleReturnToVillage: () => endSession('returned-to-village'),
    handleRouteUnmount: () => endSession('route-unmount'),
    handlePageHide: () => endSession('pagehide'),
    handleVisibilityHidden,
    recoverUnterminatedSessions,
  };
}