/**
 * Session Tracker — logs study session start/end times, rooms visited,
 * and aggregates data for the statistics dashboard.
 *
 * Phase 4e: Study Statistics Dashboard
 */

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

let currentSession: SessionRecord | null = null;

function generateId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadSessions(): SessionRecord[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is SessionRecord => typeof s === 'object' && s !== null && typeof s.sessionId === 'string');
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionRecord[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(-500))); // Keep last 500
    }
  } catch {
    // ignore
  }
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
export function endCurrentSession(): void {
  if (!currentSession) return;
  currentSession.endedAt = new Date().toISOString();

  const sessions = loadSessions();
  sessions.push({ ...currentSession });
  saveSessions(sessions);
  currentSession = null;
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
