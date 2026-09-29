/**
 * The browser-level gate for the canvas pointer route: a real click on the real
 * bell, and the real DOM mirror's real text afterwards.
 *
 * ## Why this file exists, and why it is in `tests/phase9/browser/`
 *
 * A canvas pointer press changes the world and the DOM mirror is the only place a
 * screen-reader user can learn that it did. The shipped Phase 9 build got this
 * wrong: the bell's `pointertap` handler called the scene's own `activate`, so the
 * world changed and the host - the only thing that calls `publishState()` - never
 * heard about it. Two real taps on the bell left the mirror reading `Bell quiet`,
 * and the next DOM-mirror click jumped to `Bell rung 3 times`.
 *
 * Three existing gates missed it, and this file is written so that none of them is
 * the reason it could:
 *
 * - `tests/phase9/test-world-scene.test.ts` (jsdom) emitted `pointertap` on the
 *   scene's own emitter. That calls the listener directly, never enters PixiJS's
 *   event system, and never reaches the host.
 * - `tests/phase9/pixi-composition-root.test.tsx` (jsdom) asserted
 *   `bell.listenerCount('pointertap') === 1` - and, before this fix, that was the
 *   whole of its pointer coverage. A listener that never fires satisfies a listener
 *   count.
 * - `tests/e2e/pixiMemory.spec.ts` (browser) exercised the keyboard and the DOM
 *   control and never clicked the canvas.
 *
 * This is the one that clicks the canvas, in a real engine, and reads the mirror.
 *
 * ## Where it has to be wired
 *
 * It is a Playwright spec, and Playwright's config for this repository is outside
 * `src/renderers/**` and outside this agent's ownership, so it is **not yet run by
 * any npm script**. The orchestrator owns two things needed to run it:
 *
 * 1. a `playwright.pixi-pointer.config.ts` beside the existing `playwright.*.config.ts`
 *    files, and
 * 2. a `package.json` script (and a CI step) that runs
 *    `playwright test --config=playwright.pixi-pointer.config.ts` after
 *    `npm run build:web:pixi` and `npm run record:web-artifact:pixi`.
 *
 * The exact configuration this file needs is in its own docstring below. Until it is
 * wired, the jsdom gate in `tests/phase9/pixi-composition-root.test.tsx` and the
 * structural gate in `tests/phase9/pixi-dispatch-ownership.test.ts` are what run on
 * every commit; this file is the third altitude, and it was executed by hand against
 * a `VITE_WORLD_RENDERER=pixi` build to produce the before/after numbers in the phase
 * report.
 *
 * ## Aiming at the bell
 *
 * The bell's position is computed from the surface's own box and the same Cozy
 * tokens the scene lays out from, imported here rather than hard-coded, so a token
 * change moves the test with the world instead of leaving it clicking empty surface.
 * The assertion that this is the bell and not a lucky pixel is the first one: a
 * single press must change the mirror, and a press that missed would not.
 *
 * ## Privacy
 *
 * No learner data, no storage, no subject, note, attachment, statistic, or
 * preference is read. The world is a test world with two counters on it, and the
 * only values this spec reads are the strings the test world itself renders.
 */
import { expect, test, type Page } from '@playwright/test';

import { COZY_SPACE_PX, COZY_TOUCH_TARGET_MIN } from '../../../src/theme';

/** The headings and controls the Phase 9 world screen names. */
const WORLD_HEADING = 'PixiJS runtime host';
const START_TUTORIAL = 'Start Tutorial';
const RING_CONTROL = 'Ring the bell (key B)';
const READY_SENTENCE = 'World presented';
const SURFACE_SELECTOR = '[data-pixi-surface]';

/** The bell's mirror status element, and the status sentence the screen reports. */
const bellStatus = (page: Page) => page.locator('#pixi-test-world-ring-bell-status');
const readySentence = (page: Page) => page.locator('.pixi-world-host [aria-live]').first();

/**
 * The bell's centre, in page coordinates.
 *
 * The scene lays two touch targets out in one row with a gap of `space.6` between
 * them, the second one centred in its lane. Reproducing that arithmetic from the
 * tokens rather than hard-coding pixels is what keeps this test honest when a token
 * changes: the number moves with the world.
 */
async function bellCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(SURFACE_SELECTOR).boundingBox();
  expect(box, 'The world surface has no box, so no point on it can be aimed at.').not.toBeNull();
  const width = box?.width ?? 0;
  const height = box?.height ?? 0;
  const gap = COZY_SPACE_PX['6'];
  const laneWidth = Math.max(COZY_TOUCH_TARGET_MIN, Math.floor((width - gap * 3) / 2));
  const laneHeight = Math.max(COZY_TOUCH_TARGET_MIN, Math.min(160, height - gap * 4));
  const top = Math.max(gap, Math.floor((height - laneHeight) / 2));
  return {
    x: Math.round((box?.x ?? 0) + gap * 2 + laneWidth + laneWidth / 2),
    y: Math.round((box?.y ?? 0) + top + laneHeight / 2),
  };
}

/** Welcome -> the Phase 9 world screen, presented and settled. */
async function openWorld(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await page.getByRole('button', { name: START_TUTORIAL }).click();
  await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({
    timeout: 30_000,
  });
  await readySentence(page).filter({ hasText: READY_SENTENCE }).waitFor({ timeout: 30_000 });
}

test.describe('a real click on the canvas reaches the DOM mirror', () => {
  test('two clicks on the bell change the announced status, and the count is one the learner saw', async ({
    page,
  }) => {
    await openWorld(page);
    const point = await bellCentre(page);

    // At rest, and after a frame has been presented - a press before the first frame
    // arrives at the right coordinates and hits nothing, because a scene that has
    // never been rendered has not finished propagating its own layout.
    await expect(bellStatus(page)).toHaveText('Bell quiet');

    await page.mouse.click(point.x, point.y);
    await expect(bellStatus(page), 'the first canvas click did not reach the mirror').toHaveText(
      'Bell rung 1 time',
    );

    await page.mouse.click(point.x, point.y);
    await expect(bellStatus(page), 'the second canvas click did not reach the mirror').toHaveText(
      'Bell rung 2 times',
    );

    // The counter does not jump. The shipped defect was a mirror that read
    // `Bell quiet` through two taps and then `Bell rung 3 times` on the next control
    // click: a number the learner never watched reach one. Two clicks, then one
    // control click, is three.
    await page.getByRole('button', { name: RING_CONTROL }).click();
    await expect(bellStatus(page)).toHaveText('Bell rung 3 times');
  });

  test('the three input routes produce one sequence of announced states', async ({ page }) => {
    await openWorld(page);
    const point = await bellCentre(page);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('b');
    await expect(bellStatus(page)).toHaveText('Bell rung 1 time');

    await page.mouse.click(point.x, point.y);
    await expect(bellStatus(page)).toHaveText('Bell rung 2 times');

    await page.getByRole('button', { name: RING_CONTROL }).click();
    await expect(bellStatus(page)).toHaveText('Bell rung 3 times');
  });

  test('a click on empty surface changes nothing, and the mirror stays quiet', async ({ page }) => {
    await openWorld(page);
    const box = await page.locator(SURFACE_SELECTOR).boundingBox();

    await page.mouse.click(Math.round((box?.x ?? 0) + 2), Math.round((box?.y ?? 0) + 2));
    // The screen's own readiness sentence is the control: it must not have changed,
    // and the bell's status must still be the one from before the click.
    await expect(bellStatus(page)).toHaveText('Bell quiet');
    await expect(readySentence(page)).toContainText(READY_SENTENCE);
  });
});
