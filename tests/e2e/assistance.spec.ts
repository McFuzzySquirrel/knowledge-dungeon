import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  ASSISTANCE_ANY_SELECTOR,
  ASSISTANCE_CARD_CHUNK_REQUEST_MATCH,
  ASSISTANCE_CARD_SELECTOR,
  ASSISTANCE_DEFAULT_MANIFEST_PATH,
  ASSISTANCE_DISMISS_SELECTOR,
  ASSISTANCE_DISMISSED_SELECTOR,
  ASSISTANCE_EXPECTED_KIND,
  ASSISTANCE_EXPECTED_REASON_CODE,
  ASSISTANCE_EXPECTED_SURFACE,
  ASSISTANCE_FLAG,
  ASSISTANCE_LANE,
  ASSISTANCE_MANIFEST_PATH,
  ASSISTANCE_PROBES,
  ASSISTANCE_REASON_DETAIL_I18N_KEY,
  ASSISTANCE_STATUS_SELECTOR,
  ASSISTANCE_STORE_CHUNK_REQUEST_MATCH,
  ASSISTANCE_TITLE_I18N_KEY,
} from './assistance-lane';
import {
  driveMissedRecallJourney,
  installAssistanceNetworkSpy,
  localOriginFor,
  readFirstSuggestion,
} from './assistance-journey';

/**
 * The Phase 21 flagged assistance lane, against a `VITE_ADAPTIVE_ASSISTANCE=true` artifact.
 *
 * ## What this is the only browser evidence for
 *
 * Phase 19 shipped a suggestion card behind a `productionDefault: false` flag and no browser had
 * ever rendered one. This spec observes a card: the region, a suggestion inside it, the reason
 * sentence that explanation derives from `(reasonCode, signalValue, evidence)`, the numbers the
 * card publishes about that ranking, the polite announcement region, and the Dismiss control a
 * learner can reach and press.
 *
 * ## Why the copy is read from the locale file rather than typed here
 *
 * The same discipline `currentBuild.spec.ts` applies to `VILLAGE_MAP`. A spec that retyped
 * "A recall question at the pond went unanswered on this visit." would keep passing after the copy
 * changed, which is exactly the failure mode the Phase 12 refactor had: a renderer selecting
 * dialogue against an empty quest step, invisible to every assertion. So the sentence is read out
 * of `src/i18n/locales/en.json` at run time and the two i18n keys are what the assertion names.
 *
 * ## Why three tests and not one
 *
 * They fail for three different reasons and a reader needs to tell them apart without re-running:
 *
 * 1. **The artifact.** Which recorded identity is on disk, verified. A red test here means the
 *    lane was pointed at the wrong `dist/`, which is the mistake the preflight also guards.
 * 2. **The card.** The observation itself, including that the lane chunk was fetched - which is
 *    what distinguishes a card rendered by the lane from one that happened to be in the page.
 * 3. **The control.** Dismissal is the only thing a suggestion can do, and the assertion is that
 *    it is advisory: the row goes, a sentence replaces it, and nothing is written anywhere.
 *
 * ## No skip
 *
 * There is no `test.skip` and no `test.fixme`. A lane that passes by not measuring is the failure
 * this repository forbids, and the default-artifact lane is where the other direction of the same
 * claim is established.
 *
 * ## Privacy
 *
 * The application's own synthetic recall fixture, the authored village map's own structure ids, and
 * bounded categories. The network spy records origin and path only, and aborts anything that is
 * not loopback.
 */

const REPO_ROOT = process.cwd();
const LOCAL_ORIGIN = localOriginFor(ASSISTANCE_LANE.previewPort);

/**
 * The two i18n keys the card renders, resolved out of the shipped locale file.
 *
 * Read once at module scope because a spec that resolved them per assertion could pass on the
 * first and fail on the second with a stale file, and because a resolution failure should be an
 * import-time error rather than a red assertion three minutes into a browser run.
 */
const EN = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as unknown;

/**
 * One dotted i18n path resolved through the locale object.
 *
 * A general walk rather than a fixed three-part split, because the two keys this lane asserts have
 * different depths: `assistance.detail.fishing-recall-missed` is three segments and
 * `assistance.title.fishing.navigation-after-miss` is four. A resolver that assumed one shape
 * would silently return the wrong node for the other, and `expect(...).toBe()` against an object
 * rather than a string is a failure that reads like a copy change.
 *
 * Every intermediate step is asserted, so a key that no longer exists names itself instead of
 * failing as an equality against `undefined`.
 */
function localeAt(key: string): string {
  let node: unknown = EN;
  for (const segment of key.split('.')) {
    expect(
      typeof node === 'object' && node !== null,
      `${key}: the i18n path walked into a non-object before ${segment}`,
    ).toBe(true);
    node = (node as Record<string, unknown>)[segment];
  }
  expect(typeof node, `${key} is not a string in src/i18n/locales/en.json`).toBe('string');
  return node as string;
}

test.describe('the flagged assistance lane', () => {
  test('the artifact on disk is the recorded VITE_ADAPTIVE_ASSISTANCE build', async ({ page }) => {
    // The identity is verified by the lane's npm script before Playwright starts; this test
    // records the same fact from the page's own point of view, and asserts the one thing the
    // manifest cannot: that the compiled flag reached the served artifact. A `dist/` that is the
    // right bytes but the wrong build would still be the wrong build.
    const spy = await installAssistanceNetworkSpy(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });

    // A Web Share / storage identity is not readable from the page, so the flag is asserted the
    // way it is observable: the lane's chunk names, which exist in both builds, plus the request
    // observation, which is the flagged lane's own second witness. The strict flag check is the
    // preflight's, and it reads the emitted bytes.
    expect(spy.observations().length).toBeGreaterThan(0);
    expect(
      spy.offOriginPaths(LOCAL_ORIGIN),
      'the Welcome route asked for something off the preview origin',
    ).toEqual([]);
    expect(ASSISTANCE_LANE.expectsFlagOn, 'this lane runs against the flagged build').toBe(true);
    expect(ASSISTANCE_FLAG).toBe('VITE_ADAPTIVE_ASSISTANCE');
    expect(ASSISTANCE_DEFAULT_MANIFEST_PATH).not.toBe(ASSISTANCE_MANIFEST_PATH);
  });

  test('a real suggestion card renders, with its reason text and its dismiss control', async ({
    page,
  }) => {
    const spy = await installAssistanceNetworkSpy(page);
    const outcome = await driveMissedRecallJourney(page, spy);

    // Every failure below reports the journey's own measurements rather than a paraphrase, and
    // the premise list is asserted first so "the card never appeared" can never be the diagnosis
    // for a walk that never arrived or a cast that never caught.
    expect(outcome.premiseFailures, outcome.premiseFailures.join('\n')).toEqual([]);
    expect(outcome.reading.enteredFishing, 'the walk to the fishing pond did not open a session').toBe(
      true,
    );
    expect(
      outcome.reading.caughtFishLabel,
      `no fish was revealed after ${outcome.reading.pressCount} press(es) on the pond`,
    ).not.toBeNull();
    expect(
      outcome.reading.recallQuestionOffered,
      'the recall dialog offered no "I got that wrong" answer, so the missed-recall state the card ' +
        'is mounted on never happened',
    ).toBe(true);
    expect(outcome.reading.recallMissed).toBe(true);

    // The card region. `toHaveCount(1)` rather than `toBeVisible`, because a card that rendered
    // twice is a different defect from a card that did not render, and only the count separates
    // them.
    const card = page.locator(ASSISTANCE_PROBES.card);
    await expect(card, 'no assistance card region was rendered').toHaveCount(1, { timeout: 30_000 });

    // The surface filter, published by the card itself so a test can tell the four apart.
    await expect(card).toHaveAttribute('data-assistance-surface', ASSISTANCE_EXPECTED_SURFACE);

    // The row, and its own machine-readable account of itself.
    const row = page.locator(ASSISTANCE_PROBES.suggestion);
    await expect(row).toHaveCount(1);
    const suggestion = await readFirstSuggestion(page);
    expect(suggestion.kind, 'the rendered suggestion was not the one the lane drove').toBe(
      ASSISTANCE_EXPECTED_KIND,
    );
    expect(suggestion.reasonCode).toBe(ASSISTANCE_EXPECTED_REASON_CODE);
    // A real integer in the engine's `0..100` band, and at least one evidence row behind it. A
    // missing attribute would arrive as `NaN` and fail here rather than as a silent pass.
    expect(Number.isInteger(suggestion.priority)).toBe(true);
    expect(suggestion.priority as number).toBeGreaterThan(0);
    expect(suggestion.priority as number).toBeLessThanOrEqual(100);
    expect(suggestion.evidenceCount as number).toBeGreaterThan(0);
    expect(['step', 'cue', 'example'], 'intensity must be the engine\'s closed vocabulary').toContain(
      suggestion.intensity,
    );

    // The reason text, against the shipped locale. Read from the file, so a copy change is a red
    // test naming the key rather than a test that quietly stopped checking anything.
    expect(suggestion.title).toBe(localeAt(ASSISTANCE_TITLE_I18N_KEY));
    expect(suggestion.reasonText).toBe(localeAt(ASSISTANCE_REASON_DETAIL_I18N_KEY));
    expect(suggestion.reasonText).not.toBe('');

    // The dismiss control, as a real focusable control whose accessible name says which
    // suggestion it will set aside.
    const dismiss = page.locator(ASSISTANCE_PROBES.dismiss);
    await expect(dismiss).toHaveCount(1);
    await expect(dismiss).toBeVisible();
    await expect(dismiss).toHaveAttribute('aria-label', `${suggestion.dismissLabel}: ${suggestion.title}`);
    const touchTarget = await dismiss.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        minWidth: style.minWidth,
        minHeight: style.minHeight,
        width: box.width,
        height: box.height,
        tabbable: (element as HTMLButtonElement).tabIndex >= 0,
      };
    });
    expect(touchTarget.tabbable, 'the Dismiss control is not reachable by keyboard').toBe(true);
    // The 44 CSS-pixel floor, read from the laid-out box rather than from the stylesheet: a rule
    // that a stylesheet failed to load would leave `minWidth: auto` and this would fail, which is
    // the point.
    expect(touchTarget.width, 'the Dismiss control is narrower than 44 CSS pixels').toBeGreaterThanOrEqual(44);
    expect(touchTarget.height, 'the Dismiss control is shorter than 44 CSS pixels').toBeGreaterThanOrEqual(44);

    // The polite announcement region. Present, and empty on the first frame by the card's own
    // design - it announces a *change*, so a region that spoke on arrival would be a defect.
    const status = page.locator(ASSISTANCE_PROBES.status);
    await expect(status).toHaveAttribute('role', 'status');
    expect(await status.innerText()).toBe('');

    /*
     * The second witness: the card's own chunk was actually fetched.
     *
     * Without this the card could be satisfying the assertion from anywhere - a leftover region,
     * a fixture, a stale page - and the lane would still be green. With it, the observation is
     * that the route a learner takes asked for the card and the card rendered. The
     * default-artifact lane asserts the mirror of exactly this, which is why the pair is evidence
     * and one of them alone is not.
     *
     * `AssistanceRegion-*` specifically, and not "a lane chunk". The store chunk is fetched by
     * every build at bootstrap - `runBootstrap` awaits `loadAssistanceStore()` and hydration is
     * unconditional - so matching it would make this assertion true before the card had rendered
     * anything at all. See `ASSISTANCE_CARD_CHUNK_STEM`.
     */
    const laneRequests = spy.scriptPathsMatching(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH);
    expect(
      laneRequests,
      'the flagged artifact never requested the assistance card chunk, so the card was not rendered by ' +
        'the lane this build is supposed to carry',
    ).not.toEqual([]);

    expect(spy.pageErrors(), `page errors during the journey: ${spy.pageErrors().join(' | ')}`).toEqual([]);
    expect(
      spy.offOriginPaths(LOCAL_ORIGIN),
      `requests left the preview origin: ${spy.offOriginPaths(LOCAL_ORIGIN).join(', ')}`,
    ).toEqual([]);
  });

  test('dismissing a suggestion is advisory: the row goes and a sentence replaces it', async ({
    page,
  }) => {
    const spy = await installAssistanceNetworkSpy(page);
    const outcome = await driveMissedRecallJourney(page, spy);
    expect(outcome.premiseFailures, outcome.premiseFailures.join('\n')).toEqual([]);
    expect(outcome.reading.recallMissed).toBe(true);

    const card = page.locator(ASSISTANCE_CARD_SELECTOR);
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(ASSISTANCE_PROBES.suggestion)).toHaveCount(1);

    // The dismissed sentence is absent while nothing is dismissed. Asserted rather than assumed,
    // because it is the one piece of copy that would otherwise hint the feature exists, and a card
    // that rendered it empty would be a learner-visible tell.
    await expect(page.locator(ASSISTANCE_DISMISSED_SELECTOR)).toHaveCount(0);

    // The control's own count goes with the row, so a Dismiss that hid nothing is red here.
    await expect(page.locator(ASSISTANCE_DISMISS_SELECTOR)).toHaveCount(1);
    await page.locator(ASSISTANCE_DISMISS_SELECTOR).click();
    await expect(page.locator(ASSISTANCE_PROBES.suggestion)).toHaveCount(0);
    await expect(page.locator(ASSISTANCE_DISMISSED_SELECTOR)).toHaveCount(1);
    await expect(page.locator(ASSISTANCE_DISMISSED_SELECTOR)).toBeVisible();

    // The card itself stays, publishing zero suggestions - which is what makes "showing none" and
    // "not a card" different facts, and is the attribute the card's own header promises.
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-assistance-suggestions', '0');

    // The announcement region now speaks, because a change happened. Read as text and not as an
    // attribute: the sentence is what a screen reader reads, and this is the only place the lane
    // says anything about announcement.
    await expect(page.locator(ASSISTANCE_STATUS_SELECTOR)).not.toHaveText('', { timeout: 10_000 });

    // Nothing left the preview origin, and nothing threw. A dismissal that wrote a record and
    // failed quietly would still satisfy every assertion above.
    expect(
      spy.offOriginPaths(LOCAL_ORIGIN),
      `a dismissal made an off-origin request: ${spy.offOriginPaths(LOCAL_ORIGIN).join(', ')}`,
    ).toEqual([]);
    expect(spy.pageErrors(), `page errors during the dismissal: ${spy.pageErrors().join(' | ')}`).toEqual([]);
  });

  test('no assistance element is rendered before the learner reaches the pond', async ({ page }) => {
    // The silence half, on the flagged artifact.
    //
    // `AssistanceSlot` must render `null` - no element at all - on a workspace the learner has not
    // reached, and a card that appears on Welcome would be a learner-visible tell that the
    // feature exists. So the probe is `ASSISTANCE_ANY_SELECTOR` on the Welcome route, where a
    // suggestion is impossible, and this is what makes the card assertion above mean "the card
    // rendered *because of the journey*" rather than "the card is always there".
    const spy = await installAssistanceNetworkSpy(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    expect(
      await page.locator(ASSISTANCE_ANY_SELECTOR).count(),
      'the Welcome route rendered an assistance element, so the card is not gated by the surface ' +
        'that mounted it',
    ).toBe(0);
    expect(
      spy.scriptPathsMatching(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH),
      'the Welcome route fetched the assistance card chunk, so a card a learner cannot see is ' +
        'being downloaded on every launch',
    ).toEqual([]);

    /*
     * The store chunk, asserted **present**.
     *
     * A lane that only asserted the card chunk's absence would pass on a page that loaded nothing
     * at all, and a reader checking the pair would find no evidence the page really ran. The store
     * chunk is fetched by every build at bootstrap - `runBootstrap` awaits
     * `loadAssistanceStore()`, and the hydration is unconditional on purpose so a learner who set
     * `off` on the flagged build keeps that mode on the rollback build - so its presence here is
     * the positive control that the observation below was made on a live application.
     *
     * Measured, not assumed: it is exactly what the flagged Welcome route requests of the lane.
     */
    expect(
      spy.scriptPathsMatching(ASSISTANCE_STORE_CHUNK_REQUEST_MATCH),
      'the Welcome route did not fetch the assistance store chunk, so this run made no observation ' +
        'of a live application bootstrap and the absence above is unmeasured',
    ).not.toEqual([]);
    expect(spy.pageErrors(), `page errors on Welcome: ${spy.pageErrors().join(' | ')}`).toEqual([]);
  });
});