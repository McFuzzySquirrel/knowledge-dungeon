import type { ProgressionSnapshot } from '@/core/validation/persistence';

export const ROOM_XP_BASE = 20;
export const MAX_QUALITY_BONUS = 10;
export const MAX_STREAK_BONUS = 5;

export const PHASE_BADGE_IDS = [
  'CreatorPhaseComplete',
  'ScribePhaseComplete',
  'ArchaeologistPhaseComplete',
] as const;

export const SCRIBE_CENTURY_120_BADGE_ID = 'ScribeCentury120';
export const SCRIBE_CENTURY_120_BADGE_LABEL = 'Scribe Century (120+ Words)';

export const RANK_TIERS = [
  { rank: 'Novice', minXp: 0, maxXp: 299 },
  { rank: 'Scholar', minXp: 300, maxXp: 799 },
  { rank: 'Master', minXp: 800 },
] as const;

export type PhaseBadgeId = (typeof PHASE_BADGE_IDS)[number];
export type RankTier = (typeof RANK_TIERS)[number]['rank'];

export interface ProgressionEngineError {
  code: 'INVALID_XP_INPUT';
  message: string;
  details?: Record<string, unknown>;
}

export type ProgressionEngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProgressionEngineError };

export interface XpFormulaInput {
  qualityBonus: number;
  streakCount: number;
}

export interface XpBreakdown {
  baseXp: number;
  qualityBonus: number;
  streakBonus: number;
  totalDelta: number;
}

export interface PhaseBadgeProgressInput {
  totalRooms: number;
  creatorMappedRooms: number;
  scribeClearedRooms: number;
  archaeologistFullReviewPasses: number;
}

export interface AwardRoomClearProgressionInput {
  currentXpTotal: number;
  existingBadges: readonly string[];
  qualityBonus: number;
  streakCount: number;
  badgeProgress: PhaseBadgeProgressInput;
}

export interface AwardRoomClearProgressionOutput {
  xpBreakdown: XpBreakdown;
  xpTotalBefore: number;
  xpTotalAfter: number;
  rankBefore: RankTier;
  rankAfter: RankTier;
  progressionSnapshot: ProgressionSnapshot;
  unlockedBadges: PhaseBadgeId[];
}
