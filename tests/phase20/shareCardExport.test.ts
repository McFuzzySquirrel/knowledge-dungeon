/**
 * Phase 20: the refactored legacy exporter.
 *
 * ## Why the legacy exporter still has a gate
 *
 * `src/ui/utils/progressionShareExport.ts` is **not** a declared share-lane module - it is eagerly
 * reachable from the entry chunk today, and `tests/phase20/infraShareBuildLane.test.ts` asserts it
 * stays off the lane because the phase rollback ("`VITE_WEB_SHARE=false` and retain local download")
 * is the thing that must keep working when the flag is off. Gating the thing rollback requires to
 * survive would invert the rollback.
 *
 * Being off the lane does not mean ungated. This file is the gate, and it pins the four properties
 * the refactor had to deliver:
 *
 * 1. **It produces bytes and a name instead of downloading.** Plan section 9 requires a preview before
 *    delivery, which is impossible against a function whose side effect is a download.
 * 2. **The always-download exports still download**, because the rollback depends on them.
 * 3. **No raw badge id on an image.** The old body wrote `• ${badge}`. This is asserted against the
 *    *recorded draw calls*, so a defect reintroduced through a new code path is caught rather than a
 *    comment being trusted.
 * 4. **No clock, and no second token system.** The old body drew
 *    `Generated: ${new Date().toLocaleString()}` and hardcoded `'#141a2c'` and `'Inter, sans-serif'`.
 *
 * ## What this file cannot verify
 *
 * **No contrast and no rendered layout.** jsdom computes neither; the recorded draw calls show what
 * was *asked for*, not what a browser would paint. Phase 21 measures the latter.
 *
 * Privacy: every string here is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression/types';
import { canonicalBadgeLabel } from '@/core/share/shareCardContent';
import { COZY_THEMES } from '@/theme/cozyTokens';
import { TYPOGRAPHY } from '@/theme/typography';
import type { CollectedNoteEntry, LootItem } from '@/store/progressionStore';
import {
  buildCollectionSnapshotImage,
  buildSubjectSummaryCardImage,
  exportCollectionSnapshot,
  exportSubjectSummaryCard,
  saveShareCardImage,
} from '@/ui/utils/progressionShareExport';
import { installRecordingCanvas, type RecordingCanvas } from '../unit/shareCardRenderSupport';

const SUMMARY = {
  subjectName: 'Linear Algebra',
  xpTotal: 1240,
  rank: 'Master',
  badgeCount: 7,
  inventoryCount: 7,
  collectedNoteCount: 3,
  clearedRoomCount: 12,
  totalRoomCount: 40,
};

const NOTE: CollectedNoteEntry = {
  noteId: 'dungeon:room-1',
  dungeonId: 'dungeon',
  roomId: 'room-1',
  topic: 'Vector Spaces',
  floorLabel: 'Linear Algebra',
  artifactPreview: 'A concise artifact summary.',
  noteMarkdown: '## Key ideas\nA full encounter note.',
  artifactMarkdown: '## Key ideas\nA full artifact note.',
  collectedAt: '2026-01-01T00:00:00.000Z',
};

const LOOT: LootItem = {
  id: 'loot-1',
  name: 'Worn Compass',
  description: 'Utility: baseline study support item.',
  rarity: 'common',
  acquiredAt: '2026-01-01T00:00:00.000Z',
} as unknown as LootItem;

const COLLECTION = {
  subjectName: 'Linear Algebra',
  xpTotal: 1240,
  rank: 'Master',
  badges: [...PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID],
  inventory: [LOOT],
  collectedNotes: [NOTE],
};

let canvas: RecordingCanvas;
let restore: () => void;
let downloads: string[];

beforeEach(() => {
  const installed = installRecordingCanvas();
  canvas = installed.canvas;
  restore = installed.restore;
  downloads = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => 'blob:probe' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
  HTMLAnchorElement.prototype.click = function record(this: HTMLAnchorElement) {
    downloads.push(this.download);
  };
});

afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe('the exporter produces bytes and a name, and downloads only when asked', () => {
  it('returns a PNG blob and a subject-derived file name without downloading anything', async () => {
    const image = await buildSubjectSummaryCardImage(SUMMARY);
    expect(image.blob).toBeInstanceOf(Blob);
    expect(image.blob.type).toBe('image/png');
    expect(image.fileName).toBe('linear-algebra-summary.png');
    // The producer's whole point: producing is not delivering.
    expect(downloads).toEqual([]);
    expect(canvas.toBlobCalls).toEqual(['image/png']);
  });

  it('never produces a name with a path separator or a traversal', async () => {
    const image = await buildSubjectSummaryCardImage({ ...SUMMARY, subjectName: '../../etc/passwd' });
    expect(image.fileName).not.toContain('/');
    expect(image.fileName).not.toContain('..');
    expect(image.fileName.endsWith('-summary.png')).toBe(true);
    // And an empty name still produces a usable one.
    const empty = await buildSubjectSummaryCardImage({ ...SUMMARY, subjectName: '' });
    expect(empty.fileName).toBe('subject-summary.png');
  });

  it('produces a collection image with a name, still without downloading', async () => {
    const image = await buildCollectionSnapshotImage(COLLECTION);
    expect(image.blob.type).toBe('image/png');
    expect(image.fileName).toBe('linear-algebra-collections.png');
    expect(downloads).toEqual([]);
  });

  it('the always-download exports still download, because the rollback depends on them', async () => {
    await exportSubjectSummaryCard(SUMMARY);
    await exportCollectionSnapshot(COLLECTION);
    // This is the documented rollback path with `VITE_WEB_SHARE=false`, asserted as behaviour rather
    // than as a promise. A refactor that "simplified" these away would take local download with it.
    expect(downloads).toEqual(['linear-algebra-summary.png', 'linear-algebra-collections.png']);
  });

  it('saveShareCardImage releases the object URL it created', async () => {
    const create = vi.fn(() => 'blob:probe');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
    saveShareCardImage({ blob: new Blob([new Uint8Array([1])]), fileName: 'card.png' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:probe');
    expect(downloads).toEqual(['card.png']);
  });

  it('encodes exactly once per image, so a preview and a download cannot diverge', async () => {
    await buildSubjectSummaryCardImage(SUMMARY);
    expect(canvas.toBlobCalls).toHaveLength(1);
  });
});

describe('no raw badge id can reach an exported image', () => {
  it('draws canonical labels for every badge it can name', async () => {
    await buildCollectionSnapshotImage(COLLECTION);
    const drawn = canvas.allText();
    for (const badgeId of [...PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID]) {
      expect(drawn, `the raw id ${badgeId} reached the image`).not.toContain(badgeId);
      expect(drawn).toContain(canonicalBadgeLabel(badgeId) as string);
    }
  });

  it('omits an id it cannot name rather than printing it', async () => {
    // The exact pre-Phase-20 defect: `BADGE_LABELS[badgeId] ?? badgeId`.
    await buildCollectionSnapshotImage({
      ...COLLECTION,
      badges: ['NotARealBadgeId', 'CreatorPhaseComplete-legacy', 'room-7f3a'],
    });
    const drawn = canvas.allText();
    for (const unknown of ['NotARealBadgeId', 'CreatorPhaseComplete-legacy', 'room-7f3a']) {
      expect(drawn, unknown).not.toContain(unknown);
    }
    /*
     * And no empty bullet in their place: nothing is drawn for them, so the list falls back to its
     * own sentence.
     *
     * The bullet check is **scoped to the badge list lines**, not the whole image. The card's subtitle
     * is `Collections • Master • 1240 XP` and also contains `• `, so a whole-image assertion here
     * fails for a string that has nothing to do with badges - which is what the first version of this
     * test did, and it failed for the wrong reason.
     */
    const bulletLines = canvas.texts.filter((entry) => entry.text.startsWith('•'));
    expect(bulletLines).toEqual([]);
    expect(drawn).toContain('No badges earned yet.');
  });

  it('keeps naming the badges it can, alongside ones it cannot', async () => {
    await buildCollectionSnapshotImage({
      ...COLLECTION,
      badges: [SCRIBE_CENTURY_120_BADGE_ID, 'NotARealBadgeId'],
    });
    const drawn = canvas.allText();
    expect(drawn).toContain(canonicalBadgeLabel(SCRIBE_CENTURY_120_BADGE_ID) as string);
    expect(drawn).not.toContain('NotARealBadgeId');
    // The heading still counts **all** badges owned, because a learner with three unnamed badges owns
    // three badges. The model documents the same reading.
    expect(drawn).toContain('Badges (2)');
  });

  it('never draws a note body, a room id, a subject id, or a collected timestamp', async () => {
    await buildCollectionSnapshotImage(COLLECTION);
    const drawn = canvas.allText();
    for (const forbidden of [
      'Vector Spaces',
      'room-1',
      'dungeon',
      'A full encounter note.',
      'A full artifact note.',
      'A concise artifact summary.',
      '2026-01-01',
    ]) {
      expect(drawn, forbidden).not.toContain(forbidden);
    }
    // Only the note **count** is published, which is the model-level reading too.
    expect(drawn).toContain('Diary notes in this subject: 1');
  });
});

describe('no clock and no locale reaches an exported image', () => {
  it('draws no timestamp and no generated line', async () => {
    await buildSubjectSummaryCardImage(SUMMARY);
    await buildCollectionSnapshotImage(COLLECTION);
    const drawn = canvas.allText();
    // The pre-Phase-20 line was `Generated: ${new Date().toLocaleString()}`.
    expect(drawn.toLowerCase()).not.toContain('generated');
    expect(drawn).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    for (const { text } of canvas.texts) {
      expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it('renders identically under five host time zones', async () => {
    const originalTz = process.env.TZ;
    const renders: string[] = [];
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Adelaide', 'Pacific/Chatham']) {
        process.env.TZ = zone;
        canvas.texts.length = 0;
        await buildSubjectSummaryCardImage(SUMMARY);
        renders.push(JSON.stringify(canvas.texts.map((entry) => [entry.text, entry.x, entry.y])));
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
    expect(new Set(renders).size, 'one archive rendered differently in two host zones').toBe(1);
  });

  it('reads no clock and no randomness while drawing', async () => {
    const dateNow = vi.spyOn(globalThis.Date, 'now');
    const random = vi.spyOn(Math, 'random');
    await buildSubjectSummaryCardImage(SUMMARY);
    await buildCollectionSnapshotImage(COLLECTION);
    expect(dateNow).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it('regroups no number by locale', async () => {
    await buildSubjectSummaryCardImage({ ...SUMMARY, xpTotal: 1234567 });
    // `toLocaleString` would write `1,234,567` on one device and `1.234.567` on another.
    expect(canvas.allText()).toContain('1234567');
    expect(canvas.allText()).not.toContain('1,234,567');
  });
});

describe('the exporter reads the Cozy token system and nothing else', () => {
  it('asks for a token colour on every fill, and never writes a hex literal as a colour', async () => {
    await buildSubjectSummaryCardImage(SUMMARY);
    await buildCollectionSnapshotImage(COLLECTION);
    const tokenValues = new Set<string>(
      Object.values(COZY_THEMES).flatMap((theme) => Object.values(theme)),
    );
    expect(tokenValues.size).toBeGreaterThan(0);
    for (const entry of canvas.texts) {
      expect(tokenValues.has(entry.fillStyle), entry.text).toBe(true);
    }
    for (const rect of canvas.rects) {
      expect(tokenValues.has(rect.fillStyle)).toBe(true);
      if (rect.stroked) expect(tokenValues.has(rect.strokeStyle)).toBe(true);
    }
  });

  it('names no font family that is not a declared local stack', async () => {
    await buildSubjectSummaryCardImage(SUMMARY);
    await buildCollectionSnapshotImage(COLLECTION);
    expect(canvas.texts.length).toBeGreaterThan(0);
    const stacks = [TYPOGRAPHY.primary, TYPOGRAPHY.body, TYPOGRAPHY.mono];
    for (const entry of canvas.texts) {
      // The `endsWith` is load-bearing: the shorthand is `<weight> <size>px <stack>`, so it *contains*
      // the stack rather than being one. An `includes` test would pass for any string mentioning it.
      expect(entry.font, entry.font).not.toContain('Inter');
      expect(
        stacks.some((stack) => entry.font.endsWith(stack)),
        `font ${entry.font} does not end with a declared system stack`,
      ).toBe(true);
    }
  });

  it('draws a different image per theme, so the theme argument is read', async () => {
    await buildSubjectSummaryCardImage(SUMMARY, { theme: 'cozy-ink' });
    const ink = canvas.texts.map((entry) => entry.fillStyle);
    canvas.texts.length = 0;
    await buildSubjectSummaryCardImage(SUMMARY, { theme: 'cozy-parchment' });
    const parchment = canvas.texts.map((entry) => entry.fillStyle);
    expect(ink).not.toEqual(parchment);
    expect(ink.length).toBe(parchment.length);
  });

  it('produces a complete card when called with no theme at all', async () => {
    const image = await buildSubjectSummaryCardImage(SUMMARY);
    expect(image.blob.type).toBe('image/png');
    // The default recipe is token-complete, so nothing falls back to an undefined style.
    for (const entry of canvas.texts) expect(entry.fillStyle).not.toBe('');
  });
});

describe('the exporter imports no share-lane module', () => {
  it('stays off the declared lane, so the production build can keep it eager', () => {
    /*
     * The rollback argument, asserted. `shareCardPolicy` is a declared share-lane module, and this
     * file is eagerly reachable from the entry chunk - so a static import of the policy from here
     * would fail `vite.config.ts`'s check 2 on the default build. Canonical labels, from
     * `shareCardContent`, are the whole privacy fix needed for a collection image; the policy's
     * field-selection machinery belongs to the lazily opened dialog.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'utils', 'progressionShareExport.ts'),
      'utf8',
    );
    expect(source).toContain('@/core/share/shareCardContent');
    expect(source).not.toContain('@/core/share/shareCardPolicy');
    expect(source).not.toContain('@/ui/share/');
  });

  it('resolves labels through the content module rather than holding its own map', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const source = readFileSync(
      join(process.cwd(), 'src', 'ui', 'utils', 'progressionShareExport.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    // No `?? badgeId`-shaped fallback anywhere: that single expression is the defect.
    expect(code).not.toMatch(/\?\?\s*badgeId/);
    expect(code).not.toMatch(/\?\?\s*badge\b/);
    expect(code).not.toContain('BADGE_LABELS');
  });
});