/**
 * Cross-subject achievements system — Track 3c: Gameplay Depth.
 *
 * Tracks milestones across ALL subjects and awards achievements
 * for meta-progression (e.g., "Master 3 Subjects", "Write 100 Notes").
 */

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string; // icon name from theme/icons.ts
  /** How to check if the achievement is earned */
  condition: (progress: CrossSubjectProgress) => boolean;
}

export interface CrossSubjectProgress {
  /** Total number of subjects mastered (all rooms cleared + reviewed) */
  subjectsMastered: number;
  /** Total number of notes written across all subjects */
  totalNotesWritten: number;
  /** Total XP earned across all subjects */
  totalXp: number;
  /** Total number of rooms cleared across all subjects */
  totalRoomsCleared: number;
  /** Total number of review passes across all subjects */
  totalReviewPasses: number;
  /** Total number of artifacts collected across all subjects */
  totalArtifacts: number;
  /** Total number of distinct subjects created */
  totalSubjectsCreated: number;
  /** Number of boss rooms defeated */
  bossesDefeated: number;
  /** Total number of badges earned across all subjects */
  totalBadges: number;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: 'meta-master-1',
    name: 'First Mastery',
    description: 'Master your first subject (clear all rooms and complete all reviews).',
    icon: 'crown',
    condition: (p) => p.subjectsMastered >= 1,
  },
  {
    id: 'meta-master-3',
    name: 'Triple Crown',
    description: 'Master 3 different subjects.',
    icon: 'crown',
    condition: (p) => p.subjectsMastered >= 3,
  },
  {
    id: 'meta-notes-50',
    name: 'Note Taker',
    description: 'Write 50 structured notes across all subjects.',
    icon: 'scroll',
    condition: (p) => p.totalNotesWritten >= 50,
  },
  {
    id: 'meta-notes-100',
    name: 'Scribe Centurion',
    description: 'Write 100 structured notes across all subjects.',
    icon: 'scroll',
    condition: (p) => p.totalNotesWritten >= 100,
  },
  {
    id: 'meta-xp-1000',
    name: 'Scholar\'s Journey',
    description: 'Earn 1,000 total XP across all subjects.',
    icon: 'star',
    condition: (p) => p.totalXp >= 1000,
  },
  {
    id: 'meta-xp-5000',
    name: 'Grand Scholar',
    description: 'Earn 5,000 total XP across all subjects.',
    icon: 'star',
    condition: (p) => p.totalXp >= 5000,
  },
  {
    id: 'meta-rooms-100',
    name: 'Dungeon Delver',
    description: 'Clear 100 rooms across all subjects.',
    icon: 'sword',
    condition: (p) => p.totalRoomsCleared >= 100,
  },
  {
    id: 'meta-review-50',
    name: 'Dedicated Reviewer',
    description: 'Complete 50 review passes across all subjects.',
    icon: 'book',
    condition: (p) => p.totalReviewPasses >= 50,
  },
  {
    id: 'meta-artifacts-25',
    name: 'Artifact Collector',
    description: 'Collect 25 artifacts across all subjects.',
    icon: 'crystal',
    condition: (p) => p.totalArtifacts >= 25,
  },
  {
    id: 'meta-subjects-5',
    name: 'Curious Mind',
    description: 'Create 5 different subjects.',
    icon: 'compass',
    condition: (p) => p.totalSubjectsCreated >= 5,
  },
  {
    id: 'meta-boss-10',
    name: 'Boss Slayer',
    description: 'Defeat 10 boss encounters.',
    icon: 'shield',
    condition: (p) => p.bossesDefeated >= 10,
  },
  {
    id: 'meta-badges-20',
    name: 'Badge Collector',
    description: 'Earn 20 badges across all subjects.',
    icon: 'shield',
    condition: (p) => p.totalBadges >= 20,
  },
];

/**
 * Compute cross-subject progress from persisted data.
 */
export function computeCrossSubjectProgress(input: {
  bySubject: Record<string, {
    xpTotal: number;
    badges: string[];
    collectedNotes: Array<{ noteId: string }>;
    /** optional extended fields */
    subjectsMastered?: number;
    roomsCleared?: number;
    reviewPasses?: number;
    artifacts?: number;
    bossesDefeated?: number;
  }>;
  totalSubjectsCreated: number;
}): CrossSubjectProgress {
  let subjectsMastered = 0;
  let totalNotesWritten = 0;
  let totalXp = 0;
  let totalRoomsCleared = 0;
  let totalReviewPasses = 0;
  let totalArtifacts = 0;
  let bossesDefeated = 0;
  let totalBadges = 0;

  for (const subject of Object.values(input.bySubject)) {
    if (subject.subjectsMastered) subjectsMastered += 1;
    totalNotesWritten += subject.collectedNotes?.length ?? 0;
    totalXp += subject.xpTotal ?? 0;
    totalRoomsCleared += subject.roomsCleared ?? 0;
    totalReviewPasses += subject.reviewPasses ?? 0;
    totalArtifacts += subject.artifacts ?? 0;
    bossesDefeated += subject.bossesDefeated ?? 0;
    totalBadges += subject.badges?.length ?? 0;
  }

  return {
    subjectsMastered,
    totalNotesWritten,
    totalXp,
    totalRoomsCleared,
    totalReviewPasses,
    totalArtifacts,
    totalSubjectsCreated: input.totalSubjectsCreated,
    bossesDefeated,
    totalBadges,
  };
}

/**
 * Evaluate which achievements are newly unlocked.
 */
export function evaluateAchievementUnlocks(
  progress: CrossSubjectProgress,
  existingAchievementIds: readonly string[],
): Achievement[] {
  return ACHIEVEMENTS.filter(
    (ach) => !existingAchievementIds.includes(ach.id) && ach.condition(progress),
  );
}
