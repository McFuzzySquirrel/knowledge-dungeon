/**
 * Study Statistics Dashboard
 *
 * Phase 4e: Displays aggregate study statistics including
 * time spent, rooms per session, retention trends, review streaks,
 * and due review counts.
 */
import { useMemo, type JSX } from 'react';
import { computeSessionStats } from '@/services/sessionTracker';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { isReviewableRoom, summarizeReviewAnalytics } from '@/core/review';
import { usePreferencesStore } from '@/store/preferencesStore';

interface Props {
  onClose: () => void;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function StudyStatsPanel({ onClose }: Props): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  const bySubject = useProgressionStore((s) => s.bySubject);
  const colorTheme = usePreferencesStore((s) => s.colorTheme);

  const sessionStats = useMemo(() => computeSessionStats(), []);
  const reviewData = useMemo(() => {
    if (!snapshot) return null;

    const reviewableRoomIds = Object.values(snapshot.rooms)
      .filter((room) => isReviewableRoom(room))
      .map((room) => room.roomId);

    const currentSubject = bySubject[snapshot.dungeon.dungeonId];
    return summarizeReviewAnalytics({
      rooms: snapshot.rooms,
      reviewableRoomIds,
      currentReviewStreak: currentSubject?.streakCount ?? 0,
      longestReviewStreak: 0,
    });
  }, [snapshot, bySubject]);

  const subjectStats = useMemo(() => {
    if (!snapshot) return null;
    const subj = bySubject[snapshot.dungeon.dungeonId];
    return {
      totalRooms: snapshot.dungeon.rooms.length,
      clearedRooms: Object.values(snapshot.rooms).filter((r) => r.validationState.finalPass).length,
      xpTotal: subj?.xpTotal ?? 0,
      rank: subj?.rank ?? 'Novice',
      badges: subj?.badges ?? [],
      streakCount: subj?.streakCount ?? 0,
    };
  }, [snapshot, bySubject]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Study statistics">
      <div className="modal study-stats-panel" data-theme={colorTheme}>
        <div className="stats-header">
          <h2>Study Statistics</h2>
          <button type="button" onClick={onClose} aria-label="Close statistics">
            Close
          </button>
        </div>

        {/* ── Overview cards ────────────────────────────────────── */}
        <section className="stats-overview">
          <div className="stats-card">
            <span className="stats-card-label">Total Sessions</span>
            <strong className="stats-card-value">{sessionStats.totalSessions}</strong>
          </div>
          <div className="stats-card">
            <span className="stats-card-label">Study Time</span>
            <strong className="stats-card-value">{formatMinutes(sessionStats.totalMinutesStudied)}</strong>
          </div>
          <div className="stats-card">
            <span className="stats-card-label">Avg Session</span>
            <strong className="stats-card-value">{formatMinutes(sessionStats.averageSessionMinutes)}</strong>
          </div>
          <div className="stats-card">
            <span className="stats-card-label">Daily Streak</span>
            <strong className="stats-card-value">{sessionStats.recentStreak} days</strong>
          </div>
        </section>

        {/* ── Activity summary ──────────────────────────────────── */}
        <section className="stats-section">
          <h3>Activity</h3>
          <div className="stats-row">
            <span>Rooms visited</span>
            <strong>{sessionStats.totalRoomsVisited}</strong>
          </div>
          <div className="stats-row">
            <span>Notes submitted</span>
            <strong>{sessionStats.totalNotesSubmitted}</strong>
          </div>
          <div className="stats-row">
            <span>Reviews completed</span>
            <strong>{sessionStats.totalReviewsCompleted}</strong>
          </div>
          <div className="stats-row">
            <span>Total XP earned</span>
            <strong>{sessionStats.totalXpEarned}</strong>
          </div>
        </section>

        {/* ── Current subject stats ─────────────────────────────── */}
        {subjectStats ? (
          <section className="stats-section">
            <h3>Current Subject: {snapshot?.dungeon.subjectName}</h3>
            <div className="stats-row">
              <span>Progress</span>
              <strong>{subjectStats.clearedRooms}/{subjectStats.totalRooms} rooms</strong>
            </div>
            <div className="stats-row">
              <span>Total XP</span>
              <strong>{subjectStats.xpTotal}</strong>
            </div>
            <div className="stats-row">
              <span>Rank</span>
              <strong>{subjectStats.rank}</strong>
            </div>
            <div className="stats-row">
              <span>Streak</span>
              <strong>{subjectStats.streakCount}</strong>
            </div>
            {subjectStats.badges.length > 0 ? (
              <div className="stats-row">
                <span>Badges ({subjectStats.badges.length})</span>
                <span className="stats-badges">{subjectStats.badges.join(', ')}</span>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ── Review / Retention ────────────────────────────────── */}
        {reviewData ? (
          <section className="stats-section">
            <h3>Review & Retention</h3>
            <div className="stats-row">
              <span>Reviewable rooms</span>
              <strong>{reviewData.totalReviewableRooms}</strong>
            </div>
            <div className="stats-row">
              <span>Rooms reviewed</span>
              <strong>{reviewData.reviewedRoomCount}</strong>
            </div>
            <div className="stats-row">
              <span>Full review passes</span>
              <strong>{reviewData.fullReviewPasses}</strong>
            </div>
            <div className="stats-row">
              <span>Due today</span>
              <strong style={{ color: reviewData.dueTodayCount > 0 ? 'var(--accent)' : undefined }}>
                {reviewData.dueTodayCount}
              </strong>
            </div>
            <div className="stats-row">
              <span>Overdue reviews</span>
              <strong style={{ color: reviewData.overdueReviewCount > 0 ? 'var(--bad)' : undefined }}>
                {reviewData.overdueReviewCount}
              </strong>
            </div>
            <div className="stats-row">
              <span>Avg ease factor</span>
              <strong>{reviewData.averageEaseFactor}</strong>
            </div>
          </section>
        ) : null}

        {/* ── Recent sessions ───────────────────────────────────── */}
        {sessionStats.totalSessions > 0 ? (
          <section className="stats-section">
            <h3>Recent Sessions</h3>
            <div className="stats-session-list">
              {Object.entries(sessionStats.sessionsByDate)
                .sort(([a], [b]) => b.localeCompare(a))
                .slice(0, 10)
                .map(([date, records]) => {
                  const totalMinutes = records
                    .filter((r) => r.endedAt)
                    .reduce((sum, r) => {
                      const dur = (new Date(r.endedAt!).getTime() - new Date(r.startedAt).getTime()) / 60000;
                      return sum + Math.max(0, Math.round(dur));
                    }, 0);

                  return (
                    <div key={date} className="stats-session-row">
                      <span>{formatDate(date)}</span>
                      <span>{records.length} session{records.length !== 1 ? 's' : ''}</span>
                      <span>{formatMinutes(totalMinutes)}</span>
                    </div>
                  );
                })}
            </div>
          </section>
        ) : null}

        {/* ── Per-subject breakdown ─────────────────────────────── */}
        {Object.keys(sessionStats.sessionsBySubject).length > 0 ? (
          <section className="stats-section">
            <h3>By Subject</h3>
            {Object.entries(sessionStats.sessionsBySubject)
              .sort(([, a], [, b]) => b.length - a.length)
              .slice(0, 10)
              .map(([subjectId, records]) => {
                const subjectName = records[0]?.subjectName ?? subjectId;
                const totalMinutes = records
                  .filter((r) => r.endedAt)
                  .reduce((sum, r) => {
                    const dur = (new Date(r.endedAt!).getTime() - new Date(r.startedAt).getTime()) / 60000;
                    return sum + Math.max(0, Math.round(dur));
                  }, 0);

                return (
                  <div key={subjectId} className="stats-session-row">
                    <span style={{ fontWeight: 500 }}>{subjectName}</span>
                    <span>{records.length} sessions</span>
                    <span>{formatMinutes(totalMinutes)}</span>
                  </div>
                );
              })}
          </section>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
