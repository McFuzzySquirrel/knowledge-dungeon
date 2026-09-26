/**
 * Session Tracker - logs study session start/end times, rooms visited,
 * and aggregates data for the statistics dashboard.
 *
 * Phase 4e: Study Statistics Dashboard
 *
 * Phase 4: sessions are hydrated through the application bootstrap like every
 * other store. `loadSessions` reads the legacy `localStorage` key on every call,
 * exactly as it always has, and additionally consults an injected
 * {@link SessionSource} when the storage-v2 repository is the selected one - so a
 * device running the flagged build reads its sessions from the active
 * generation and a rollback build reads the same sessions from the mirror key.
 * The legacy read happens first, so the default build's behaviour is unchanged.
 */

import { fireAndForget, writeThrough } from '@/services/persistence/v2/dualWrite';
import {
  currentStorageV2Repository,
  isStorageV2Selected,
} from '@/services/persistence/v2/repositorySelection';

export interface SessionRecord {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  subjectId: string;
  subjectName: string;
  roomsVisited: string[];
  notesSubmitted: number;
  reviewsCompleted: number;
  xpEarned: number;
}

export interface SessionStats {
  totalSessions: number;
  totalMinutesStudied: number;
  averageSessionMinutes: number;
  totalRoomsVisited: number;
  totalNotesSubmitted: number;
  totalReviewsCompleted: number;
  totalXpEarned: number;
  sessionsBySubject: Record<string, SessionRecord[]>;
  sessionsByDate: Record<string, SessionRecord[]>;
  recentStreak: number; // consecutive days with at least one session
}

const STORAGE_KEY = 'knowledge-dungeon:v1:sessions';

/** How many sessions are retained. Unchanged. */
const SESSION_RETENTION = 500;

let currentSession: SessionRecord | null = null;
let sessionSource: SessionSource | null = null;

/** An alternative read path for sessions, injected by the bootstrap. */
export interface SessionSource {
  list(): Promise<SessionRecord[]>;
}

function generateId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string'
  );
}

function readLegacySessions(): SessionRecord[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSessionRecord);
  } catch {
    return [];
  }
}

function loadSessions(): SessionRecord[] {
  return readLegacySessions();
}

/**
 * Sessions from the selected repository, merged after the legacy read.
 *
 * The legacy key is still read first and on its own, so the default build is
 * untouched; only a build that selected storage-v2 adds the generation's records
 * on top, de-duplicated by session id so a dual-written session appears once.
 */
async function loadSessionsWithSource(): Promise<SessionRecord[]> {
  const legacy = loadSessions();
  if (sessionSource === null) return legacy;
  let fromSource: SessionRecord[] = [];
  try {
    fromSource = await sessionSource.list();
  } catch {
    return legacy;
  }
  const merged = new Map<string, SessionRecord>();
  for (const session of legacy) merged.set(session.sessionId, session);
  for (const session of fromSource) merged.set(session.sessionId, session);
  return [...merged.values()].sort((left, right) => (left.startedAt < right.startedAt ? -1 : 1));
}

/**
 * Install the session read path. Called once by the application bootstrap.
 *
 * Passing `null` restores the legacy-only behaviour, which is what the default
 * build uses.
 */
export function setSessionSource(source: SessionSource | null): void {
  sessionSource = source;
}

/** The current session source, or `null` on the legacy path. */
export function currentSessionSource(): SessionSource | null {
  return sessionSource;
}

function saveSessions(sessions: SessionRecord[]): void {
  const retained = sessions.slice(-SESSION_RETENTION);
  const legacyOk = (() => {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(retained));
      return true;
    } catch {
      return false;
    }
  })();
  if (!isStorageV2Selected()) return;
  const repository = currentStorageV2Repository();
  if (repository === null) return;
  // Every session in the batch is published, keyed by its own identity, so a
  // replay of the same session overwrites its record instead of duplicating it.
  const now = new Date().toISOString();
  fireAndForget(
    'sessions',
    writeThrough({
      operation: 'sessions',
      // Lazy: the storage-v2 record adapter is not part of the default artifact.
      primary: () =>
        import('@/services/persistence/v2/appRepository').then((records) =>
          Promise.all(
            retained.map((session) => records.publishSessionToActiveGeneration(repository, session, now)),
          ),
        ).then(() => undefined),
      mirror: () => legacyOk,
    }),
  );
}

/**
 * Start a new study session for the given subject.
 */
export function startSession(subjectId: string, subjectName: string): SessionRecord {
  endCurrentSession();

  const session: SessionRecord = {
    sessionId: generateId(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    subjectId,
    subjectName,
    roomsVisited: [],
    notesSubmitted: 0,
    reviewsCompleted: 0,
    xpEarned: 0,
  };

  currentSession = session;
  return session;
}

/**
 * End the current session (if active) and persist it.
 */
/**
 * End the current session (if active) and persist it.
 *
 * On the legacy path this is synchronous and byte-identical to the pre-Phase-4
 * implementation. When a {@link SessionSource} is installed the merged read is
 * asynchronous, because the source is.
 */
export function endCurrentSession(): void {
  if (!currentSession) return;
  currentSession.endedAt = new Date().toISOString();
  const finished = { ...currentSession };
  currentSession = null;

  if (sessionSource === null) {
    const sessions = loadSessions();
    sessions.push(finished);
    saveSessions(sessions);
    return;
  }
  void loadSessionsWithSource().then((sessions) => {
    sessions.push(finished);
    saveSessions(sessions);
  });
}

/**
 * Record a room as visited during the current session.
 */
export function trackRoomVisit(roomId: string): void {
  if (!currentSession) return;
  if (!currentSession.roomsVisited.includes(roomId)) {
    currentSession.roomsVisited.push(roomId);
  }
}

/**
 * Record a note submission during the current session.
 */
export function trackNoteSubmission(): void {
  if (!currentSession) return;
  currentSession.notesSubmitted += 1;
}

/**
 * Record a review pass during the current session.
 */
export function trackReviewCompletion(): void {
  if (!currentSession) return;
  currentSession.reviewsCompleted += 1;
}

/**
 * Record XP earned during the current session.
 */
export function trackXpEarned(xp: number): void {
  if (!currentSession) return;
  currentSession.xpEarned += xp;
}

/**
 * Get the current active session, if any.
 */
export function getCurrentSession(): SessionRecord | null {
  return currentSession ? { ...currentSession } : null;
}

/**
 * Compute aggregate statistics from all recorded sessions.
 */
export function computeSessionStats(): SessionStats {
  const sessions = loadSessions();
  const sessionsBySubject: Record<string, SessionRecord[]> = {};
  const sessionsByDate: Record<string, SessionRecord[]> = {};

  for (const session of sessions) {
    const subj = session.subjectId;
    if (!sessionsBySubject[subj]) sessionsBySubject[subj] = [];
    sessionsBySubject[subj].push(session);

    const dateKey = new Date(session.startedAt).toISOString().slice(0, 10);
    if (!sessionsByDate[dateKey]) sessionsByDate[dateKey] = [];
    sessionsByDate[dateKey].push(session);
  }

  const completedSessions = sessions.filter((s) => s.endedAt !== null);
  let totalMinutes = 0;
  let totalRoomsVisited = 0;
  let totalNotesSubmitted = 0;
  let totalReviewsCompleted = 0;
  let totalXpEarned = 0;

  for (const session of completedSessions) {
    const startedMs = new Date(session.startedAt).getTime();
    const endedMs = new Date(session.endedAt!).getTime();
    totalMinutes += Math.max(0, (endedMs - startedMs) / 60000);
    totalRoomsVisited += session.roomsVisited.length;
    totalNotesSubmitted += session.notesSubmitted;
    totalReviewsCompleted += session.reviewsCompleted;
    totalXpEarned += session.xpEarned;
  }

  // Compute consecutive-day streak
  const dates = Object.keys(sessionsByDate).sort().reverse();
  let recentStreak = 0;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (dates.includes(today) || dates.includes(yesterday)) {
    let checkDate = new Date(dates.includes(today) ? today : yesterday);
      let checking = true;
      while (checking) {
        const dateKey = checkDate.toISOString().slice(0, 10);
        if (dates.includes(dateKey)) {
          recentStreak += 1;
          checkDate = new Date(checkDate.getTime() - 86400000);
        } else {
          checking = false;
        }
      }
  }

  return {
    totalSessions: completedSessions.length,
    totalMinutesStudied: Math.round(totalMinutes),
    averageSessionMinutes: completedSessions.length > 0 ? Math.round(totalMinutes / completedSessions.length) : 0,
    totalRoomsVisited,
    totalNotesSubmitted,
    totalReviewsCompleted,
    totalXpEarned,
    sessionsBySubject,
    sessionsByDate,
    recentStreak,
  };
}

/**
 * Clear all session records (for testing or data reset).
 */
export function clearAllSessions(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  currentSession = null;
}
