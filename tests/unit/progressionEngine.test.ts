import { describe, expect, it } from 'vitest';
import {
  assignRankTier,
  awardRoomClearProgression,
  calculateRoomXpBreakdown,
  evaluatePhaseBadgeUnlocks,
} from '@/core/progression';

describe('progressionEngine', () => {
  it('assigns rank tiers based on XP', () => {
    expect(assignRankTier(0)).toBe('Novice');
    expect(assignRankTier(299)).toBe('Novice');
    expect(assignRankTier(300)).toBe('Scholar');
    expect(assignRankTier(800)).toBe('Master');
  });

  it('clamps quality bonus and streak inputs', () => {
    const breakdown = calculateRoomXpBreakdown({ qualityBonus: 99, streakCount: -3 });
    expect(breakdown.qualityBonus).toBe(10);
    expect(breakdown.streakBonus).toBe(0);
    expect(breakdown.totalDelta).toBe(30);
  });

  it('unlocks phase badges when thresholds are met', () => {
    const unlocked = evaluatePhaseBadgeUnlocks(
      {
        totalRooms: 4,
        creatorMappedRooms: 4,
        scribeClearedRooms: 4,
        archaeologistFullReviewPasses: 2,
      },
      [],
    );
    expect(unlocked).toContain('CreatorPhaseComplete');
    expect(unlocked).toContain('ScribePhaseComplete');
    expect(unlocked).toContain('ArchaeologistPhaseComplete');
  });

  it('returns a progression snapshot from awardRoomClearProgression', () => {
    const result = awardRoomClearProgression({
      currentXpTotal: 280,
      existingBadges: [],
      qualityBonus: 6,
      streakCount: 1,
      badgeProgress: {
        totalRooms: 2,
        creatorMappedRooms: 2,
        scribeClearedRooms: 1,
        archaeologistFullReviewPasses: 0,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.xpTotalAfter).toBe(280 + 20 + 6 + 1);
    expect(result.value.rankAfter).toBe('Scholar');
    expect(result.value.rankBefore).toBe('Novice');
  });
});
