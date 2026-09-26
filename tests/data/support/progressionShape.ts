/**
 * The canonical per-subject progression shape this gate round-trips.
 *
 * Built by hand rather than through `normalizeProgressionRecord` on purpose.
 * The gate needs a progression record whose *content* is known exactly - which
 * badges, which fish, which equipped items, which collected notes - so that a
 * semantic-equality comparison after export and import is a comparison of real
 * values and not of two values the normalizer happened to produce identically.
 *
 * The key set is the application's own
 * `CANONICAL_SUBJECT_PROGRESSION_KEYS`; `progressionShape.test.ts` pins them
 * against the real constant, so a new canonical field cannot be added without
 * this fixture noticing.
 *
 * Privacy: every string is synthetic and self-describing. The only host is the
 * reserved `example.invalid`.
 */

import {
  CANONICAL_PROGRESSION_KIND,
  CANONICAL_SUBJECT_PROGRESSION_KEYS,
  type CanonicalSubjectProgression,
} from '@/core/progression/canonicalProgression';

export interface ProgressionShapeInput {
  readonly subjectId: string;
  readonly subjectName: string;
  readonly xpTotal: number;
  readonly rank: string;
  readonly badgeCount: number;
  readonly fishCount: number;
  readonly reviewPasses: number;
}

/**
 * A canonical progression record with every list the plan names populated.
 *
 * Phase 5's exit criterion names XP, badges, inventory, equipped items, collected
 * notes, fish, and cross-subject achievements, so each of those is non-empty
 * here. An empty list would make the corresponding assertion vacuous.
 */
export function canonicalProgressionShapeFor(
  input: ProgressionShapeInput,
): Record<string, unknown> {
  const shape: CanonicalSubjectProgression = {
    subjectId: input.subjectId,
    xpTotal: input.xpTotal,
    rank: input.rank as CanonicalSubjectProgression['rank'],
    badges: Array.from({ length: input.badgeCount }, (_unused, index) =>
      `badge-data-gate-${String(index + 1).padStart(2, '0')}`,
    ),
    inventory: [
      {
        id: 'loot-data-gate-0001',
        name: 'Synthetic Data Gate Ledger',
        description: 'A synthetic inventory entry for the Phase 5 data gate.',
        rarity: 'rare',
        acquiredAt: '2026-09-12T10:00:00.000Z',
      },
      {
        id: 'loot-data-gate-0002',
        name: 'Synthetic Data Gate Inkwell',
        description: 'A second synthetic inventory entry.',
        rarity: 'common',
        acquiredAt: '2026-09-13T10:00:00.000Z',
      },
    ],
    equippedItems: [
      {
        id: 'equip-data-gate-0001',
        name: 'Synthetic Data Gate Lantern',
        description: 'An equipped item, so the equipped slot list is non-empty.',
        rarity: 'epic',
        acquiredAt: '2026-09-14T10:00:00.000Z',
        equipSlot: 'weapon',
        equipped: true,
      },
    ],
    collectedNotes: [
      {
        noteId: 'note-data-gate-0001',
        dungeonId: input.subjectId,
        roomId: `room-data-gate-${input.subjectId}`,
        topic: 'Synthetic Collected Note Topic',
        floorLabel: 'Floor 1',
        artifactPreview: 'Synthetic artifact preview.',
        noteMarkdown: '# Synthetic collected note\n\nCollected note body.\n',
        artifactMarkdown: '# Synthetic collected artifact\n',
        collectedAt: '2026-09-15T10:00:00.000Z',
      },
    ],
    streakCount: 6,
    subjectsMastered: 1,
    roomsCleared: 4,
    reviewPasses: input.reviewPasses,
    artifacts: 3,
    bossesDefeated: 1,
    fishCollection: Array.from({ length: input.fishCount }, (_unused, index) => ({
      id: `fish-data-gate-${String(index + 1).padStart(2, '0')}`,
      name: `Synthetic Gate Fish ${index + 1}`,
      rarity: (['common', 'rare', 'epic'] as const)[index % 3] ?? 'common',
      subjectId: input.subjectId,
      subjectName: input.subjectName,
      caughtAt: `2026-09-1${(index % 9) + 1}T08:00:00.000Z`,
      catalogId: `catalog-data-gate-${String(index + 1).padStart(2, '0')}`,
    })),
    // An unknown app-owned field, so "the import preserves unknown app-owned
    // fields" has something to preserve in progression too.
    extraFields: {
      fixtureProgressionField: 'preserve-this-synthetic-progression-field',
    },
  };
  return shape as unknown as Record<string, unknown>;
}

/** The real canonical key set, for the pin in the test. */
export const CANONICAL_PROGRESSION_KEY_SET: readonly string[] = CANONICAL_SUBJECT_PROGRESSION_KEYS;

/** The serialized kind marker a canonical payload carries. */
export const CANONICAL_KIND_MARKER: string = CANONICAL_PROGRESSION_KIND;
