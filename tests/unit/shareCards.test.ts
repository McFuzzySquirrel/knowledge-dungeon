/**
 * Phase 20 - the share-card model.
 *
 * ## Why this file exists
 *
 * `npm test -- tests/unit/shareCards.test.ts` is the plan's named verification command for Phase 20
 * (docs/plans/001-cozy-pixi-rebuild.md, "Phase 20 / Verification"), and the file did not exist: the
 * command exited 0 having run nothing. Phase 19 found the same thing with
 * `tests/unit/assistanceEngine.test.ts`, which is how a vacuous gate comes to look exactly like a
 * passing one. This file is real, and it is the file the plan names.
 *
 * ## What it pins
 *
 * The three defects `src/ui/utils/progressionShareExport.ts` still carries, one of which the model
 * exists to make structurally impossible:
 *
 * | Pre-Phase-20 behaviour | Property here |
 * | --- | --- |
 * | `• ${badge}` printed a **raw badge id** | `canonicalBadgeLabel` resolves every id; an unknown id produces **no row** and never the id - `P1`, `P2` |
 * | `Generated: ${new Date().toLocaleString()}` | the model has no clock, no date field, and no `now` parameter; the serialized model contains no ISO date and no locale-formatted string - `P3`, `P4` |
 * | hardcoded `#141a2c` / `'Inter, sans-serif'` | the model carries no style value at all, and its runtime closure reaches nothing outside `src/core/` - `P5` |
 *
 * Plus the properties the renderer depends on and Phase 19 proved are easy to lose:
 *
 * - `P6` determinism: same input plus same selection is byte-identical output, and order of the
 *   requested selection never changes the result.
 * - `P7` totals: nothing is selectable that the model will not build from counts.
 * - `P8` honesty: a missing input is an **omitted** row, not a zero, and a zero is not omitted.
 * - `P9` totality: empty and hostile inputs do not throw - zero rooms, zero fish, an unstarted
 *   subject, unknown badge ids, and a subject name that is empty, whitespace, 500 characters, emoji,
 *   RTL, or contains a path separator.
 * - `P10` denylist reachability: a selection carrying a denied value, an unknown field, or a raw
 *   identifier cannot make a row appear.
 *
 * ## The one external dependency, clearly marked
 *
 * `canonicalBadgeLabel` and `SHARE_CARD_FIELD_LABELS` are **owned by `village-content-designer`**, in
 * `src/core/share/shareCardContent.ts` - a file this change does not create and this test does not
 * own. The tests below are written against the shape that file is contracted to export:
 *
 * ```ts
 * export function canonicalBadgeLabel(badgeId: string): string | undefined;
 * export const SHARE_CARD_FIELD_LABELS: Readonly<Record<ShareCardField, string>>;
 * export function shareCardTitle(kind: ShareCardKind): string;
 * export function shareCardCaption(kind: ShareCardKind): string;
 * ```
 *
 * Two tests ({@link canonical badge labels resolve through the content module} and the
 * {@link field labels} block) are therefore **contract tests**: they assert the properties a card
 * depends on - an unknown id yields `undefined`, every declared field has a non-empty label, titles
 * and captions are non-empty and kind-distinct - rather than any particular English string. They
 * pass against any correct implementation of that shape and fail against the `?? badgeId` fallback
 * this phase exists to remove.
 *
 * Privacy: every string in this file is synthetic. No real subject, note, room, or learner text
 * appears here.
 */
import { describe, expect, it } from 'vitest';

import {
  FISHING_BADGE_IDS,
  PHASE_BADGE_IDS,
  RANK_TIERS,
  SCRIBE_CENTURY_120_BADGE_ID,
} from '@/core/progression/types';
import {
  countByRarity,
  countCanonicalCatalogTypes,
  countUniqueTypes,
  toCanonicalFishCollection,
} from '@/core/fishing/fishCollectionService';
import type { FishEntry } from '@/core/fishing/fishingTypes';
import { computeStatisticsSnapshot, emptyStatisticsSnapshot } from '@/core/statistics/statisticsMetrics';
import {
  canonicalBadgeLabel,
  SHARE_CARD_FIELD_LABELS,
  shareCardCaption,
  shareCardTitle,
} from '@/core/share/shareCardContent';
import {
  availableFieldsFor,
  captionForKind,
  fieldsInModel,
  isEmptyShareCardModel,
  titleForKind,
  buildShareCardModel,
} from '@/core/share/shareCardModel';
import { defaultSelectionFor, mayValueAppearOnCard } from '@/core/share/shareCardPolicy';
import {
  SHARE_CARD_FIELDS,
  SHARE_CARD_KINDS,
  type ShareCardBadgeListRow,
  type ShareCardBuildInput,
  type ShareCardCountRow,
  type ShareCardField,
  type ShareCardGroupRow,
  type ShareCardModel,
  type ShareCardRatioRow,
} from '@/core/share/types';

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────

/**
 * A deliberately hostile device state.
 *
 * Everything that could reach a card is here: a long emoji-and-RTL name, an unknown badge id, a
 * duplicated known badge id, non-finite counts, negative counts, fractional counts, and a fish
 * record whose rarity keys are in a scrambled insertion order. The model must produce a truthful
 * card from this without throwing and without echoing any of it back as an identifier.
 */
const HOSTILE_INPUT: ShareCardBuildInput = {
  kind: 'subject-summary',
  subjectName: '  \u202e\u{1f409}\u{1f41f} RTL \u{1f525} reversed  ',
  progression: { xpTotal: 1234.9, rank: 'Master' },
  rooms: { total: 40, cleared: 12 },
  badges: [SCRIBE_CENTURY_120_BADGE_ID, SCRIBE_CENTURY_120_BADGE_ID, 'NotARealBadgeId'],
  inventoryCount: 7,
  collectedNoteCount: 3,
  fish: {
    total: 11,
    uniqueTypes: 4,
    countsByRarity: { epic: 1, common: 6, rare: 4 },
  },
  statistics: {
    sessionsCompleted: 9,
    activeDays: 21,
    studyStreakDays: 5,
    recall: { correct: 17, total: 20 },
  },
  assistance: { sessionsWithAssistance: 4 },
};

function rowFor(model: ShareCardModel, field: ShareCardField): ShareCardModel['rows'][number] | null {
  return model.rows.find((row) => row.field === field) ?? null;
}

function countFor(model: ShareCardModel, field: ShareCardField): number | null {
  const row = rowFor(model, field);
  return row && 'value' in row ? (row as ShareCardCountRow).value : null;
}

/** Every string reachable in a model, for the "nothing private is in here" assertions. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) stringsIn(entry, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      stringsIn(entry, into);
    }
  }
  return into;
}

// ── P1/P2: canonical badge labels, never a raw id ────────────────────────────────────────────

describe('canonical badge labels resolve through the content module', () => {
  // CONTRACT TEST against `src/core/share/shareCardContent.ts`, owned by
  // `village-content-designer`. Asserts the shape, not particular English.

  it('returns a non-empty label for every canonical badge id, and undefined for an unknown one', () => {
    for (const badgeId of [...PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID, ...FISHING_BADGE_IDS]) {
      const label = canonicalBadgeLabel(badgeId);
      expect(typeof label, `canonicalBadgeLabel(${badgeId}) must be a string`).toBe('string');
      expect((label as string).trim().length).toBeGreaterThan(0);
      // A label that *is* the id would defeat the whole phase.
      expect(label).not.toBe(badgeId);
    }
    expect(canonicalBadgeLabel('NotARealBadgeId')).toBeUndefined();
    expect(canonicalBadgeLabel('')).toBeUndefined();
  });

  it('never falls back to the raw id for an id it does not recognise', () => {
    // The exact pre-Phase-20 defect: `BADGE_LABELS[badgeId] ?? badgeId`. A fallback, in any
    // spelling, would put `CreatorPhaseComplete` on an image.
    for (const unknownId of [
      'NotARealBadgeId',
      'CreatorPhaseComplete-ish',
      'ScribeCentury121',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      const label = canonicalBadgeLabel(unknownId);
      expect(label === undefined || label !== unknownId, `no fallback for ${unknownId}`).toBe(true);
    }
  });

  it('is total: any string is answerable and nothing throws', () => {
    for (const value of ['', ' ', 'x'.repeat(5000), 'é', '\u202e', '0', 'null']) {
      expect(() => canonicalBadgeLabel(value)).not.toThrow();
    }
  });
});

describe('P1: badge rows carry labels, never raw ids', () => {
  it('resolves every known badge id to a label row', () => {
    const model = buildShareCardModel(
      {
        ...HOSTILE_INPUT,
        kind: 'subject-summary',
        badges: [...PHASE_BADGE_IDS, ...FISHING_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID],
      },
      ['badgeLabels'],
    );
    const row = rowFor(model, 'badgeLabels') as ShareCardBadgeListRow;
    expect(row).not.toBeNull();
    expect(row.badges.length).toBe(11);
    const serialized = JSON.stringify(row);
    for (const badgeId of [...PHASE_BADGE_IDS, ...FISHING_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID]) {
      expect(serialized).not.toContain(badgeId);
    }
  });

  it('omits an unknown badge id rather than printing it', () => {
    const model = buildShareCardModel(
      { ...HOSTILE_INPUT, badges: ['NotARealBadgeId', 'AlsoFake'] },
      ['badgeLabels'],
    );
    // No known label exists, so the whole row is omitted rather than rendered empty-but-present.
    expect(rowFor(model, 'badgeLabels')).toBeNull();
    expect(model.omittedFields).toEqual(['badgeLabels']);
    expect(JSON.stringify(model)).not.toContain('NotARealBadgeId');
    expect(JSON.stringify(model)).not.toContain('AlsoFake');
  });

  it('keeps the count of an unnamed badge while omitting its label', () => {
    // The model can count what it cannot name. `badgeCount` is 1, `badgeLabels` is omitted: a
    // card says "1 badge" and no invented name, which is the honest reading.
    const model = buildShareCardModel({ ...HOSTILE_INPUT, badges: ['NotARealBadgeId'] }, [
      'badgeCount',
      'badgeLabels',
    ]);
    expect(countFor(model, 'badgeCount')).toBe(1);
    expect(rowFor(model, 'badgeLabels')).toBeNull();
    expect(model.omittedFields).toEqual(['badgeLabels']);
  });

  it('counts a duplicated badge once', () => {
    const model = buildShareCardModel(
      { ...HOSTILE_INPUT, badges: [SCRIBE_CENTURY_120_BADGE_ID, SCRIBE_CENTURY_120_BADGE_ID] },
      ['badgeCount', 'badgeLabels'],
    );
    expect(countFor(model, 'badgeCount')).toBe(1);
    const row = rowFor(model, 'badgeLabels') as ShareCardBadgeListRow;
    expect(row.badges).toHaveLength(1);
    expect(row.badges[0].count).toBe(1);
  });

  it('lists mixed known and unknown badges without the unknown one', () => {
    const model = buildShareCardModel(
      { ...HOSTILE_INPUT, badges: [SCRIBE_CENTURY_120_BADGE_ID, 'NotARealBadgeId'] },
      ['badgeLabels'],
    );
    const row = rowFor(model, 'badgeLabels') as ShareCardBadgeListRow;
    expect(row.badges).toHaveLength(1);
    expect(row.badges[0].label).toBe(canonicalBadgeLabel(SCRIBE_CENTURY_120_BADGE_ID));
    expect(JSON.stringify(model)).not.toContain('NotARealBadgeId');
  });
});

// ── P3/P4: no clock, no date, no locale ────────────────────────────────────────────────────────

describe('P3: the model has no date, no clock, and no locale dependence', () => {
  it('contains no ISO date, no locale-formatted string, and no "generated" line', () => {
    const model = buildShareCardModel(HOSTILE_INPUT, undefined);
    const serialized = JSON.stringify(model);
    // The pre-Phase-20 line was `Generated: ${new Date().toLocaleString()}`.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized.toLowerCase()).not.toContain('generated');
    for (const value of stringsIn(model)) {
      expect(value).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it('takes no clock parameter, so there is nothing for a caller to vary', () => {
    // Structural, not behavioural: `buildShareCardModel`'s second parameter is the selection.
    // Reading the clock would need a third, and adding one is a visible API change.
    expect(buildShareCardModel.length).toBe(2);
    const source = buildShareCardModel.toString();
    for (const token of ['Date', 'now', 'today', 'localeCompare', 'Intl', 'random']) {
      expect(source).not.toContain(token);
    }
  });

  it('is unchanged by the host time zone and locale', () => {
    const originalTz = process.env.TZ;
    const originalLocale = process.env.LC_ALL;
    const renders: string[] = [];
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Adelaide', 'Pacific/Chatham']) {
        process.env.TZ = zone;
        for (const locale of ['en-US', 'de-DE', 'ar-EG']) {
          process.env.LC_ALL = locale;
          renders.push(JSON.stringify(buildShareCardModel(HOSTILE_INPUT, undefined)));
        }
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
      if (originalLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLocale;
    }
    expect(new Set(renders).size).toBe(1);
  });

  it('produces the same card whether or not a statistics record was ever written', () => {
    // The statistics snapshot carries `generatedAt` and `todayKey`. Neither may reach a card,
    // and a card built from a computed snapshot must equal one built with no statistics at all.
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [],
      now: '2026-03-17T04:00:00.000Z',
    });
    // The snapshot is the authoritative source for these three counts, and it carries two fields
    // a card must never publish: `generatedAt` and `todayKey`.
    expect(typeof snapshot.generatedAt).toBe('string');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.todayKey)).toBe(true);
    const withSnapshot = buildShareCardModel(
      {
        kind: 'statistics',
        statistics: {
          sessionsCompleted: snapshot.totals.sessionsCompleted,
          activeDays: snapshot.totals.activeDays,
          studyStreakDays: snapshot.totals.consecutiveStudyDayStreak,
        },
      },
      undefined,
    );
    // The card a caller builds from a real snapshot is identical to the card it builds from the same
    // three totals typed out by hand, and neither carries the snapshot's two timestamp fields.
    const handWritten = buildShareCardModel(
      {
        kind: 'statistics',
        statistics: {
          sessionsCompleted: snapshot.totals.sessionsCompleted,
          activeDays: snapshot.totals.activeDays,
          studyStreakDays: snapshot.totals.consecutiveStudyDayStreak,
        },
      },
      undefined,
    );
    expect(JSON.stringify(withSnapshot)).toBe(JSON.stringify(handWritten));
    expect(JSON.stringify(withSnapshot)).not.toContain(snapshot.generatedAt);
    expect(JSON.stringify(withSnapshot)).not.toContain(snapshot.todayKey);
    // And a device with no statistics record at all reports those three as absent rather than
    // zero - the honest difference between "no record" and "a record of nothing".
    const withoutSnapshot = buildShareCardModel({ kind: 'statistics' }, [
      'sessionsCompleted',
      'activeStudyDays',
      'studyStreakDays',
    ]);
    expect(withoutSnapshot.rows).toEqual([]);
    // Reported in the kind's declared order, not the request order - the same stability the
    // rows themselves have.
    expect(withoutSnapshot.omittedFields).toEqual([
      'studyStreakDays',
      'activeStudyDays',
      'sessionsCompleted',
    ]);
  });

  it('builds the same card from an empty statistics snapshot as from no snapshot', () => {
    const empty = emptyStatisticsSnapshot('2026-03-17T04:00:00.000Z');
    const card = buildShareCardModel(
      {
        kind: 'statistics',
        statistics: {
          sessionsCompleted: empty.totals.sessionsCompleted,
          activeDays: empty.totals.activeDays,
          studyStreakDays: empty.totals.consecutiveStudyDayStreak,
        },
      },
      undefined,
    );
    expect(card.rows.every((row) => 'value' in row && (row as ShareCardCountRow).value === 0)).toBe(true);
    expect(JSON.stringify(card)).not.toContain(empty.todayKey);
  });
});

// ── P5: no style value, no renderer dependency ────────────────────────────────────────────────

describe('P5: the model carries no colour, font, or renderer value', () => {
  it('has no style-shaped key anywhere in its output', () => {
    // Key names only. The pre-Phase-20 defect was a *keyless* value written straight into
    // `ctx.fillStyle`, so this asserts the model has nowhere to hang one, and the
    // literals-intact scan in `tests/phase20/shareCardPolicy.test.ts` closes the other half.
    function keysIn(value: unknown, into: string[] = []): string[] {
      if (Array.isArray(value)) {
        for (const entry of value) keysIn(entry, into);
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          into.push(key);
          keysIn(entry, into);
        }
      }
      return into;
    }
    const keys = keysIn(buildShareCardModel(HOSTILE_INPUT, [...SHARE_CARD_FIELDS])).map((key) =>
      key.toLowerCase(),
    );
    for (const token of ['color', 'colour', 'fillstyle', 'font', 'background', 'theme', 'token', 'radius', 'padding']) {
      expect(keys.filter((key) => key.includes(token))).toEqual([]);
    }
  });

  it('carries only the keys this contract declares', () => {
    const model = buildShareCardModel(HOSTILE_INPUT, undefined);
    expect(Object.keys(model).sort()).toEqual(['kind', 'omittedFields', 'rows', 'subjectName']);
    for (const row of model.rows) {
      const keys = Object.keys(row);
      expect(keys).toContain('field');
      expect(keys).toContain('label');
      // A row's identity keys are its field and its label, never anything private.
      expect(keys.filter((key) => !['field', 'label', 'value', 'isEmpty', 'numerator', 'denominator', 'ratio', 'counts', 'order', 'badges'].includes(key))).toEqual([]);
    }
  });

  it('labels rows through the content module rather than restating them here', () => {
    // CONTRACT TEST: `SHARE_CARD_FIELD_LABELS` is total over the declared vocabulary and carries a
    // non-empty label for every member. The model reads it; it does not hold its own copy.
    for (const field of SHARE_CARD_FIELDS) {
      const label = SHARE_CARD_FIELD_LABELS[field];
      expect(typeof label, `SHARE_CARD_FIELD_LABELS.${field} must be a string`).toBe('string');
      expect((label as string).trim().length).toBeGreaterThan(0);
      // A label equal to the camelCase id is the same fallback defect as a raw badge id.
      expect(label).not.toBe(field);
    }
  });

  it('uses the content module label on the rows it builds', () => {
    const model = buildShareCardModel(HOSTILE_INPUT, ['xpTotal', 'fishTotal', 'roomsCleared']);
    for (const row of model.rows) {
      expect(row.label).toBe(SHARE_CARD_FIELD_LABELS[row.field]);
    }
  });

  it('gives each kind a non-empty title and caption, and no two kinds share both', () => {
    for (const kind of SHARE_CARD_KINDS) {
      expect(shareCardTitle(kind).trim().length).toBeGreaterThan(0);
      expect(shareCardCaption(kind).trim().length).toBeGreaterThan(0);
      expect(titleForKind(kind)).toBe(shareCardTitle(kind));
      expect(captionForKind(kind)).toBe(shareCardCaption(kind));
    }
    const titles = SHARE_CARD_KINDS.map(shareCardTitle);
    expect(new Set(titles).size).toBe(titles.length);
    const captions = SHARE_CARD_KINDS.map(shareCardCaption);
    expect(new Set(captions).size).toBe(captions.length);
  });
});

// ── P6: determinism and order stability ───────────────────────────────────────────────────────

describe('P6: same input plus same selection is byte-identical output', () => {
  it('produces identical JSON across repeated builds', () => {
    const renders: string[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      renders.push(JSON.stringify(buildShareCardModel(HOSTILE_INPUT, undefined)));
    }
    expect(new Set(renders).size).toBe(1);
  });

  it('ignores the order in which the learner ticked the boxes', () => {
    const fields: ShareCardField[] = ['fishRarityCounts', 'subjectName', 'rank', 'fishTotal', 'fishUniqueTypes'];
    const ascending = buildShareCardModel(HOSTILE_INPUT, fields);
    const descending = buildShareCardModel(HOSTILE_INPUT, [...fields].reverse());
    const rotated = buildShareCardModel(HOSTILE_INPUT, [fields[3], fields[0], fields[4], fields[2], fields[1]]);
    expect(JSON.stringify(descending)).toBe(JSON.stringify(ascending));
    expect(JSON.stringify(rotated)).toBe(JSON.stringify(ascending));
  });

  it('ignores the insertion order of the caller rarity record', () => {
    const ascending = buildShareCardModel(HOSTILE_INPUT, ['fishRarityCounts']);
    const scrambled = buildShareCardModel(
      {
        ...HOSTILE_INPUT,
        fish: {
          total: HOSTILE_INPUT.fish?.total ?? 0,
          uniqueTypes: HOSTILE_INPUT.fish?.uniqueTypes ?? 0,
          countsByRarity: { rare: 4, common: 6, epic: 1 },
        },
      },
      ['fishRarityCounts'],
    );
    expect(JSON.stringify(scrambled)).toBe(JSON.stringify(ascending));
  });

  it('ignores the order of the badge ids, and sorts labels by text', () => {
    const ids = [SCRIBE_CENTURY_120_BADGE_ID, ...PHASE_BADGE_IDS, ...FISHING_BADGE_IDS];
    const forward = buildShareCardModel({ ...HOSTILE_INPUT, badges: ids }, ['badgeLabels']);
    const backward = buildShareCardModel({ ...HOSTILE_INPUT, badges: [...ids].reverse() }, ['badgeLabels']);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));

    const row = rowFor(forward, 'badgeLabels') as ShareCardBadgeListRow;
    const labels = row.badges.map((badge) => badge.label);
    expect(labels).toEqual([...labels].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  });

  it('sorts the rarity group by the fixed order, never by the caller key order', () => {
    // A collection card, because `fishRarityCounts` is not a subject-summary field: asking a
    // kind for another kind's field is how a test starts measuring the wrong thing.
    const model = buildShareCardModel({ ...HOSTILE_INPUT, kind: 'collection' }, ['fishRarityCounts']);
    const row = rowFor(model, 'fishRarityCounts') as ShareCardGroupRow;
    expect(row).not.toBeNull();
    expect(row.order).toEqual(['common', 'rare', 'epic']);
    expect(Object.keys(row.counts)).toEqual(['common', 'rare', 'epic']);
    expect(row.counts).toEqual({ common: 6, rare: 4, epic: 1 });
  });

  it('is idempotent in the sense that matters: feeding a model back does not change it', () => {
    // Re-serializing and re-parsing the input the way a restored preference would must yield the
    // same card. JSON round trips key order, so a model built from parsed JSON is identical.
    const once = buildShareCardModel(HOSTILE_INPUT, undefined);
    const twice = buildShareCardModel(JSON.parse(JSON.stringify(HOSTILE_INPUT)) as ShareCardBuildInput, undefined);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('does not mutate its input', () => {
    const badges = [...(HOSTILE_INPUT.badges as string[])];
    const rarity = { ...(HOSTILE_INPUT.fish?.countsByRarity as Record<string, number>) };
    const snapshot = JSON.stringify(HOSTILE_INPUT);
    buildShareCardModel(HOSTILE_INPUT, undefined);
    expect(JSON.stringify(HOSTILE_INPUT)).toBe(snapshot);
    expect(HOSTILE_INPUT.badges).toEqual(badges);
    expect(HOSTILE_INPUT.fish?.countsByRarity).toEqual(rarity);
  });
});

// ── P7: every selectable field builds, and only from counts ───────────────────────────────────

describe('P7: every selectable field is buildable, per kind', () => {
  it('builds a row for every available field of every kind when the input is complete', () => {
    const complete: ShareCardBuildInput = {
      kind: 'subject-summary',
      subjectName: 'Cell Biology',
      progression: { xpTotal: 900, rank: 'Master' },
      rooms: { total: 40, cleared: 40 },
      badges: [...PHASE_BADGE_IDS],
      inventoryCount: 12,
      collectedNoteCount: 40,
      fish: { total: 30, uniqueTypes: 12, countsByRarity: { common: 20, rare: 8, epic: 2 } },
      statistics: {
        sessionsCompleted: 15,
        activeDays: 44,
        studyStreakDays: 9,
        recall: { correct: 40, total: 44 },
      },
      assistance: { sessionsWithAssistance: 6 },
    };
    for (const kind of SHARE_CARD_KINDS) {
      // Every field of every kind, so a field this kind does not have is filtered by the policy
      // rather than by what the caller happened to omit.
      const model = buildShareCardModel({ ...complete, kind }, [...SHARE_CARD_FIELDS]);
      const built = new Set(fieldsInModel(model));
      const available = availableFieldsFor(kind);
      expect(available.length).toBeGreaterThan(0);
      for (const field of SHARE_CARD_FIELDS) {
        // Only this kind's own fields are in play. A field another kind owns is not "omitted",
        // it is not part of this card at all, and conflating the two would make the omission
        // list useless to a renderer deciding what to draw.
        if (!available.includes(field)) {
          expect(built.has(field)).toBe(false);
          continue;
        }
        if (field === 'subjectName') {
          expect(model.subjectName).toBe('Cell Biology');
          continue;
        }
        expect(built.has(field) || model.omittedFields.includes(field)).toBe(true);
      }
      expect(model.omittedFields).toEqual([]);
      expect(model.subjectName).toBe('Cell Biology');
    }
  });

  it('builds a subject-summary default card with every default field present', () => {
    for (const kind of SHARE_CARD_KINDS) {
      const model = buildShareCardModel({ ...HOSTILE_INPUT, kind }, undefined);
      expect(model.subjectName).not.toBeNull();
      expect(model.omittedFields).toEqual([]);
      expect(model.rows.length).toBeGreaterThan(0);
    }
  });

  it('takes the default selection when none is supplied', () => {
    for (const kind of SHARE_CARD_KINDS) {
      const implicit = buildShareCardModel({ ...HOSTILE_INPUT, kind }, undefined);
      const explicit = buildShareCardModel({ ...HOSTILE_INPUT, kind }, defaultSelectionFor(kind));
      expect(JSON.stringify(implicit)).toBe(JSON.stringify(explicit));
    }
  });

  it('accepts a per-kind selection record as well as a bare array', () => {
    const fromRecord = buildShareCardModel({ ...HOSTILE_INPUT, kind: 'fish' }, { fish: ['fishTotal'] });
    const fromArray = buildShareCardModel({ ...HOSTILE_INPUT, kind: 'fish' }, ['fishTotal']);
    expect(JSON.stringify(fromRecord)).toBe(JSON.stringify(fromArray));
    // The record's other kinds must not leak into this card.
    const leaky = buildShareCardModel({ ...HOSTILE_INPUT, kind: 'fish' }, {
      fish: ['fishTotal'],
      statistics: ['recallAccuracy'],
    });
    expect(fieldsInModel(leaky)).toEqual(['fishTotal']);
  });

  it('never emits a count above the input, and never emits a fractional or negative count', () => {
    const model = buildShareCardModel(HOSTILE_INPUT, [
      'xpTotal',
      'roomsCleared',
      'roomTotal',
      'inventoryCount',
      'collectedNoteCount',
      'fishTotal',
      'fishUniqueTypes',
      'studyStreakDays',
      'activeStudyDays',
      'sessionsCompleted',
      'badgeCount',
      'assistanceSummary',
    ]);
    for (const row of model.rows) {
      const value = (row as ShareCardCountRow).value;
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(row.label.trim().length).toBeGreaterThan(0);
    }
    // `xpTotal` was 1234.9 in the fixture: truncated, never rounded up into a false claim.
    expect(countFor(model, 'xpTotal')).toBe(1234);
    expect(countFor(model, 'roomsCleared')).toBeLessThanOrEqual(countFor(model, 'roomTotal') as number);
  });

  it('shows the rank only when it is one of the three published tiers', () => {
    for (const tier of RANK_TIERS) {
      const model = buildShareCardModel(
        { ...HOSTILE_INPUT, progression: { xpTotal: tier.minXp, rank: tier.rank } },
        ['rank'],
      );
      expect((rowFor(model, 'rank') as { value: string }).value).toBe(tier.rank);
    }
    for (const bogus of ['Legendary', 'novice', '', '  ', undefined, null, 7]) {
      const model = buildShareCardModel(
        { ...HOSTILE_INPUT, progression: { xpTotal: 10, rank: bogus as string | null } },
        ['rank'],
      );
      expect(rowFor(model, 'rank')).toBeNull();
      expect(model.omittedFields).toEqual(['rank']);
    }
  });

  it('reports recall accuracy as a ratio bounded by its denominator', () => {
    // A statistics card: `recallAccuracy` belongs to that kind alone, so asking any other kind for
    // it would measure the availability policy rather than the ratio.
    const model = buildShareCardModel(
      {
        ...HOSTILE_INPUT,
        kind: 'statistics',
        statistics: { ...(HOSTILE_INPUT.statistics as NonNullable<ShareCardBuildInput['statistics']>), recall: { correct: 25, total: 20 } },
      },
      ['recallAccuracy'],
    );
    const row = rowFor(model, 'recallAccuracy') as ShareCardRatioRow;
    // `correct > total` cannot happen in real data, and a ratio above 1 is not a fact.
    expect(row.numerator).toBe(20);
    expect(row.denominator).toBe(20);
    expect(row.ratio).toBe(1);
    expect(row.ratio).toBeLessThanOrEqual(1);
  });

  it('reports a recall ratio with a zero denominator as zero, not NaN', () => {
    const model = buildShareCardModel(
      {
        ...HOSTILE_INPUT,
        kind: 'statistics',
        statistics: { ...(HOSTILE_INPUT.statistics as NonNullable<ShareCardBuildInput['statistics']>), recall: { correct: 0, total: 0 } },
      },
      ['recallAccuracy'],
    );
    const row = rowFor(model, 'recallAccuracy') as ShareCardRatioRow;
    expect(row.denominator).toBe(0);
    expect(row.ratio).toBe(0);
    expect(Number.isNaN(row.ratio)).toBe(false);
    // Present, because "no recalls yet" differs from "no statistics record".
    expect(model.omittedFields).toEqual([]);
  });

  it('rounds a ratio to a stable four places', () => {
    const model = buildShareCardModel(
      {
        ...HOSTILE_INPUT,
        kind: 'statistics',
        statistics: { ...(HOSTILE_INPUT.statistics as NonNullable<ShareCardBuildInput['statistics']>), recall: { correct: 1, total: 3 } },
      },
      ['recallAccuracy'],
    );
    const row = rowFor(model, 'recallAccuracy') as ShareCardRatioRow;
    expect(row.ratio).toBe(0.3333);
  });
});

// ── P8: honest omissions ─────────────────────────────────────────────────────────────────────

describe('P8: a missing input is omitted, and a zero is not omitted', () => {
  it('omits room rows when no graph is available and shows zero when there are no rooms', () => {
    const noRooms = buildShareCardModel({ kind: 'subject-summary' }, ['roomsCleared', 'roomTotal']);
    expect(noRooms.rows).toEqual([]);
    expect(noRooms.omittedFields).toEqual(['roomsCleared', 'roomTotal']);

    const emptyRooms = buildShareCardModel(
      { kind: 'subject-summary', rooms: { total: 0, cleared: 0 } },
      ['roomsCleared', 'roomTotal'],
    );
    expect(countFor(emptyRooms, 'roomsCleared')).toBe(0);
    expect(countFor(emptyRooms, 'roomTotal')).toBe(0);
    expect(emptyRooms.omittedFields).toEqual([]);
    expect((rowFor(emptyRooms, 'roomsCleared') as ShareCardCountRow).isEmpty).toBe(true);
  });

  it('omits fish rows with no fish record and shows zeros with an empty collection', () => {
    const noFish = buildShareCardModel({ kind: 'fish' }, ['fishTotal', 'fishUniqueTypes', 'fishRarityCounts']);
    expect(noFish.rows).toEqual([]);
    expect(noFish.omittedFields).toEqual(['fishTotal', 'fishUniqueTypes', 'fishRarityCounts']);

    const emptyFish = buildShareCardModel(
      { kind: 'fish', fish: { total: 0, uniqueTypes: 0, countsByRarity: { common: 0, rare: 0, epic: 0 } } },
      ['fishTotal', 'fishUniqueTypes', 'fishRarityCounts'],
    );
    expect(countFor(emptyFish, 'fishTotal')).toBe(0);
    expect(rowFor(emptyFish, 'fishRarityCounts')).not.toBeNull();
    expect(emptyFish.omittedFields).toEqual([]);
  });

  it('omits the assistance row unless assistance is requested *and* supplied', () => {
    const notRequested = buildShareCardModel(HOSTILE_INPUT, undefined);
    expect(fieldsInModel(notRequested)).not.toContain('assistanceSummary');

    const requestedNotSupplied = buildShareCardModel({ kind: 'statistics' }, ['assistanceSummary']);
    expect(rowFor(requestedNotSupplied, 'assistanceSummary')).toBeNull();
    expect(requestedNotSupplied.omittedFields).toEqual(['assistanceSummary']);

    const requested = buildShareCardModel(HOSTILE_INPUT, ['assistanceSummary']);
    expect(countFor(requested, 'assistanceSummary')).toBe(4);
  });

  it('reports an unstarted subject as an empty card, not a card of zeros', () => {
    const model = buildShareCardModel({ kind: 'subject-summary' }, [
      'xpTotal',
      'roomsCleared',
      'roomTotal',
      'badgeCount',
      'inventoryCount',
      'collectedNoteCount',
    ]);
    expect(isEmptyShareCardModel(model)).toBe(true);
    expect(model.omittedFields).toHaveLength(6);
  });

  it('treats a card with only a subject name as non-empty rows but reports the emptiness honestly', () => {
    const model = buildShareCardModel({ kind: 'fish', subjectName: 'Cell Biology' }, ['subjectName']);
    expect(model.subjectName).toBe('Cell Biology');
    expect(model.rows).toEqual([]);
    expect(isEmptyShareCardModel(model)).toBe(true);
  });
});

// ── P9: hostile and empty inputs ──────────────────────────────────────────────────────────────

describe('P9: empty and hostile inputs do not throw', () => {
  it('builds from a completely empty input for every kind', () => {
    for (const kind of SHARE_CARD_KINDS) {
      expect(() => buildShareCardModel({ kind })).not.toThrow();
      const model = buildShareCardModel({ kind }, [...SHARE_CARD_FIELDS]);
      expect(model.subjectName).toBeNull();
      expect(isEmptyShareCardModel(model)).toBe(true);
    }
  });

  it('treats a name that is empty, whitespace, or non-string as no name', () => {
    for (const name of ['', '   ', '\t\n', null, undefined, 42, {}, []]) {
      const model = buildShareCardModel({ kind: 'fish', subjectName: name as string }, ['subjectName']);
      expect(model.subjectName).toBeNull();
    }
  });

  it('truncates a 500-character name rather than carrying all of it', () => {
    const name = 'x'.repeat(500);
    const model = buildShareCardModel({ kind: 'fish', subjectName: name }, ['subjectName']);
    expect(model.subjectName).not.toBeNull();
    expect((model.subjectName as string).length).toBeLessThan(name.length);
    expect(name.startsWith(model.subjectName as string)).toBe(true);
  });

  it('carries emoji, RTL, and path-separator names as the learner typed them', () => {
    // No bidi stripping and no path munging: the name is the learner's own text, and the model
    // bounds its length rather than rewriting its content.
    for (const name of ['\u{1f41f} Pond', '\u05e9\u05d5\u05df\u05d8 RTL', 'a/b\\c..d', '../etc/passwd']) {
      const model = buildShareCardModel({ kind: 'fish', subjectName: name }, ['subjectName']);
      expect(model.subjectName).toBe(name.trim());
    }
  });

  it('coerces every non-finite, negative, and fractional count to a non-negative integer', () => {
    const model = buildShareCardModel(
      {
        kind: 'collection',
        progression: { xpTotal: Number.NaN, rank: null },
        rooms: { total: Number.POSITIVE_INFINITY, cleared: -5 },
        inventoryCount: 3.7,
        collectedNoteCount: Number.NEGATIVE_INFINITY,
        fish: { total: Number.NaN, uniqueTypes: -1, countsByRarity: { common: -3, rare: Number.NaN, epic: 2.9 } },
        statistics: {
          sessionsCompleted: -0.5,
          activeDays: Number.POSITIVE_INFINITY,
          studyStreakDays: Number.NaN,
          recall: { correct: -2, total: 0 },
        },
        assistance: { sessionsWithAssistance: Number.NaN },
      },
      [...SHARE_CARD_FIELDS],
    );
    for (const row of model.rows) {
      if ('value' in row) {
        expect(Number.isInteger(row.value)).toBe(true);
        expect(row.value).toBeGreaterThanOrEqual(0);
      }
      if (row.field === 'fishRarityCounts') {
        for (const count of Object.values((row as ShareCardGroupRow).counts)) {
          expect(Number.isInteger(count)).toBe(true);
          expect(count).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('coerces counts exactly as the statistics and progression modules do', () => {
    // The same rule `statisticsMetrics.toCount` and `canonicalProgression.toNonNegativeInt`
    // apply: `Math.max(0, Math.trunc(value))`, and `0` for anything non-finite. Restated here
    // rather than imported, because those are module-private; the values are what matter.
    const expected = (value: number): number =>
      typeof value !== 'number' || !Number.isFinite(value)
        ? 0
        : Math.max(0, Math.trunc(value));
    for (const value of [-5, 3.7, Number.NaN, Number.POSITIVE_INFINITY, 12, 0, -0.5]) {
      const model = buildShareCardModel(
        { kind: 'subject-summary', progression: { xpTotal: value, rank: 'Novice' } },
        ['xpTotal'],
      );
      expect(countFor(model, 'xpTotal')).toBe(expected(value));
    }
  });

  it('ignores a hostile selection without throwing, and builds nothing from one', () => {
    // Every entry here is denied or unknown, so "builds nothing" is the whole claim.
    const hostile: string[][] = [
      ['noteMarkdown'],
      ['room-7f3a'],
      ['subjectId'],
      ['2026-10-05'],
      [''],
      ['xpTotal', 'noteBody', 'badgeId'],
    ];
    for (const selection of hostile) {
      const model = buildShareCardModel(HOSTILE_INPUT, selection as ShareCardField[]);
      const built = fieldsInModel(model);
      const legitimate = selection.filter((candidate) => candidate === 'xpTotal');
      expect(built).toEqual(legitimate);
      expect(model.subjectName).toBeNull();
      const serialized = JSON.stringify(model);
      for (const denied of ['noteMarkdown', 'noteBody', 'badgeId', 'room-7f3a', 'subjectId', '2026-10-05']) {
        expect(serialized).not.toContain(denied);
      }
    }
  });

  it('does not throw on a selection that is not an array of strings at all', () => {
    for (const selection of [undefined, null, 'xpTotal' as never, 42 as never, {} as never, [{}] as never]) {
      expect(() => buildShareCardModel(HOSTILE_INPUT, selection)).not.toThrow();
    }
  });

  it('does not throw on a non-string badge array', () => {
    const model = buildShareCardModel(
      { kind: 'subject-summary', badges: [1, null, undefined, {}, SCRIBE_CENTURY_120_BADGE_ID] as unknown as string[] },
      ['badgeCount', 'badgeLabels'],
    );
    expect(countFor(model, 'badgeCount')).toBe(1);
    expect((rowFor(model, 'badgeLabels') as ShareCardBadgeListRow).badges).toHaveLength(1);
  });

  it('does not throw when the badge field is not an array at all', () => {
    for (const badges of [null, undefined, 'ScribeCentury120', 42, {}]) {
      const model = buildShareCardModel(
        { kind: 'subject-summary', badges: badges as unknown as string[] },
        ['badgeCount', 'badgeLabels'],
      );
      expect(rowFor(model, 'badgeLabels')).toBeNull();
      // Both badge fields are absent, because neither can be derived from a non-array.
      expect(model.omittedFields).toEqual(['badgeCount', 'badgeLabels']);
    }
  });
});

// ── P10: the denylist is reachable for nothing ───────────────────────────────────────────────

describe('P10: a hostile or over-broad selection cannot make a field render', () => {
  it('renders nothing for a selection of denied values, for every kind', () => {
    const hostile = [
      'noteBody',
      'noteTopic',
      'roomId',
      'roomList',
      'subjectId',
      'attachmentId',
      'badgeId',
      'sessionId',
      'generatedAt',
      'storageKey',
      'localStorage',
      'fileName',
      'suggestionId',
      'reasonCode',
      'dismissalRecord',
      '2026-10-05T12:00:00.000Z',
      'room-7f3a',
      'subj_a1b2c3',
      'ses_0001',
    ];
    for (const kind of SHARE_CARD_KINDS) {
      const model = buildShareCardModel({ ...HOSTILE_INPUT, kind }, hostile as ShareCardField[]);
      expect(model.rows, `${kind} must render nothing`).toEqual([]);
      expect(model.subjectName).toBeNull();
      const serialized = JSON.stringify(model);
      for (const denied of hostile) {
        expect(serialized).not.toContain(denied);
      }
    }
  });

  it('keeps the legitimate fields when a denied value is mixed into the selection', () => {
    const model = buildShareCardModel({ ...HOSTILE_INPUT, kind: 'collection' }, [
      'xpTotal',
      'noteMarkdown',
      'fishTotal',
      'room-7f3a',
      'rank',
      'subjectId',
    ] as ShareCardField[]);
    // Every row the request can produce is present, in declared order. `subjectName` is the model's
    // own property rather than a row, and this request did not select it, so it is absent from
    // both - which is the point: a field that was not asked for is not rendered.
    expect(fieldsInModel(model)).toEqual(['rank', 'xpTotal', 'fishTotal']);
    expect(model.subjectName).toBeNull();
    // Nothing was omitted: every *allowed* field in the request had data. A denied value never
    // reaches `omittedFields` either - it never reaches the model at all.
    expect(model.omittedFields).toEqual([]);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain('noteMarkdown');
    expect(serialized).not.toContain('room-7f3a');
    expect(serialized).not.toContain('subjectId');
  });

  it('never carries a raw badge id even when every badge id is unknown', () => {
    // Genuinely unknown ids - not near-misses of real ones, because a real id *would* resolve and
    // this test is about the ids the content module does not recognise.
    const unknownIds = ['CreatorPhaseComplete-legacy', 'badge-invented-1', 'ZZTopBadge'];
    const model = buildShareCardModel({ ...HOSTILE_INPUT, badges: unknownIds }, [
      'badgeCount',
      'badgeLabels',
    ]);
    const serialized = JSON.stringify(model);
    for (const id of unknownIds) {
      expect(serialized).not.toContain(id);
    }
    // Counted, not named: honest without publishing an identifier.
    expect(countFor(model, 'badgeCount')).toBe(3);
    expect(rowFor(model, 'badgeLabels')).toBeNull();
    expect(model.omittedFields).toEqual(['badgeLabels']);
  });

  it('resolves a real badge id to its canonical label, and does not emit the id', () => {
    // The control for the test above: the difference is only whether the content module knows the
    // id, so a "never leaks" assertion that also passed when the id *did* resolve would be
    // measuring the wrong thing.
    const model = buildShareCardModel(
      { ...HOSTILE_INPUT, badges: [SCRIBE_CENTURY_120_BADGE_ID] },
      ['badgeCount', 'badgeLabels'],
    );
    const row = rowFor(model, 'badgeLabels') as ShareCardBadgeListRow;
    expect(row.badges).toEqual([
      { label: canonicalBadgeLabel(SCRIBE_CENTURY_120_BADGE_ID), count: 1 },
    ]);
    expect(JSON.stringify(model)).not.toContain(SCRIBE_CENTURY_120_BADGE_ID);
  });

  it('never carries a room id, note id, or session id that a caller tried to smuggle through a name', () => {
    // The subject name is the only free-text field on a card. A caller that puts an id in it
    // gets their own text rendered - which is exactly why the *caller* must not, and why this
    // documents the boundary rather than pretending to police it.
    const model = buildShareCardModel(
      { kind: 'fish', subjectName: 'room-7f3a' },
      ['subjectName'],
    );
    expect(model.subjectName).toBe('room-7f3a');
    // What the model guarantees is that it adds nothing of its own:
    expect(stringsIn(model.rows).length).toBe(0);
  });

  it('carries no assistance suggestion id, reason code, or dismissal record', () => {
    const model = buildShareCardModel(
      {
        ...HOSTILE_INPUT,
        assistance: { sessionsWithAssistance: 4 },
      },
      ['assistanceSummary'],
    );
    expect(JSON.stringify(model)).not.toContain('suggestion');
    expect(JSON.stringify(model)).not.toContain('reason');
    expect(JSON.stringify(model)).not.toContain('dismiss');
    expect(countFor(model, 'assistanceSummary')).toBe(4);
  });
});

// ── Integration with the authoritative sources ────────────────────────────────────────────────

describe('the model is fed from the authoritative counts, not re-derived', () => {
  it('matches the fish collection service on total, unique types, and rarities', () => {
    const collection: FishEntry[] = [
      { id: 'carp:1', name: 'River Carp', rarity: 'common', subjectId: 's1', subjectName: 'Subject', caughtAt: '2026-01-01T00:00:00.000Z' },
      { id: 'carp:2', name: 'River Carp', rarity: 'common', subjectId: 's1', subjectName: 'Subject', caughtAt: '2026-01-02T00:00:00.000Z' },
      { id: 'koi:1', name: 'Moon Koi', rarity: 'rare', subjectId: 's1', subjectName: 'Subject', caughtAt: '2026-01-03T00:00:00.000Z', catalogId: 'moon-koi' },
      { id: 'lev:1', name: 'Lantern Eel', rarity: 'epic', subjectId: 's1', subjectName: 'Subject', caughtAt: '2026-01-04T00:00:00.000Z', catalogId: 'lantern-eel' },
    ];
    const canonical = toCanonicalFishCollection(collection);
    const byRarity = countByRarity(canonical);
    const model = buildShareCardModel(
      {
        kind: 'fish',
        fish: {
          total: canonical.length,
          uniqueTypes: countUniqueTypes(canonical),
          countsByRarity: byRarity,
        },
      },
      ['fishTotal', 'fishUniqueTypes', 'fishRarityCounts'],
    );
    expect(countFor(model, 'fishTotal')).toBe(collection.length);
    expect(countFor(model, 'fishUniqueTypes')).toBe(countUniqueTypes(canonical));
    const group = rowFor(model, 'fishRarityCounts') as ShareCardGroupRow;
    expect(group.counts).toEqual({ common: 2, rare: 1, epic: 1 });
    expect(group.counts.common).toBe(byRarity.common);
    // The catalogue types count agrees, and no catalogue id reaches the card.
    expect(countCanonicalCatalogTypes(canonical)).toBe(3);
    expect(JSON.stringify(model)).not.toContain('moon-koi');
  });

  it('matches the statistics totals the caller read from a computed snapshot', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [],
      now: '2026-03-17T04:00:00.000Z',
    });
    const model = buildShareCardModel(
      {
        kind: 'statistics',
        statistics: {
          sessionsCompleted: snapshot.totals.sessionsCompleted,
          activeDays: snapshot.totals.activeDays,
          studyStreakDays: snapshot.totals.consecutiveStudyDayStreak,
        },
      },
      ['sessionsCompleted', 'activeStudyDays', 'studyStreakDays'],
    );
    expect(countFor(model, 'sessionsCompleted')).toBe(snapshot.totals.sessionsCompleted);
    expect(countFor(model, 'activeStudyDays')).toBe(snapshot.totals.activeDays);
    expect(countFor(model, 'studyStreakDays')).toBe(snapshot.totals.consecutiveStudyDayStreak);
  });

  it('agrees with the rank the progression engine derives from the same XP', () => {
    // The model never recomputes a rank; it renders the one the record holds. This pins that the
    // field is a pass-through, so a card cannot disagree with the progression record.
    for (const tier of RANK_TIERS) {
      const model = buildShareCardModel(
        { kind: 'subject-summary', progression: { xpTotal: tier.minXp, rank: tier.rank } },
        ['rank', 'xpTotal'],
      );
      expect((rowFor(model, 'rank') as { value: string }).value).toBe(tier.rank);
      expect(countFor(model, 'xpTotal')).toBe(tier.minXp);
    }
  });

  it('emits rows only for fields in the kind, so a statistics card never grows a fish row', () => {
    // A fish card asked for every declared field still emits only the fish card's own fields.
    const fishCard = buildShareCardModel({ ...HOSTILE_INPUT, kind: 'fish' }, [...SHARE_CARD_FIELDS]);
    expect(fieldsInModel(fishCard)).toEqual(['rank', 'fishTotal', 'fishUniqueTypes', 'fishRarityCounts']);
    expect(fishCard.subjectName).not.toBeNull();
    const statsCard = buildShareCardModel(
      { ...HOSTILE_INPUT, kind: 'statistics' },
      [...SHARE_CARD_FIELDS],
    );
    expect(fieldsInModel(statsCard)).not.toContain('inventoryCount');
  });
});

// ── A subject called "Room ..." survives ─────────────────────────────────────────────────────────

/**
 * ## Why this block exists
 *
 * The `room` rule in `shareCardPolicy.ts` was a bare `containsWord(folded, 'room')` substring test.
 * That refused `Room acoustics`, `Room 101 calculus`, `My bedroom notes`, and `A study room for two`
 * - ordinary English a learner chose - while `Session planning` and `Subject 3 revision` sailed
 * through, because the `session` and `subject` rules beside it already required an identifier
 * marker. `visibleShareCardSubjectName` gates the subject name through the value gate, so a learner
 * whose subject was about rooms got a card with **no subject name**, for no privacy benefit: none of
 * those four strings identifies anything.
 *
 * These are built with the **real nested** `ShareCardModelInput` shape - `rooms: { total, cleared }`,
 * not a flat `roomsTotal` - because an earlier verification of this very claim used a flat shape,
 * saw the two room rows missing, and concluded wrongly that the labels were being filtered. They
 * were not; the flat shape simply never produced the rows. A gate written against the wrong fixture
 * is worse than no gate.
 */
describe("a subject whose name is about rooms is not an identifier", () => {
  /** A subject-summary input with a real room ledger behind it. */
  function subjectNamed(name: string): ShareCardBuildInput {
    return {
      kind: 'subject-summary',
      subjectName: name,
      progression: { xpTotal: 1240, rank: 'Scholar' },
      rooms: { total: 40, cleared: 12 },
    };
  }

  it('carries the subject name and both room rows through the model', () => {
    const model = buildShareCardModel(subjectNamed('Room acoustics'), [
      'subjectName',
      'roomsCleared',
      'roomTotal',
    ]);
    // The name is a pass-through: the model adds nothing and censors nothing.
    expect(model.subjectName).toBe('Room acoustics');
    // The nested room ledger produced two rows, and they carry the app-owned labels.
    expect(fieldsInModel(model)).toEqual(['roomsCleared', 'roomTotal']);
    expect(countFor(model, 'roomsCleared')).toBe(12);
    expect(countFor(model, 'roomTotal')).toBe(40);
    const labels = model.rows.map((row) => row.label);
    expect(labels).toEqual(['Rooms cleared', 'Rooms in the dungeon']);
    // And no room id, minted or otherwise, appears anywhere in the serialised model.
    for (const smuggled of ['room-7f3a', 'roomId', 'dungeonRoom_42', 'rooms.visited']) {
      expect(JSON.stringify(model)).not.toContain(smuggled);
    }
  });

  it('hands every one of these names to the surface, and refuses the ids, through one predicate', () => {
    // The model does not censor - `shareCardModel.ts` documents that policing the free-text name is
    // the caller's job. So this block asks the predicate a surface actually asks, which is where the
    // defect was visible, and shows the two halves of the invariant from the model's own input.
    const PROSE = [
      'Room acoustics',
      'Room 101 calculus',
      'My bedroom notes',
      'A study room for two',
      'Bedroom organisation',
      'Classroom management',
      'Living room acoustics',
    ];
    for (const name of PROSE) {
      const model = buildShareCardModel(subjectNamed(name), ['subjectName', 'roomsCleared']);
      // The surface would publish the name, because nothing about it identifies anything.
      expect(model.subjectName).toBe(name);
      expect(mayValueAppearOnCard(model.subjectName as string), name).toBe(true);
    }

    const IDENTIFIERS = ['room-7f3a', 'roomId', 'dungeonRoom_42', 'room_id', 'rooms.visited'];
    for (const name of IDENTIFIERS) {
      const model = buildShareCardModel(subjectNamed(name), ['subjectName', 'roomsCleared']);
      // The model still carries it - that is the documented boundary - but the surface drops it.
      expect(model.subjectName).toBe(name);
      expect(mayValueAppearOnCard(model.subjectName as string), name).toBe(false);
    }
  });
});