/**
 * Synthetic fixtures for the progression write-path tests.
 *
 * Kept out of the test bodies so the write-path suites seed byte-identical
 * devices and a difference in outcome can never be explained by a difference in
 * setup. Every value is synthetic; nothing here is learner data.
 *
 * Repository lifecycle is not here: the write-path suite uses the same
 * `openRepo`/`dropRepo` helpers as the other phase-4 suites, so a database is
 * named and dropped the same way everywhere.
 */
import type { SubjectSnapshot } from '@/core/validation/persistence';

import { MIGRATION_NOW, readSubjectFixture } from '../../migrations/support/storageV2TestSupport';

export const now = MIGRATION_NOW;
export const SUBJECT_A = 'subject-write-a';
export const SUBJECT_B = 'subject-write-b';
export const SUBJECT_ID = SUBJECT_A;
export const SECOND_SUBJECT_ID = SUBJECT_B;

function subjectSnapshot(): SubjectSnapshot {
  return JSON.parse(readSubjectFixture('subject-1.1.0-minimal.json')) as SubjectSnapshot;
}

/**
 * A device holding two subjects and a v3 progression payload, with a distinct
 * value per subject.
 *
 * Two subjects because every interesting write-path failure needs to be
 * distinguishable from a merge: a payload that collapsed onto one record still
 * *has* two subjects' worth of data somewhere.
 */
export function seedTwoSubjectDevice(): void {
  window.localStorage.clear();
  const base = subjectSnapshot();
  window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_A, SUBJECT_B]));
  window.localStorage.setItem(
    `knowledge-dungeon:v1:subject:${SUBJECT_A}`,
    JSON.stringify({ ...base, dungeon: { ...base.dungeon, dungeonId: SUBJECT_A } }),
  );
  window.localStorage.setItem(
    `knowledge-dungeon:v1:subject:${SUBJECT_B}`,
    JSON.stringify({ ...base, dungeon: { ...base.dungeon, dungeonId: SUBJECT_B } }),
  );
  window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_A);
  window.localStorage.setItem(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_A]: { xpTotal: 17, badges: ['synthetic-seed-a'], fishCollection: [] },
        [SUBJECT_B]: { xpTotal: 5, badges: ['synthetic-seed-b'], fishCollection: [] },
      },
      crossSubjectAchievements: ['synthetic-seed-cross'],
    }),
  );
}

/**
 * A v1 flat progression payload: the shape with no `version` and no `bySubject`,
 * which the normaliser files as one record under the legacy bucket.
 */
export function syntheticFlatV1Payload(): {
  xpTotal: number;
  badges: string[];
  rank: string;
  fishCollection: unknown[];
} {
  return {
    xpTotal: 42,
    badges: ['synthetic-v1-badge'],
    rank: 'Novice',
    fishCollection: [],
  };
}
