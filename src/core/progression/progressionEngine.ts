import type { ProgressionSnapshot } from '@/core/validation/persistence';

import {
  MAX_QUALITY_BONUS,
  MAX_STREAK_BONUS,
  PHASE_BADGE_IDS,
  RANK_TIERS,
  ROOM_XP_BASE,
  type AwardRoomClearProgressionInput,
  type AwardRoomClearProgressionOutput,
  type PhaseBadgeId,
  type PhaseBadgeProgressInput,
  type ProgressionEngineResult,
  type RankTier,
  type XpBreakdown,
  type XpFormulaInput,
} from './types';

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const truncated = Math.trunc(value);
  return Math.min(max, Math.max(min, truncated));
}

function hasBadge(existingBadges: readonly string[], badgeId: PhaseBadgeId): boolean {
  return existingBadges.includes(badgeId);
}

function isCreatorBadgeUnlocked(progress: PhaseBadgeProgressInput): boolean {
  if (progress.totalRooms <= 0) return false;
  return progress.creatorMappedRooms * 10 >= progress.totalRooms * 9;
}

function isScribeBadgeUnlocked(progress: PhaseBadgeProgressInput): boolean {
  if (progress.totalRooms <= 0) return false;
  return progress.scribeClearedRooms >= progress.totalRooms;
}

function isArchaeologistBadgeUnlocked(progress: PhaseBadgeProgressInput): boolean {
  return progress.archaeologistFullReviewPasses >= 2;
}

function isArchaeologistReviewPass3Unlocked(progress: PhaseBadgeProgressInput): boolean {
  return progress.archaeologistFullReviewPasses >= 3;
}

function isArchaeologistReviewPass7Unlocked(progress: PhaseBadgeProgressInput): boolean {
  return progress.archaeologistFullReviewPasses >= 7;
}

function isArchaeologistReviewPass15Unlocked(progress: PhaseBadgeProgressInput): boolean {
  return progress.archaeologistFullReviewPasses >= 15;
}

export function assignRankTier(cumulativeXp: number): RankTier {
  const safeXp = Math.max(0, Math.trunc(cumulativeXp));

  for (const tier of RANK_TIERS) {
    if ('maxXp' in tier) {
      if (safeXp >= tier.minXp && safeXp <= tier.maxXp) {
        return tier.rank;
      }
      continue;
    }
    if (safeXp >= tier.minXp) {
      return tier.rank;
    }
  }

  return 'Novice';
}

export function calculateRoomXpBreakdown(input: XpFormulaInput): XpBreakdown {
  const boundedQualityBonus = clampInteger(input.qualityBonus, 0, MAX_QUALITY_BONUS);
  const streakBonus = clampInteger(input.streakCount, 0, MAX_STREAK_BONUS);

  return {
    baseXp: ROOM_XP_BASE,
    qualityBonus: boundedQualityBonus,
    streakBonus,
    totalDelta: ROOM_XP_BASE + boundedQualityBonus + streakBonus,
  };
}

export function evaluatePhaseBadgeUnlocks(
  progress: PhaseBadgeProgressInput,
  existingBadges: readonly string[],
): PhaseBadgeId[] {
  const unlocked: PhaseBadgeId[] = [];

  if (!hasBadge(existingBadges, 'CreatorPhaseComplete') && isCreatorBadgeUnlocked(progress)) {
    unlocked.push('CreatorPhaseComplete');
  }
  if (!hasBadge(existingBadges, 'ScribePhaseComplete') && isScribeBadgeUnlocked(progress)) {
    unlocked.push('ScribePhaseComplete');
  }
  if (
    !hasBadge(existingBadges, 'ArchaeologistPhaseComplete') &&
    isArchaeologistBadgeUnlocked(progress)
  ) {
    unlocked.push('ArchaeologistPhaseComplete');
  }
  if (
    !hasBadge(existingBadges, 'ArchaeologistReviewPass3') &&
    isArchaeologistReviewPass3Unlocked(progress)
  ) {
    unlocked.push('ArchaeologistReviewPass3');
  }
  if (
    !hasBadge(existingBadges, 'ArchaeologistReviewPass7') &&
    isArchaeologistReviewPass7Unlocked(progress)
  ) {
    unlocked.push('ArchaeologistReviewPass7');
  }
  if (
    !hasBadge(existingBadges, 'ArchaeologistReviewPass15') &&
    isArchaeologistReviewPass15Unlocked(progress)
  ) {
    unlocked.push('ArchaeologistReviewPass15');
  }

  return unlocked;
}

function mergeBadges(
  existingBadges: readonly string[],
  unlockedBadges: readonly PhaseBadgeId[],
): string[] {
  const merged = [...existingBadges];
  for (const badgeId of PHASE_BADGE_IDS) {
    if (unlockedBadges.includes(badgeId) && !merged.includes(badgeId)) {
      merged.push(badgeId);
    }
  }
  return merged;
}

export function createProgressionSnapshot(input: {
  xpTotal: number;
  rank: RankTier;
  badges: readonly string[];
}): ProgressionSnapshot {
  return {
    xpTotal: Math.max(0, Math.trunc(input.xpTotal)),
    rank: input.rank,
    badges: [...input.badges],
  };
}

export function awardRoomClearProgression(
  input: AwardRoomClearProgressionInput,
): ProgressionEngineResult<AwardRoomClearProgressionOutput> {
  if (!Number.isFinite(input.currentXpTotal) || input.currentXpTotal < 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_XP_INPUT',
        message: 'Current XP total must be a finite non-negative number.',
        details: { currentXpTotal: input.currentXpTotal },
      },
    };
  }

  const xpBreakdown = calculateRoomXpBreakdown({
    qualityBonus: input.qualityBonus,
    streakCount: input.streakCount,
  });

  const xpTotalBefore = Math.trunc(input.currentXpTotal);
  const xpTotalAfter = xpTotalBefore + xpBreakdown.totalDelta;
  const rankBefore = assignRankTier(xpTotalBefore);
  const rankAfter = assignRankTier(xpTotalAfter);

  const unlockedBadges = evaluatePhaseBadgeUnlocks(input.badgeProgress, input.existingBadges);
  const mergedBadges = mergeBadges(input.existingBadges, unlockedBadges);

  return {
    ok: true,
    value: {
      xpBreakdown,
      xpTotalBefore,
      xpTotalAfter,
      rankBefore,
      rankAfter,
      progressionSnapshot: createProgressionSnapshot({
        xpTotal: xpTotalAfter,
        rank: rankAfter,
        badges: mergedBadges,
      }),
      unlockedBadges,
    },
  };
}
