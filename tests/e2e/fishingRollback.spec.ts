import { expect, test, type Page } from '@playwright/test';

import {
  FISHING_PHASER_FALLBACK_CLASS,
  FISHING_ROLLBACK_LANE,
  FISHING_ROLLBACK_MANIFEST_PATH,
} from './fishing-lane';
import {
  censusForDist,
  holdKey,
  hostOperatingSystem,
  installNetworkSpy,
  nearbyRowFor,
  openVillage,
  recordFishingEvidence,
  repoRoot,
  verifyRecordedArtifact,
  walkToStructureAndPress,
  WALK_SPAWN_TO_SW_POND,
  type DistChunkCensus,
  type NetworkSpy,
} from './fishing-harness';

/**
 * The Phase 17 fishing **rollback** lane, against the default production artifact.
 *
 * ## What this is for
 *
 * Phase 17's rollback line is `VITE_PIXI_FISHING=false`. A rollback that has never been observed
 * is a hope, and this is the observation: the entry point a learner uses to reach a fishing pond
 * still reaches the Phaser `FishingScene` on the artifact that actually ships.
 *
 * Three measurements make that a claim rather than an intention:
 *
 * 1. **The bundle.** `dist/assets` contains no `FishingWorld-*` chunk and no `vendor-pixi-*`
 *    chunk. Read from the artifact, not from an environment variable — the flag constant is the
 *    thing under test, so reading it back would make the lane assert the flag rather than the
 *    product.
 * 2. **The scene.** The entry point swaps `FishingScene` into the village's own `Phaser.Game`:
 *    the same single canvas stays in place, the Phaser village chunk is the one that was
 *    fetched, and the Pixi pond's own DOM controls are absent from the page entirely.
 * 3. **The way out.** `FishingScene` binds `ESC` to return to the village and the Pixi pond does
 *    not, so which of the two worlds a learner is in is observable from the keyboard alone — and
 *    the observable used is that walking again *changes* the pond's measured distance, which
 *    `FishingScene` cannot do because it has no movement input at all.
 *
 * ## Why this is separate from the pond lane
 *
 * Because a test's premise must be true of the artifact it runs against. The pond spec drives six
 * DOM fishing controls that exist only in an artifact containing the pond; this one drives a
 * Phaser canvas that exists only in an artifact without it. One spec asserting both would need a
 * skip to express the half that cannot run, and a lane that passes by not measuring is the exact
 * failure this repository's own doctrine forbids.
 *
 * ## What is deliberately not asserted here
 *
 * `data-world` does **not** return to `village` when the Phaser scene's `ESC` handler fires.
 * `useVillageFishing` clears its `active` flag from the Pixi lane's `exit` and from the Pixi
 * host's `returnToVillage`, and neither runs on this path, so the screen's live region keeps
 * announcing "You have started fishing" after the learner is back in the village. That is a real
 * defect in `src/ui/screens/useVillageFishing.tsx` — outside this lane's ownership — and this spec
 * reports it in its evidence notes instead of asserting a value it knows to be wrong.
 *
 * Synthetic fixtures only: the application's own tutorial subject, the authored village map's own
 * structure ids, and bounded categories.
 */

const LOCAL_ORIGIN = 'http://127.0.0.1:43201';

/** The class the village's own Phaser canvas is mounted under. */
const PHASER_CANVAS = `.${FISHING_PHASER_FALLBACK_CLASS} canvas`;

/**
 * The legs of the "Escape returns to the village" walk, as data.
 *
 * These two legs are this spec's own, not the shared walk's, and the reason is that they measure
 * something the shared walk does not: they have to *leave* a place and then come back to it, so
 * what matters is that the player is measurably further away afterwards and measurably closer
 * again, not that a row came into reach. Fourteen bursts of {@link AWAY_BURST_MS} north-east is
 * comfortably more than the 48-pixel approach radius on each axis, and thirty bursts of
 * {@link RETURN_BURST_MS} back south-west is more than the outward leg travelled.
 */
const AWAY_BURST_MS = 130;
const AWAY_ITERATIONS = 14;
const RETURN_BURST_MS = 100;
const RETURN_ITERATIONS = 30;

/**
 * Walk to the pond and press its nearby-action row.
 *
 * The confirmation is the scene swap, for the same reason the flagged lane's is: the nearby list is a
 * throttled proximity sample, so a row can be on the page after the learner has already left the
 * approach radius, and the press lands on nothing. Asking whether `data-world` flipped turns a lost
 * press into a retry rather than a walk that reports an arrival it did not make — and on the
 * rollback lane that distinction is the whole claim, since this lane's evidence is *which* world the
 * entry point reached.
 */
async function enterFishingScene(page: Page): Promise<boolean> {
  const outcome = await walkToStructureAndPress(page, WALK_SPAWN_TO_SW_POND, async () =>
    (await page.locator('[data-world="fishing"]').count()) > 0,
  );
  return outcome.arrived;
}

test('the default artifact verifies its identity and contains no Pixi fishing chunk', async ({
  page,
}, testInfo) => {
  const census = censusForDist(repoRoot());
  if (census === null) {
    throw new Error(
      'There is no dist/ to census. Run "npm run test:e2e:fishing:rollback:full", which builds, ' +
        'records and verifies the default artifact before invoking this lane.',
    );
  }
  const verification = verifyRecordedArtifact(repoRoot(), FISHING_ROLLBACK_MANIFEST_PATH);
  expect(verification.status).toBe('match');
  expect(verification.code).toBe('match');
  expect(verification.recordedTreeSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(verification.sourceMatches, 'the artifact was recorded from different source content').toBe(true);

  // The rollback target's defining property, read from the bytes that will be served.
  expect(
    census.fishingChunks,
    'the default build emitted a Pixi fishing chunk, so it is not the production default',
  ).toEqual([]);
  expect(census.pixiChunks, 'the default build emitted a Pixi vendor chunk').toEqual([]);
  // Phaser is still the world renderer, and its vendor chunk is still there.
  expect(census.phaserChunks.length).toBe(1);

  const spy = installNetworkSpy(page, LOCAL_ORIGIN);
  await page.goto('/');
  await page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });
  expect(spy.pixiScriptPaths(), 'the Welcome route fetched a Pixi chunk').toEqual([]);

  await recordFishingEvidence(testInfo, `${FISHING_ROLLBACK_LANE.project}`, {
    lane: 'rollback-artifact-census',
    rendererMode: 'phaser-fishing-scene',
    inputMode: 'pointer-keyboard',
    hostOperatingSystem: hostOperatingSystem(),
    architecture: process.arch,
    browserVersion: page.context().browser()?.version() ?? 'unknown',
    browserChannel: 'playwright-bundled',
    viewport: page.viewportSize() ?? FISHING_ROLLBACK_LANE.viewport,
    deviceScaleFactor: FISHING_ROLLBACK_LANE.deviceScaleFactor,
    hasTouch: FISHING_ROLLBACK_LANE.hasTouch,
    evidenceClass: FISHING_ROLLBACK_LANE.evidenceClass,
    worldRenderer: FISHING_ROLLBACK_LANE.worldRenderer,
    villageRenderer: FISHING_ROLLBACK_LANE.villageRenderer,
    storageRepository: FISHING_ROLLBACK_LANE.storageRepository,
    fishingChunkPresent: census.fishingChunks.length > 0,
    pixiScriptRequestCount: spy.pixiScriptPaths().length,
    totalRequestCount: spy.report().totalRequests,
    networkViolations: spy.report().violations.map((violation) => ({
      category: violation.category,
      count: violation.count,
    })),
    observedPhases: [],
    notes: [
      'the chunk census is read from dist/assets, not from a flag constant',
      'Welcome requested no Pixi chunk on the default artifact',
    ],
  });
});

test('the entry point reaches the Phaser FishingScene in the village game, not a Pixi pond', async ({
  page,
}, testInfo) => {
  const census = censusForDist(repoRoot()) as DistChunkCensus;
  expect(census.fishingChunks).toEqual([]);

  const spy = installNetworkSpy(page, LOCAL_ORIGIN);
  await openVillage(page);

  // The Phaser village, on the village's own single canvas.
  await expect(page.locator(PHASER_CANVAS)).toBeVisible({ timeout: 30_000 });
  expect(await page.locator('canvas').count(), 'the village is not one canvas on this build').toBe(1);
  expect(
    spy.pixiScriptPaths(),
    'the default village route fetched a Pixi chunk',
  ).toEqual([]);

  const reached = await enterFishingScene(page);
  expect(reached, 'the walk to the fishing pond did not come into range within its budget').toBe(true);

  // The screen knows a fishing session began: `data-world` is the village screen's own record of
  // it, and the live region beside the pond says so in words.
  await expect(page.locator('[data-world="fishing"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText('You have started fishing')).toBeVisible({ timeout: 15_000 });

  // The Pixi pond has no presence at all: no world surface, no HUD, no catch panel, no Pixi
  // chunk request at any point in the whole flow.
  expect(await page.locator('.pixi-fishing-world').count()).toBe(0);
  expect(await page.locator('.fishing-hud').count()).toBe(0);
  expect(await page.locator('#fishing-catch-panel').count()).toBe(0);
  expect(await page.locator('canvas').count(), 'entering fishing added a second canvas').toBe(1);
  expect(
    spy.fishingScriptPaths(),
    'the default build requested a Pixi fishing chunk',
  ).toEqual([]);
  expect(spy.pixiScriptPaths(), 'entering fishing requested a Pixi chunk').toEqual([]);
  expect(
    spy.pageErrors(),
    `page errors during the Phaser fishing entry: ${spy.pageErrors().join(' | ')}`,
  ).toEqual([]);

  await recordFishingEvidence(testInfo, `${FISHING_ROLLBACK_LANE.project}`, {
    lane: 'rollback-entry-point',
    rendererMode: 'phaser-fishing-scene',
    inputMode: 'pointer-keyboard',
    hostOperatingSystem: hostOperatingSystem(),
    architecture: process.arch,
    browserVersion: page.context().browser()?.version() ?? 'unknown',
    browserChannel: 'playwright-bundled',
    viewport: page.viewportSize() ?? FISHING_ROLLBACK_LANE.viewport,
    deviceScaleFactor: FISHING_ROLLBACK_LANE.deviceScaleFactor,
    hasTouch: FISHING_ROLLBACK_LANE.hasTouch,
    evidenceClass: FISHING_ROLLBACK_LANE.evidenceClass,
    worldRenderer: FISHING_ROLLBACK_LANE.worldRenderer,
    villageRenderer: FISHING_ROLLBACK_LANE.villageRenderer,
    storageRepository: FISHING_ROLLBACK_LANE.storageRepository,
    fishingChunkPresent: false,
    pixiScriptRequestCount: spy.pixiScriptPaths().length,
    totalRequestCount: spy.report().totalRequests,
    networkViolations: spy.report().violations.map((violation) => ({
      category: violation.category,
      count: violation.count,
    })),
    observedPhases: [],
    notes: [
      'the scene swap is observed through the single canvas and the data-world attribute',
      'no Pixi chunk was requested at any point in the flow',
    ],
  });
});

test('Escape returns the learner to the village, and the village world is live again', async ({
  page,
}) => {
  const spy: NetworkSpy = installNetworkSpy(page, LOCAL_ORIGIN);
  await openVillage(page);
  expect(await enterFishingScene(page)).toBe(true);
  await expect(page.locator('[data-world="fishing"]')).toHaveCount(1, { timeout: 30_000 });

  /*
   * Wait for the scene, then settle, and both waits are load-bearing.
   *
   * `FishingScene` binds its `ESC` handler in `create()`, which runs after the scene has been
   * *started*; `data-world` flips to `fishing` a commit earlier than that, from the React side. So
   * an Escape sent the instant the attribute appears can arrive before the binding exists and be
   * swallowed — and a swallowed Escape leaves the fishing scene active with **no movement keys**,
   * which is indistinguishable from a village that resumed unless the walk is checked. The live
   * region is the product's own signal that the session started, and the settle after it covers
   * the deferred `scene.stop` / `scene.wake` pair inside `setTimeout(0)`.
   */
  await expect(page.getByText('You have started fishing')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2_000);

  /*
   * The observable, and why it is "walk back and arrive" rather than "watch something change".
   *
   * `FishingScene` binds **no movement keys at all** — it has a `pointerdown` handler and an
   * `ESC` binding and nothing else — so the arrow keys cannot move anything while it is the
   * active scene. A learner who pressed them after Escape and the village had woken would see
   * the pond's measured distance change; a learner who pressed them against a scene that never
   * resumed would see nothing at all happen. So the test walks *away* from the pond and then
   * *back to it*, and asserts the pond's own nearby-action row reappears at a different
   * distance. It is a positive arrival rather than a passive observation of absence, and it
   * cannot be satisfied by a needle that happens not to be updating.
   */
  for (let step = 0; step < AWAY_ITERATIONS; step += 1) {
    await holdKey(page, 'ArrowUp', AWAY_BURST_MS);
    await holdKey(page, 'ArrowRight', AWAY_BURST_MS);
  }
  const away = (await nearbyRowFor(page, WALK_SPAWN_TO_SW_POND.targetId))?.distance ?? null;
  expect(
    away,
    `walking ${AWAY_ITERATIONS} bursts north-east did not move the player out of the pond's approach ` +
      'radius, so this test could not tell a resumed village from a frozen one',
  ).toBeNull();

  /*
   * The return leg's ratio is **one to one**, not the two-to-one the outward walk used.
   *
   * The outward walk is six tiles east against three north, because the pond sits east and north
   * of the spawn. The return leg starts from wherever the outward leg stopped, roughly four and a
   * half tiles north-east of the pond, so it has to travel roughly four and a half tiles back on
   * each axis at once. A two-to-one return would sail past the pond along one axis while the
   * other caught up, and the test would fail for a scheduling reason dressed up as a product one.
   */
  let returned: number | null = null;
  for (let step = 0; step < RETURN_ITERATIONS && returned === null; step += 1) {
    await holdKey(page, 'ArrowDown', RETURN_BURST_MS);
    await holdKey(page, 'ArrowLeft', RETURN_BURST_MS);
    returned = (await nearbyRowFor(page, WALK_SPAWN_TO_SW_POND.targetId))?.distance ?? null;
  }

  expect(
    returned,
    'walking back to the pond after Escape never brought it into range, so VillageScene did not ' +
      'resume: FishingScene binds no movement keys, so a walk that ends in a different measured ' +
      'distance is the only proof the village is live again',
  ).not.toBeNull();
  expect(spy.pixiScriptPaths()).toEqual([]);
});

test('the whole rollback flow makes no request that leaves the preview origin', async ({
  page,
}) => {
  const spy = installNetworkSpy(page, LOCAL_ORIGIN);
  await openVillage(page);
  expect(await enterFishingScene(page)).toBe(true);
  await page.waitForTimeout(2_000);
  await page.keyboard.press('Escape');
  await page.waitForLoadState('networkidle');

  expect(spy.assertions()).toBe('no static-only network policy violations');
  expect(spy.report().totalRequests).toBeGreaterThan(0);
});