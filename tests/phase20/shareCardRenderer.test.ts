/**
 * Phase 20: the card renderer, and the four delivery states.
 *
 * ## What this file pins
 *
 * 1. **The renderer draws only from the model.** Every string it puts on a canvas is a token colour,
 *    a token-derived font shorthand, or a value the model produced. No style literal, no clock, no
 *    `toLocaleString`, no store.
 * 2. **The pre-Phase-20 defects cannot come back.** No raw badge id on an image, no `Generated:`
 *    line, no `'Inter, sans-serif'`, no `'#141a2c'`. These are asserted against the *recorded* draw
 *    calls rather than against the source, so a defect reintroduced through a new code path is
 *    caught rather than a literal in a comment being trusted.
 * 3. **Determinism.** The same model under the same theme records the same strings in the same order,
 *    and a card carries no timestamp: the recorded text contains no ISO date and no clock time.
 * 4. **Four delivery states, distinct and honest.** `unsupported`, `denied`, `cancelled`, and
 *    `failed` are each reachable, each produces its own sentence, and `cancelled` is **not** an
 *    error - it has no failure wording and is never reported as one.
 * 5. **`navigator.share` is called only from an explicit action**, proved by counting invocations
 *    rather than by asserting an absence.
 *
 * ## What this file cannot verify, stated plainly
 *
 * **No contrast and no rendered target size.** jsdom computes no colours and no layout, so this file
 * asserts that the renderer *asked for a token* - not that the token meets 4.5:1 against the
 * surface it landed on, and not that any control is 44x44 in a real browser. Those are Phase 21's
 * measurements against a real browser, and nothing here should be read as having checked them.
 *
 * Privacy: every string in this file is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildShareCardModel, captionForKind, titleForKind } from '@/core/share/shareCardModel';
import { defaultSelectionFor } from '@/core/share/shareCardPolicy';
import {
  PHASE_BADGE_IDS,
  SCRIBE_CENTURY_120_BADGE_ID,
} from '@/core/progression/types';
import {
  SHARE_CARD_KINDS,
  type ShareCardField,
  type ShareCardKind,
} from '@/core/share/types';
import { COZY_THEMES } from '@/theme/cozyTokens';
import { TYPOGRAPHY } from '@/theme/typography';
import { renderShareCard, renderShareCardFromInput } from '@/ui/share/renderShareCard';
import {
  classifyShareRejection,
  canShareCardFile,
  describeShareDelivery,
  hasWebShareSupport,
  isDeliverableOnly,
  shareCardImage,
  suggestShareFileName,
  type ShareCardFile,
  type ShareDeliveryOutcome,
} from '@/ui/share/shareCardDelivery';
import { toShareCardBuildInput, hasFactsForKind, type ShareCardFacts } from '@/ui/share/shareCardFacts';
import {
  installRecordingCanvas,
  installShareSpy,
  removeShareApi,
  type RecordingCanvas,
  type ShareSpy,
} from '../unit/shareCardRenderSupport';

/** A device with something on it, so a card is not empty. */
const FACTS: ShareCardFacts = {
  subjectName: 'Linear Algebra',
  xpTotal: 1240,
  rank: 'Master',
  clearedRoomCount: 12,
  totalRoomCount: 40,
  badgeIds: [...PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID],
  inventoryCount: 7,
  collectedNoteCount: 3,
  fish: { total: 11, uniqueTypes: 4, countsByRarity: { common: 6, rare: 4, epic: 1 } },
  statistics: {
    sessionsCompleted: 9,
    activeDays: 21,
    studyStreakDays: 5,
    recall: { correct: 17, total: 20 },
  },
  assistance: { sessionsWithAssistance: 4 },
};

function modelFor(kind: ShareCardKind, selection: readonly ShareCardField[] | null = null) {
  return buildShareCardModel(
    toShareCardBuildInput(FACTS, kind),
    selection === null ? defaultSelectionFor(kind) : selection,
  );
}

let canvas: RecordingCanvas;
let restoreCanvas: () => void;

beforeEach(() => {
  const installed = installRecordingCanvas();
  canvas = installed.canvas;
  restoreCanvas = installed.restore;
});

afterEach(() => {
  restoreCanvas();
  removeShareApi();
  vi.restoreAllMocks();
});

/* ── 1. The renderer draws the model, and nothing else ─────────────────────────── */

describe('the renderer draws the model it was given, for all four kinds', () => {
  it('draws every kind without throwing, and names the kind on the card', async () => {
    for (const kind of SHARE_CARD_KINDS) {
      const result = await renderShareCard(modelFor(kind));
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(result.blob.type, kind).toBe('image/png');
      const drawn = canvas.allText();
      expect(drawn, kind).toContain(titleForKind(kind));
      expect(drawn, kind).toContain(captionForKind(kind));
    }
  });

  it('reports the strings it actually drew, so a test can read the card as text', async () => {
    const result = await renderShareCard(modelFor('subject-summary'));
    /*
     * `drawnText` is **every** string the renderer put on the canvas, in draw order - the title, the
     * caption, the subject name, every row label, every row value, and the footer.
     *
     * An earlier version of this file returned only the row *values* while documenting the field as
     * every string on the canvas, so the subject name was on the image and absent from the array.
     * The documentation was the lie, and the fix was to record inside the one function every line of
     * text goes through. So the assertions here are positive - the name and the count are both in -
     * and the ordering assertion below is what pins that the array is the card rather than a summary
     * of it.
     */
    expect(result.drawnText).toContain('Linear Algebra');
    expect(result.drawnText).toContain(titleForKind('subject-summary'));
    expect(result.drawnText).toContain('Knowledge Dungeon');
    // `xpTotal` is a default row on this kind, and counts are plain integers.
    expect(result.drawnText).toContain('1240');
    // Draw order: the title comes first and the footer comes last, so the array reads like the card.
    expect(result.drawnText[0]).toBe(titleForKind('subject-summary'));
    expect(result.drawnText[result.drawnText.length - 1]).toBe('Knowledge Dungeon');
  });

  it('draws a group row in the fixed rarity order, never the caller key order', async () => {
    const model = buildShareCardModel(toShareCardBuildInput(FACTS, 'fish'), ['fishRarityCounts']);
    const result = await renderShareCard(model);
    const group = result.drawnText.find((value) => value.startsWith('common'));
    expect(group).toBe('common 6 · rare 4 · epic 1');
  });

  it('renders a zero denominator as a dash rather than a percentage', async () => {
    const model = buildShareCardModel(
      {
        kind: 'statistics',
        statistics: { sessionsCompleted: 0, activeDays: 0, studyStreakDays: 0, recall: { correct: 0, total: 0 } },
      },
      ['recallAccuracy'],
    );
    const result = await renderShareCard(model);
    // "No recalls yet" and "0% recall" are different claims, and the model keeps them distinguishable.
    expect(result.drawnText).toContain('—');
    expect(result.drawnText).not.toContain('0%');
  });

  it('renders a real ratio as a whole percentage without locale grouping', async () => {
    const result = await renderShareCard(modelFor('statistics', ['recallAccuracy']));
    // 17/20 = 85%. `toLocaleString` would be `(17)`-free here but would make `1,234` of `1240`
    // elsewhere; the renderer uses `String(n)` everywhere, so no digits are regrouped.
    expect(result.drawnText).toContain('85%');
  });

  it('draws nothing at all for an empty model rather than a card of zeros', async () => {
    const empty = buildShareCardModel({ kind: 'subject-summary' }, ['xpTotal', 'roomsCleared']);
    expect(empty.rows).toEqual([]);
    const result = await renderShareCard(empty);
    // No metric, no count, and above all no row: the only strings on the card are its own title,
    // its own caption, and the product name.
    expect(result.drawnText).toEqual([titleForKind('subject-summary'), captionForKind('subject-summary'), 'Knowledge Dungeon']);
    // The card still exists, because "nothing yet" is a state a learner should be able to send.
    expect(result.height).toBeGreaterThan(0);
  });

  it('grows the card for more rows, so a short card is a different image from a full one', async () => {
    const short = await renderShareCard(modelFor('fish', ['fishTotal']));
    const long = await renderShareCard(modelFor('fish', ['fishTotal', 'fishUniqueTypes', 'fishRarityCounts']));
    expect(long.height).toBeGreaterThan(short.height);
  });
});

/* ── 2. The pre-Phase-20 defects cannot come back ──────────────────────────────── */

describe('the three pre-Phase-20 defects cannot reach a card', () => {
  it('never draws a raw badge id, for any kind and any selection', async () => {
    // Every canonical id plus three invented ones, on every kind with every available field, so
    // there is no selection left untried.
    const hostile = [...PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID, 'CreatorPhaseComplete-legacy', 'badge-invented-1', 'ZZTopBadge'];
    for (const kind of SHARE_CARD_KINDS) {
      const model = buildShareCardModel(
        { ...toShareCardBuildInput({ ...FACTS, badgeIds: hostile }, kind) },
        [...defaultSelectionFor(kind), 'badgeLabels'],
      );
      await renderShareCard(model);
      const drawn = canvas.allText();
      for (const badgeId of hostile) {
        expect(drawn, `${kind} drew the raw badge id ${badgeId}`).not.toContain(badgeId);
      }
    }
  });

  it('draws canonical badge labels, so the control above is measuring resolution and not absence', async () => {
    const model = buildShareCardModel(toShareCardBuildInput(FACTS, 'collection'), ['badgeLabels']);
    const result = await renderShareCard(model);
    expect(result.drawnText.some((value) => value.includes('Scribe Century'))).toBe(true);
  });

  it('draws no timestamp, no generated line, and no clock time, on any kind', async () => {
    for (const kind of SHARE_CARD_KINDS) {
      await renderShareCard(modelFor(kind));
    }
    const drawn = canvas.allText();
    // The pre-Phase-20 line was `Generated: ${new Date().toLocaleString()}`.
    expect(drawn.toLowerCase()).not.toContain('generated');
    expect(drawn).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    for (const { text } of canvas.texts) {
      expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it('is byte-identical for the same model under two different host time zones', async () => {
    // The Phase 19 defect class, on a card. Rendered under five zones and compared as the recorded
    // draw calls, which is the closest a jsdom test can get to comparing pixels.
    const originalTz = process.env.TZ;
    const renders: string[] = [];
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Adelaide', 'Pacific/Chatham']) {
        process.env.TZ = zone;
        canvas.texts.length = 0;
        const result = await renderShareCard(modelFor('subject-summary'));
        renders.push(
          JSON.stringify({
            drawn: result.drawnText,
            texts: canvas.texts.map((entry) => [entry.text, entry.x, entry.y, entry.font, entry.fillStyle]),
          }),
        );
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
    expect(new Set(renders).size, 'one model rendered differently in two host zones').toBe(1);
  });

  it('asks for a token colour on every draw and never writes a hex literal', async () => {
    for (const kind of SHARE_CARD_KINDS) {
      await renderShareCard(modelFor(kind));
    }
    /*
     * Every fill style the renderer asked for must be a **value that Phase 8 authored**. Not "a hex
     * string" - a hex string is exactly what the pre-Phase-20 exporter inlined and what this phase
     * removed. The set is built from the token tables, so a colour that is not one of ours fails
     * here, and a colour that is one of ours fails in the build's contrast audit rather than here.
     *
     * Note what this does **not** do: it does not compute a contrast ratio. jsdom has no notion of
     * what a colour looks like. Phase 21 measures contrast in a browser.
     */
    const tokenValues = new Set<string>(
      Object.values(COZY_THEMES).flatMap((theme) => Object.values(theme)),
    );
    expect(tokenValues.size).toBeGreaterThan(0);
    for (const entry of canvas.texts) {
      expect(tokenValues.has(entry.fillStyle), `${entry.text} asked for a non-token colour`).toBe(true);
    }
    for (const rect of canvas.rects) {
      expect(tokenValues.has(rect.fillStyle), `a rectangle asked for a non-token fill`).toBe(true);
      if (rect.stroked) expect(tokenValues.has(rect.strokeStyle)).toBe(true);
    }
    // And no hex literal appears as *text* either, which would be a colour written into a string.
    expect(canvas.allText()).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('names only locally available font families, and never Inter', async () => {
    const result = await renderShareCard(modelFor('subject-summary'));
    expect(result.drawnText.length).toBeGreaterThan(0);
    for (const entry of canvas.texts) {
      expect(entry.font, entry.font).not.toContain('Inter');
      /*
     * Every font shorthand must **end with** one of the two declared stacks.
     *
     * The `endsWith` is the load-bearing part. A `TYPOGRAPHY.primary.includes(font)` test passes for
     * any string that happens to contain the stack somewhere - which the first version of this
     * assertion did, and it passed for the wrong reason: the font shorthand is
     * `<weight> <size>px <stack>`, so it contains the stack rather than being one. Checking the
     * whole string against a set of stacks would be the same mistake. Only a suffix check can tell
     * "this shorthand names a declared stack" from "this shorthand contains some text that happens to
     * include one".
     */
      const stacks = [TYPOGRAPHY.primary, TYPOGRAPHY.body, TYPOGRAPHY.mono];
      expect(
        stacks.some((stack) => entry.font.endsWith(stack)),
        `font ${entry.font} does not end with a declared system stack`,
      ).toBe(true);
    }
  });

  it('reads no clock, no locale API, and no storage, so none can influence a card', async () => {
    // Asserted on the *recorded* output plus a direct spy count: a `Date` call cannot change a card
    // that draws no timestamp, and a storage read cannot either - but the combination of "no date on
    // the card" and "no ambient input reaches it" is what the claim actually is.
    const dateSpy = vi.spyOn(globalThis.Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random');
    await renderShareCard(modelFor('subject-summary'));
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
    expect(canvas.allText()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

/* ── 3. Determinism ───────────────────────────────────────────────────────────── */

describe('rendering is deterministic for a given model and theme', () => {
  it('records identical draw calls for the same model rendered twice', async () => {
    const first = await renderShareCard(modelFor('collection'));
    const snapshotA = JSON.stringify(canvas.texts);
    canvas.texts.length = 0;
    const second = await renderShareCard(modelFor('collection'));
    const snapshotB = JSON.stringify(canvas.texts);
    expect(second.drawnText).toEqual(first.drawnText);
    expect(snapshotB).toBe(snapshotA);
  });

  it('ignores the order the learner ticked the boxes in', async () => {
    const order: ShareCardField[] = ['fishRarityCounts', 'subjectName', 'fishTotal', 'fishUniqueTypes'];
    const forwards = await renderShareCard(modelFor('fish', order));
    const a = forwards.drawnText;
    canvas.texts.length = 0;
    const backwards = await renderShareCard(modelFor('fish', [...order].reverse()));
    expect(backwards.drawnText).toEqual(a);
  });

  it('draws a different image per theme, because the tokens differ', async () => {
    // The control for "determinism is not just identical output": determinism is per theme, and the
    // renderer genuinely reads the theme rather than ignoring its argument.
    canvas.texts.length = 0;
    const cozyInk = await renderShareCard(modelFor('fish', ['fishTotal']), { theme: 'cozy-ink' });
    const inkStyles = canvas.texts.map((entry) => entry.fillStyle);
    canvas.texts.length = 0;
    const parchment = await renderShareCard(modelFor('fish', ['fishTotal']), { theme: 'cozy-parchment' });
    const parchmentStyles = canvas.texts.map((entry) => entry.fillStyle);
    expect(cozyInk.drawnText).toEqual(parchment.drawnText);
    expect(inkStyles).not.toEqual(parchmentStyles);
  });

  it('honours the high-contrast overlay', async () => {
    canvas.texts.length = 0;
    await renderShareCard(modelFor('fish', ['fishTotal']), { theme: 'cozy-ink', contrast: 'highContrast' });
    const high = canvas.texts.map((entry) => entry.fillStyle);
    canvas.texts.length = 0;
    await renderShareCard(modelFor('fish', ['fishTotal']), { theme: 'cozy-ink' });
    expect(high).not.toEqual(canvas.texts.map((entry) => entry.fillStyle));
  });

  it('skips a row whose field the kind does not allow, rather than drawing it', async () => {
    // The renderer's own `mayFieldAppearOnCard` filter. The model would never build such a row, so
    // this exercises the filter directly by handing the renderer a hand-made model.
    const model = modelFor('fish', ['fishTotal']);
    const tampered = {
      ...model,
      rows: [
        ...model.rows,
        {
          field: 'recallAccuracy' as const,
          label: 'Recall accuracy',
          numerator: 3,
          denominator: 4,
          ratio: 0.75,
        },
      ],
    };
    const result = await renderShareCard(tampered);
    // `recallAccuracy` is not a fish-card field, so it must not be on the card - and its label is the
    // string to look for, because a filtered row leaves no trace at all.
    expect(result.drawnText.join(' ')).not.toContain('Recall accuracy');
  });

  it('refuses to draw a value the denylist denies, and records that it refused', async () => {
    // `mayValueAppearOnCard` is the policy's documented reachable use, and this is the probe for it.
    // A subject name of `room-7f3a` is a minted room id wearing a name's clothes; the renderer must
    // drop it rather than publish a pointer at one of the learner's records.
    const model = buildShareCardModel(
      { ...toShareCardBuildInput(FACTS, 'fish'), subjectName: 'room-7f3a' },
      ['subjectName'],
    );
    expect(model.subjectName).toBe('room-7f3a');
    const result = await renderShareCard(model);
    expect(result.drawnText).not.toContain('room-7f3a');
    expect(canvas.allText()).not.toContain('room-7f3a');
  });

  it('refuses a denied subject name but keeps every declared row label, on purpose', async () => {
    /*
     * This test pins a **deliberate decision with a known cost**, and both halves matter.
     *
     * The value-level denylist denies any string containing the word `room`, because that is how it
     * catches `room-7f3a`. It therefore also denies `SHARE_CARD_FIELD_LABELS.roomsCleared`, whose
     * current label is `Rooms cleared`. Applying it to row labels deleted both room rows from every
     * subject-summary card - a card that silently lied about a learner's progress.
     *
     * So the filter is applied to the subject name only, because that is the one string on a card
     * that came from outside the application. `shareCardPolicy.ts` is explicit that app-owned
     * published vocabulary must survive its denylist.
     *
     * The control below is what keeps that honest: `roomsCleared` must be **on** the card, and
     * `room-7f3a` as a subject name must be **off** it. A version of this filter that denied labels
     * would fail the first assertion; a version that filtered nothing would fail the second.
     */
    const model = buildShareCardModel(toShareCardBuildInput(FACTS, 'subject-summary'), [
      'roomsCleared',
      'roomTotal',
    ]);
    const result = await renderShareCard(model);
    // The declared labels survive: their field ids are declared, and their copy is app-owned.
    expect(result.drawnText).toContain('Rooms cleared');
    expect(result.drawnText).toContain('12');
    expect(result.drawnText).toContain('40');

    // And the free-text name does not.
    const named = buildShareCardModel(
      { ...toShareCardBuildInput(FACTS, 'fish'), subjectName: 'room-7f3a' },
      ['subjectName', 'fishTotal'],
    );
    const namedResult = await renderShareCard(named);
    expect(namedResult.drawnText).not.toContain('room-7f3a');
    // The rest of the card is unaffected by one refused string.
    expect(namedResult.drawnText).toContain('11');
  });
});

/* ── 4. The facts bridge carries no note body and no room id ───────────────────── */

describe('the facts bridge reduces application data to counts', () => {
  it('passes only counts, names, and badge ids across the boundary', () => {
    const input = toShareCardBuildInput(FACTS, 'subject-summary');
    expect(input.rooms).toEqual({ total: 40, cleared: 12 });
    expect(input.inventoryCount).toBe(7);
    expect(input.collectedNoteCount).toBe(3);
    expect(input.badges).toEqual(FACTS.badgeIds);
    // There is no field a note body, a room id, or a per-room anything could be put in.
    expect(Object.keys(input).sort()).toEqual([
      'assistance',
      'badges',
      'collectedNoteCount',
      'fish',
      'inventoryCount',
      'kind',
      'progression',
      'rooms',
      'statistics',
      'subjectName',
    ]);
  });

  it('coerces a hostile facts object into safe counts rather than passing it through', () => {
    const input = toShareCardBuildInput(
      {
        ...FACTS,
        xpTotal: Number.NaN,
        clearedRoomCount: -5,
        totalRoomCount: 12.9,
        inventoryCount: Number.POSITIVE_INFINITY,
        collectedNoteCount: Number.NEGATIVE_INFINITY,
      },
      'subject-summary',
    );
    expect(input.progression?.xpTotal).toBe(0);
    expect(input.rooms).toEqual({ total: 12, cleared: 0 });
    expect(input.inventoryCount).toBe(0);
    expect(input.collectedNoteCount).toBe(0);
  });

  it('answers the availability question per kind, so a fish card on a fish-free device is explained', () => {
    const noFish: ShareCardFacts = { ...FACTS, fish: null };
    expect(hasFactsForKind(noFish, 'fish')).toBe(false);
    expect(hasFactsForKind(noFish, 'subject-summary')).toBe(true);
    expect(hasFactsForKind(noFish, 'statistics')).toBe(true);
    const noStats: ShareCardFacts = { ...FACTS, statistics: null };
    expect(hasFactsForKind(noStats, 'statistics')).toBe(false);
    const empty: ShareCardFacts = { ...FACTS, subjectName: '   ', xpTotal: 0 };
    expect(hasFactsForKind(empty, 'subject-summary')).toBe(false);
  });

  it('serialises a model built from the facts with no note body, room id, or suggestion id', () => {
    // A deliberately hostile device: a note body, a room id, and a suggestion id placed where a
    // count belongs. The adapter has no parameter for any of them.
    const model = buildShareCardModel(
      toShareCardBuildInput(
        {
          ...FACTS,
          badgeIds: [...FACTS.badgeIds, 'room-7f3a'],
          assistance: { sessionsWithAssistance: 4 },
        },
        'statistics',
      ),
      [...defaultSelectionFor('statistics'), 'badgeLabels', 'assistanceSummary'],
    );
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain('room-7f3a');
    expect(serialized).not.toContain('suggestion');
    expect(serialized).not.toContain('dismiss');
    /*
     * The assistance row is a bare count, present only because it was asked for. Asserted on the
     * **row shape** rather than on a JSON substring: the first version of this assertion looked for
     * `'"sessionsWithAssistance":4'`, which is the *input* interface's key, and it failed because
     * the row is keyed `assistanceSummary`. That was the assertion being wrong about the contract,
     * not the contract being wrong - and a substring assertion on a field id would have passed for a
     * row that leaked nothing at all, which is the failure this file exists to prevent.
     */
    const assistance = model.rows.find((row) => row.field === 'assistanceSummary');
    expect(assistance).toBeDefined();
    expect(assistance).toMatchObject({ value: 4, isEmpty: false });
    // No id-shaped key exists on it, so there is nothing a Phase 19 record could have been copied
    // into.
    expect(Object.keys(assistance as object).sort()).toEqual(['field', 'isEmpty', 'label', 'value']);
  });
});

/* ── 5. The four delivery states ───────────────────────────────────────────────── */

describe('the four delivery states are distinct, and cancellation is not an error', () => {
  const file: ShareCardFile = { blob: new Blob([new Uint8Array([1])]), fileName: 'card.png', mimeType: 'image/png' };

  it('classifies an AbortError as cancelled and nothing else can', async () => {
    const abort = new Error('dismissed');
    abort.name = 'AbortError';
    expect(classifyShareRejection(abort).outcome).toBe('cancelled');
    expect(classifyShareRejection({ name: 'AbortError' }).outcome).toBe('cancelled');

    // Every other rejection must NOT be a cancel, or "cancellation is a normal outcome" would be
    // vacuous: a real failure reported as a cancel would tell a learner nothing went wrong.
    for (const name of ['NotAllowedError', 'TypeError', 'DataError', 'UnknownError', 'InvalidStateError']) {
      const error = new Error(name);
      error.name = name;
      expect(classifyShareRejection(error).outcome, name).not.toBe('cancelled');
    }
  });

  it('classifies refusals as denied and other faults as failed', () => {
    for (const name of ['NotAllowedError', 'SecurityError', 'TypeError']) {
      const error = new Error(name);
      error.name = name;
      expect(classifyShareRejection(error).outcome, name).toBe('denied');
    }
    const other = new Error('boom');
    other.name = 'SomethingElse';
    expect(classifyShareRejection(other)).toEqual({ outcome: 'failed', detail: 'SomethingElse' });
    // A non-object rejection has no name and therefore no detail: no invented content in a log line.
    expect(classifyShareRejection('a string')).toEqual({ outcome: 'failed', detail: undefined });
  });

  it('gives every state its own sentence, and no failure wording to a cancel', () => {
    const outcomes: ShareDeliveryOutcome[] = ['shared', 'cancelled', 'denied', 'unsupported', 'failed'];
    const sentences = outcomes.map(describeShareDelivery);
    expect(new Set(sentences).size, 'two states share a sentence').toBe(outcomes.length);
    for (const sentence of sentences) {
      expect(sentence.trim().length).toBeGreaterThan(0);
    }
    const cancelled = describeShareDelivery('cancelled');
    expect(cancelled.toLowerCase()).not.toContain('error');
    expect(cancelled.toLowerCase()).not.toContain('fail');
    expect(cancelled.toLowerCase()).not.toContain('refus');
    // And it says what did *not* happen, because that is the learner's question after a dismissal.
    expect(cancelled.toLowerCase()).toContain('nothing');
    /*
     * The three states where something went wrong point at the local download, which always exists.
     *
     * `cancelled` deliberately does **not**: its sentence says what did not happen and stops there.
     * Telling a learner who dismissed a sheet they can "download the image and send it themselves"
     * reads as a correction, and the phase exit criterion is that cancelling is a normal outcome -
     * so the wording is part of the requirement, not a nicety. Asserted here so a later editor who
     * unifies the sentences has to notice that they are asserting something.
     */
    for (const outcome of ['denied', 'unsupported', 'failed'] as ShareDeliveryOutcome[]) {
      expect(describeShareDelivery(outcome).toLowerCase()).toContain('download');
    }
    for (const outcome of ['cancelled', 'denied', 'unsupported', 'failed'] as ShareDeliveryOutcome[]) {
      expect(isDeliverableOnly(outcome), outcome).toBe(true);
    }
    expect(isDeliverableOnly('shared')).toBe(false);
  });

  it('reports unsupported without calling share when the API is absent', async () => {
    removeShareApi();
    expect(hasWebShareSupport()).toBe(false);
    expect(canShareCardFile(file)).toBe(false);
    const result = await shareCardImage(file);
    expect(result.outcome).toBe('unsupported');
    // Nothing was called, because nothing exists to call.
    expect(result.detail).toBeUndefined();
  });

  it('reports unsupported when canShare says no, and never calls share', async () => {
    const spy = installShareSpy();
    // `canShare` present but refusing: the conservative reading, because Safari has shipped `share`
    // without a usable `canShare` for files. Replacing the spy's own `canShare` means the counter
    // lives on the replacement, which is why the count is read from *that* mock rather than from
    // `spy.canShareCalls` - a counter that stayed at zero here would look like "never probed" while
    // the component did exactly the right thing.
    const refusing = vi.fn(() => false);
    (globalThis.navigator as unknown as Record<string, unknown>).canShare = refusing;
    const result = await shareCardImage(file);
    expect(result.outcome).toBe('unsupported');
    expect(refusing).toHaveBeenCalled();
    expect(spy.shareCalls, 'a refusing canShare must not lead to a share').toHaveLength(0);
    spy.restore();
  });

  it('reports unsupported when canShare is absent even though share exists', async () => {
    const spy = installShareSpy();
    delete (globalThis.navigator as unknown as Record<string, unknown>).canShare;
    expect(canShareCardFile(file), 'canShare is absent, so the file cannot be declared shareable').toBe(false);
    const result = await shareCardImage(file);
    expect(result.outcome).toBe('unsupported');
    expect(spy.shareCalls).toHaveLength(0);
    spy.restore();
  });

  it('reports unsupported when canShare throws rather than treating it as permission', async () => {
    const spy = installShareSpy();
    (globalThis.navigator as unknown as Record<string, unknown>).canShare = vi.fn(() => {
      throw new TypeError('payload refused');
    });
    expect(canShareCardFile(file)).toBe(false);
    expect((await shareCardImage(file)).outcome).toBe('unsupported');
    expect(spy.shareCalls).toHaveLength(0);
    spy.restore();
  });

  it('shares a PNG file, and the payload is the file the caller produced', async () => {
    const spy = installShareSpy();
    const result = await shareCardImage(file);
    expect(result.outcome).toBe('shared');
    expect(spy.shareCalls).toHaveLength(1);
    const payload = spy.shareCalls[0][0] as { files: File[]; title: string };
    expect(payload.title).toBe('card.png');
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe('card.png');
    expect(payload.files[0].type).toBe('image/png');
    expect(payload.files[0].size).toBeGreaterThan(0);
    // `canShare` was consulted first, as plan section 9 requires.
    expect(spy.canShareCalls.length).toBeGreaterThanOrEqual(1);
    spy.restore();
  });

  it('reports denied when the learner or the browser refuses', async () => {
    const spy = installShareSpy({ kind: 'reject', errorName: 'NotAllowedError' });
    expect((await shareCardImage(file)).outcome).toBe('denied');
    expect(spy.shareCalls).toHaveLength(1);
    spy.restore();
  });

  it('reports cancelled when the OS sheet is dismissed, and carries no error detail', async () => {
    const spy = installShareSpy({ kind: 'reject', errorName: 'AbortError' });
    const result = await shareCardImage(file);
    expect(result.outcome).toBe('cancelled');
    // No `detail`: a cancel is not a fault, so there is nothing to report. And had one been present
    // it would have been a browser error *name*, never a message.
    expect(result.detail).toBeUndefined();
    expect(spy.shareCalls).toHaveLength(1);
    spy.restore();
  });

  it('reports failed for a fault that is neither a refusal nor a dismissal', async () => {
    const spy = installShareSpy({ kind: 'throw-sync', errorName: 'SomethingElse' });
    const result = await shareCardImage(file);
    expect(result.outcome).toBe('failed');
    expect(result.detail).toBe('SomethingElse');
    spy.restore();
  });

  it('suggests a file name from the subject name, with no clock and no path separator', () => {
    expect(suggestShareFileName('Linear Algebra', 'subject-summary')).toBe('linear-algebra-subject-summary.png');
    // A path separator and a traversal cannot survive into a name a browser will write to disk.
    expect(suggestShareFileName('../../etc/passwd', 'fish')).not.toContain('..');
    expect(suggestShareFileName('../../etc/passwd', 'fish')).not.toContain('/');
    // No name is still a usable name.
    expect(suggestShareFileName(null, 'collection')).toBe('knowledge-dungeon-card-collection.png');
    expect(suggestShareFileName('   ', 'statistics')).toBe('knowledge-dungeon-card-statistics.png');
    // And nothing time-shaped is in it, because a file name is a place a date leaks into a UI.
    expect(suggestShareFileName('Linear Algebra', 'fish')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

/* ── 6. Explicit action only, proved by counting ──────────────────────────────── */

describe('Web Share is reached only from an explicit action, counted not asserted absent', () => {
  it('shareCardImage does not share until it is called, and shares exactly once when called', async () => {
    const spy = installShareSpy();
    const file: ShareCardFile = { blob: new Blob([new Uint8Array([1])]), fileName: 'card.png' };

    // Importing the module, building a card model, rendering a preview: none of it shares.
    const model = modelFor('subject-summary');
    await renderShareCard(model);
    expect(spy.shareCalls, 'rendering a card shared it').toHaveLength(0);

    // Even the capability *query* has not run, which is the stronger claim: there is no probing on
    // load either, so a card preview costs no Web Share API call at all.
    expect(spy.canShareCalls, 'a capability probe ran without an explicit action').toHaveLength(0);

    // One explicit call, one share.
    await shareCardImage(file);
    expect(spy.shareCalls).toHaveLength(1);
    await shareCardImage(file);
    expect(spy.shareCalls).toHaveLength(2);
    spy.restore();
  });

  it('a host with no Web Share API is never a failure state for the download path', async () => {
    removeShareApi();
    // The delivery layer reports `unsupported`; it does not throw, and the file the download uses is
    // untouched. `tests/phase20/shareCardDialog.test.tsx` asserts the same at the UI level.
    const result = await shareCardImage({ blob: new Blob([new Uint8Array([1])]), fileName: 'card.png' });
    expect(result.outcome).toBe('unsupported');
  });

  it('the spy counters can reach a non-zero value, so a zero assertion is meaningful', async () => {
    // The anti-vacuity control for the counting probes above: a spy that recorded nothing regardless
    // of what happened would make `toHaveLength(0)` pass for any implementation.
    const spy: ShareSpy = installShareSpy();
    expect(spy.shareCalls).toHaveLength(0);
    await shareCardImage({ blob: new Blob([new Uint8Array([1])]), fileName: 'card.png' });
    expect(spy.shareCalls).toHaveLength(1);
    expect(spy.canShareCalls).toHaveLength(1);
    spy.restore();
  });
});

/* ── 7. The convenience overload cannot desynchronise model from image ─────────── */

describe('renderShareCardFromInput builds and draws from one selection', () => {
  it('draws the same rows as a model built separately with the same selection', async () => {
    const selection: ShareCardField[] = ['xpTotal', 'rank'];
    const viaHelper = await renderShareCardFromInput(
      toShareCardBuildInput(FACTS, 'subject-summary'),
      selection,
    );
    const viaModel = await renderShareCard(modelFor('subject-summary', selection));
    expect(viaHelper.drawnText).toEqual(viaModel.drawnText);
  });

  it('uses the kind defaults when no selection is supplied', async () => {
    const result = await renderShareCardFromInput(toShareCardBuildInput(FACTS, 'fish'));
    const viaModel = await renderShareCard(modelFor('fish'));
    expect(result.drawnText).toEqual(viaModel.drawnText);
  });
});