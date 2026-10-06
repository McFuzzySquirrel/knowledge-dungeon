import { expect, test } from '@playwright/test';

import {
  ASSISTANCE_ANY_SELECTOR,
  ASSISTANCE_DEFAULT_LANE,
  ASSISTANCE_CARD_CHUNK_REQUEST_MATCH,
  ASSISTANCE_PROBES,
} from './assistance-lane';
import {
  driveMissedRecallJourney,
  installAssistanceNetworkSpy,
  localOriginFor,
} from './assistance-journey';

/**
 * The Phase 21 assistance **rollback** lane, against the default production artifact.
 *
 * ## Why this lane exists, and what makes it more than the absence of a positive
 *
 * The Phase 19 production default is `VITE_ADAPTIVE_ASSISTANCE=false`, and "the feature is
 * switched off" is a claim a reader will otherwise take on trust from a flag table. The flagged
 * lane proves the card renders; on its own that would also pass for a card that is *always* on
 * screen, gated by nothing. This lane is the other half, and it is a half rather than a footnote
 * for one reason: **it drives the identical journey.**
 *
 * Same seeded subject, same walk to the pond, same cast, same hook, same recall question answered
 * wrong for the room it came from. Every one of those steps is asserted here too. So when this lane
 * says no assistance element exists, the statement is not "the page was empty" - it is "the page
 * reached exactly the DOM state that mounts the card, and the card was not there". That is what a
 * gate is, and the flagged lane's silence assertion on the Welcome route is the third leg.
 *
 * ## What "the same probe" means here, precisely
 *
 * The same selectors. `ASSISTANCE_PROBES.card`, `.suggestion`, `.reasonText` and `.dismiss` are
 * read here and each is required to be absent, and `ASSISTANCE_ANY_SELECTOR` is read and required
 * to match nothing at all. The probe is not loosened between the lanes; the expectation is.
 *
 * The second, independent witness is the network. On this artifact the lazy lane chunks exist -
 * measured at this phase, both builds emit them - so their *absence from `dist/assets`* would prove
 * nothing. Their **absence from the request log** after a journey that reached the mounting state
 * does: it says the browser was never given a reason to fetch them, which is what a gate at the
 * flag is.
 *
 * ## No skip
 *
 * Neither lane skips anything. A lane that passes by not measuring is the failure this repository
 * forbids, and this file's whole purpose is the opposite of it.
 *
 * ## Privacy
 *
 * Synthetic fixtures only, and the same spy shape as the flagged lane: origin and path recorded,
 * body and headers never captured, everything non-loopback aborted before it leaves.
 */

const LOCAL_ORIGIN = localOriginFor(ASSISTANCE_DEFAULT_LANE.previewPort);

test.describe('the default artifact shows no assistance, and the lane is what proves it', () => {
  test('the same journey mounts no assistance card, a suggestion, a reason or a dismiss control', async ({
    page,
  }) => {
    const spy = await installAssistanceNetworkSpy(page);
    const outcome = await driveMissedRecallJourney(page, spy);

    /*
     * The premise, asserted first and with the measurements attached.
     *
     * This is the whole reason the lane exists and it is easy to get wrong: without these
     * assertions a green run only proves the walk did not arrive. Every one of them is the flagged
     * lane's assertion too, so the two lanes share a standard of proof.
     */
    expect(outcome.premiseFailures, outcome.premiseFailures.join('\n')).toEqual([]);
    expect(outcome.reading.enteredFishing, 'the walk to the fishing pond did not open a session').toBe(
      true,
    );
    expect(
      outcome.reading.caughtFishLabel,
      `no fish was revealed after ${outcome.reading.pressCount} press(es) on the pond, so the catch ` +
        'panel - and therefore the recall question - was never reached',
    ).not.toBeNull();
    expect(
      outcome.reading.recallQuestionOffered,
      'the recall dialog offered no answer, so the missed-recall state the card is mounted on never happened',
    ).toBe(true);
    expect(outcome.reading.recallMissed).toBe(true);

    // The card is mounted from a React commit, and the store write behind it lands a microtask
    // later, so absence is sampled over a window rather than at one instant. The window is short
    // and the assertion is repeated on purpose: a single sample could catch the lane before the
    // card's own chunk finished loading, and a card that appears 200 ms late would be reported as
    // one that never appeared.
    await page.waitForTimeout(1_500);

    for (const [name, selector] of Object.entries(ASSISTANCE_PROBES)) {
      expect(
        await page.locator(selector).count(),
        `the default artifact rendered ${name} (${selector}), so either the feature is not gated or ` +
          'the flagged and default lanes are pointed at the same artifact',
      ).toBe(0);
    }
    expect(await page.locator(ASSISTANCE_ANY_SELECTOR).count()).toBe(0);
  });

  test('the lazy lane chunk is never requested, although the journey reached the mounting state', async ({
    page,
  }) => {
    // The second, independent witness, and the one that survives a reviewer's objection that the
    // DOM assertion could be satisfied by a page that simply failed to render anything.
    //
    // On this artifact the lane chunks *are* emitted - measured at this phase, the default build
    // ships `assets/AssistanceRegion-*.js` and `assets/assistanceStore-*.js` exactly as the flagged
    // one does, and `vite.config.ts` reports 2/2 declared lane paths fetchable for both. What
    // differs is that nothing asks the browser for them. So the assertion is about the request
    // log, and it holds only because the journey above really did reach the state that would have
    // mounted the card.
    const spy = await installAssistanceNetworkSpy(page);
    const outcome = await driveMissedRecallJourney(page, spy);
    expect(outcome.premiseFailures, outcome.premiseFailures.join('\n')).toEqual([]);
    expect(outcome.reading.recallMissed).toBe(true);

    expect(
      spy.scriptPathsMatching(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH),
      'the default artifact fetched the assistance lane after the journey reached the state that mounts it',
    ).toEqual([]);
    // And the page really did load scripts, so "no lane request" is not "no requests".
    expect(spy.observations().filter(({ resourceType }) => resourceType === 'script').length).toBeGreaterThan(
      0,
    );
    expect(spy.pageErrors(), `page errors during the journey: ${spy.pageErrors().join(' | ')}`).toEqual([]);
    expect(
      spy.offOriginPaths(LOCAL_ORIGIN),
      `requests left the preview origin: ${spy.offOriginPaths(LOCAL_ORIGIN).join(', ')}`,
    ).toEqual([]);
  });

  test('the artifact really is the production default, and not the flagged build', async ({ page }) => {
    // Read from the served page rather than from the environment, for the reason the fishing lane
    // reads its chunk census from `dist/` rather than from a flag constant: the flag is the thing
    // under test, so reading it back would make the lane assert the flag rather than the product.
    //
    // What the page can observe is the same fact the preflight observes in the emitted bytes, from
    // the other side: the lazy lane chunks are present in the served `dist/assets`, and none of
    // them was requested. Their presence is what makes the absence above meaningful.
    const spy = await installAssistanceNetworkSpy(page);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    expect(ASSISTANCE_DEFAULT_LANE.expectsFlagOn, 'this lane runs against the production default').toBe(
      false,
    );
    expect(await page.locator(ASSISTANCE_ANY_SELECTOR).count()).toBe(0);
    expect(spy.scriptPathsMatching(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH)).toEqual([]);
    expect(spy.offOriginPaths(LOCAL_ORIGIN)).toEqual([]);
  });
});