/**
 * The statistics store: the published {@link StatisticsSnapshot} and its selectors.
 *
 * ## Why this store exists, and why it is a *reader*
 *
 * Plan 18's expected files list `src/store/statisticsStore.ts`, and this is it. It holds
 * **no new persistence**. Everything it publishes is derived, on demand, from two sources
 * that already exist and already own their data:
 *
 * - **session records**, read through `src/services/sessionTracker.ts` - the legacy
 *   `localStorage` key plus the injected storage-v2 source, through the one validator that
 *   untrusted restored input must pass; and
 * - **per-subject progression records**, read from `useProgressionStore` - which is where
 *   the room-clear, review-pass, and catch reward ledgers and the Phase 18 statistics event
 *   ledger all live, in the records' preserved app-owned fields.
 *
 * That is deliberate. Statistics are **derived from centralized events, not duplicated UI
 * counters**, and a store that persisted its own copy of "notes submitted" would be exactly
 * the duplication the plan forbids: two answers to one question, drifting on the first failed
 * write. So this store caches a snapshot and invalidates it, and nothing else.
 *
 * ## What is and is not reported, and for which subject
 *
 * A device holds **one loaded subject graph**, so the graph-derived numbers - rooms cleared,
 * review due or overdue, mastery - are reported for the subject currently open and report
 * their empty values for every other subject. The event-derived numbers - notes, reviews, XP,
 * kept fish - are reported for **every** subject, because they live in that subject's
 * progression record and do not need the graph.
 *
 * That asymmetry is stated on the type ({@link SubjectStatistics.snapshot} carries `null`)
 * rather than left for a surface to discover, and it is the honest answer: claiming a
 * completion ratio for a subject whose rooms this device does not have would be inventing
 * evidence.
 *
 * ## Invalidation, and why it is explicit
 *
 * The snapshot is recomputed when {@link StatisticsStoreState.refresh} or
 * {@link StatisticsStoreState.hydrateSessions} is called, and marked for recomputation by
 * {@link StatisticsStoreState.invalidate}. {@link installStatisticsStoreBinding} wires the
 * invalidation to the three stores the snapshot derives from. Deriving it lazily on every
 * read would rebuild a whole-device aggregate on every unrelated progression write, so the
 * explicit invalidation is both cheaper and more predictable.
 *
 * ## Empty and restored states are the same shape
 *
 * `snapshot` is always a {@link StatisticsSnapshot}, never `null`, so a surface has no `null`
 * branch to get wrong. A device with nothing recorded hydrates
 * {@link emptyStatisticsSnapshot}, and a device whose records failed to parse hydrates the
 * same thing - `provenance` says which, rather than the shape changing underneath a panel.
 */
import { create } from 'zustand';
import {
  emptyStatisticsSnapshot,
  type StatisticsSnapshot,
  type SubjectStatistics,
  type SubjectStatisticsInput,
} from '@/core/statistics/statisticsMetrics';
import { readStatisticsEventLedgerFromFields } from '@/core/statistics/statisticsEvents';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import {
  computeStatisticsFromRecords,
  pendingSessionWrites,
  readSessionRecords,
  type SessionRecord,
} from '@/services/sessionTracker';

export interface StatisticsStoreState {
  /**
   * The published snapshot. Never `null`.
   *
   * Recomputed by {@link refresh}, {@link hydrateSessions}, and the window setters. A
   * surface subscribes to this field and re-reads; it never needs to know whether the value
   * it holds is the freshest one.
   */
  readonly snapshot: StatisticsSnapshot;
  /** Days in the daily-activity chart. Defaults to 14. */
  readonly dailyActivityDays: number;
  /** How many sessions the recent-sessions list holds. Defaults to 10. */
  readonly recentSessionLimit: number;

  /**
   * Publish a session record set and rebuild.
   *
   * Called once by the bootstrap with whatever the selected repository produced, and by any
   * host that has just restored an archive. `null` means "nothing is stored, or the read
   * failed", which hydrates the same empty snapshot a new browser profile produces: a
   * restored archive that cannot be parsed must not leave a surface with no shape to render.
   *
   * The records are validated before they are stored here, so a hand-edited archive cannot
   * put a value into the metrics that the rest of the application would refuse.
   */
  hydrateSessions: (sessions: readonly SessionRecord[] | null) => void;
  /** Rebuild the snapshot from the current store state. */
  refresh: () => void;
  /** Rebuild with an explicit clock, for a host rendering a specific day. */
  refreshAt: (now: Date) => void;
  /** Set the daily-activity window, and rebuild. */
  setDailyActivityDays: (days: number) => void;
  /** Set the recent-session limit, and rebuild. */
  setRecentSessionLimit: (limit: number) => void;
  /** Build one subject's input from the stores, the way this store does. */
  readSubjectInputs: () => readonly SubjectStatisticsInput[];
}

/**
 * One subject's statistics input, assembled from the stores.
 *
 * Exported so a host that computes a snapshot itself - a test, a print view, an export -
 * assembles the input the same way the store does, instead of reimplementing the join.
 */
export function buildSubjectStatisticsInputs(): SubjectStatisticsInput[] {
  const bySubject = useProgressionStore.getState().bySubject;
  const snapshot = useSubjectStore.getState().snapshot;
  const loadedSubjectId = snapshot?.dungeon.dungeonId ?? null;
  const inputs: SubjectStatisticsInput[] = [];

  for (const [subjectId, progression] of Object.entries(bySubject)) {
    inputs.push({
      subjectId,
      // A live subject's current name always wins, exactly as `sessionsFrom` resolves it on
      // the storage-v2 read: the progression record carries no name to disagree with.
      subjectName:
        subjectId === loadedSubjectId && snapshot !== null
          ? snapshot.dungeon.subjectName
          : subjectId,
      snapshot: subjectId === loadedSubjectId ? snapshot : null,
      progression,
      events: readStatisticsEventLedgerFromFields(progression.extraFields).events,
    });
  }

  // A loaded subject with no progression record still belongs in the snapshot: it is the
  // one whose rooms and review state the dashboard can report, and omitting it would make a
  // fresh subject invisible.
  if (snapshot !== null && bySubject[snapshot.dungeon.dungeonId] === undefined) {
    inputs.push({
      subjectId: snapshot.dungeon.dungeonId,
      subjectName: snapshot.dungeon.subjectName,
      snapshot,
      progression: null,
      events: [],
    });
  }
  return inputs;
}

function buildSnapshot(
  state: Pick<StatisticsStoreState, 'dailyActivityDays' | 'recentSessionLimit'>,
  now: Date,
  sessions: readonly SessionRecord[],
): StatisticsSnapshot {
  return computeStatisticsFromRecords({
    sessions,
    subjects: buildSubjectStatisticsInputs(),
    now,
    dailyActivityDays: state.dailyActivityDays,
    recentSessionLimit: state.recentSessionLimit,
  });
}

export const useStatisticsStore = create<StatisticsStoreState>((set, get) => ({
  snapshot: emptyStatisticsSnapshot(new Date()),
  dailyActivityDays: 14,
  recentSessionLimit: 10,

  hydrateSessions(sessions) {
    set({
      snapshot: buildSnapshot(
        get(),
        new Date(),
        sessions ?? readSessionRecords(),
      ),
    });
  },

  refresh() {
    set({ snapshot: buildSnapshot(get(), new Date(), readSessionRecords()) });
  },

  refreshAt(now) {
    set({ snapshot: buildSnapshot(get(), now, readSessionRecords()) });
  },

  setDailyActivityDays(days) {
    set({
      dailyActivityDays: Math.max(0, Math.trunc(days)),
      snapshot: buildSnapshot(get(), new Date(), readSessionRecords()),
    });
  },

  setRecentSessionLimit(limit) {
    set({
      recentSessionLimit: Math.max(0, Math.trunc(limit)),
      snapshot: buildSnapshot(get(), new Date(), readSessionRecords()),
    });
  },

  readSubjectInputs: buildSubjectStatisticsInputs,
}));

/**
 * The published snapshot for a React surface.
 *
 * The one import a statistics surface needs:
 *
 * ```tsx
 * const { totals, subjects, dailyActivity, recentSessions, todayKey } = useStatistics();
 * ```
 */
export function useStatistics(): StatisticsSnapshot {
  return useStatisticsStore((state) => state.snapshot);
}

/**
 * One subject's row, or `undefined` when the snapshot has none.
 *
 * `undefined` is the honest answer for a subject id the device holds no records for: a
 * subject with no data has no statistics, and inventing zeros would make "no data" look
 * like "nothing achieved".
 */
export function selectSubjectStatistics(
  state: StatisticsStoreState,
  subjectId: string,
): SubjectStatistics | undefined {
  return state.snapshot.subjects.find((subject) => subject.subjectId === subjectId);
}

/**
 * Install the subscriptions that rebuild the snapshot when its sources change.
 *
 * Returns a disposer. Called once by `src/store/sessionLifecycleBinding.ts`, so one module
 * knows the statistics store is wired to three other stores and a test can install and remove
 * the wiring without touching module state.
 *
 * Subscribes to:
 *
 * - `useProgressionStore` - a reward ledger, a statistics event, or any counter;
 * - `useSubjectStore` - the loaded graph, which drives every mastery and review number;
 * - `useSessionStore` - `focusedRoomId`, because the session-derived room totals move as
 *   rooms are entered.
 *
 * The subscriptions **invalidate** rather than rebuild, so a burst of writes in one tick
 * costs one rebuild rather than one per write. The lifecycle controller's own `onChange` is
 * deliberately not subscribed: it fires on every activity, and `focusedRoomId` already
 * covers the room-visit case, so subscribing to both would rebuild twice per room entry.
 */
export function installStatisticsStoreBinding(): () => void {
  let scheduled = false;
  const invalidate = (): void => {
    if (scheduled) return;
    scheduled = true;
    // One rebuild per tick, whatever the number of writes in it.
    queueMicrotask(() => {
      scheduled = false;
      useStatisticsStore.getState().refresh();
    });
  };
  const unsubscribes = [
    useProgressionStore.subscribe(invalidate),
    useSubjectStore.subscribe(invalidate),
    useSessionStore.subscribe(invalidate),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * Await the session write queue, then rebuild the snapshot.
 *
 * A host that has just closed a session and wants the dashboard to show it immediately calls
 * this; without it the rebuild races the session's own persistence and reads the pre-close
 * record set.
 */
export async function flushStatistics(): Promise<void> {
  await pendingSessionWrites();
  useStatisticsStore.getState().refresh();
}