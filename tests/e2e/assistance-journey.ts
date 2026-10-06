/**
 * The journey both Phase 21 assistance lanes drive, and the one thing that makes the two lanes
 * evidence about a gate rather than about two builds.
 *
 * ## Why this is a module and not a block in each spec
 *
 * Because the two lanes are only a pair if they drove the *same* journey. "A card is absent on the
 * default artifact" is evidence about the flag only when the walk that mounts the card actually
 * reached its precondition - otherwise the lane passes on a subject that never opened the pond.
 * Duplicating the journey into both specs would give the two copies two chances to drift, which
 * is the class of defect the shared `auditFeatureLane` in `vite.config.ts` exists to prevent, and
 * a drifted copy fails *green* rather than red.
 *
 * ## Why the journey is a whole cast-to-missed-recall and not "open a panel"
 *
 * Measured, and this is the central finding about Phase 19's browser coverage rather than a
 * preference. `AssistanceSlot` is mounted from five places and **four of them are behind their own
 * `productionDefault: false` workspace flags**:
 *
 * | surface | host | reachable on `VITE_ADAPTIVE_ASSISTANCE=true` alone? |
 * | --- | --- | --- |
 * | `creator` | `CreatorWorkspace` | no - `VITE_CREATOR_WORKSPACE` defaults false |
 * | `scribe` | `ScribeEncounterDialog` | no - `VITE_SCRIBE_ENCOUNTER_WORKSPACE` defaults false |
 * | `archaeologist` | `ArchaeologistWorkspace` | no - `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` defaults false |
 * | `device` | `ArchaeologistWorkspace` | no - same flag |
 * | `fishing` | `VillageScreen` | **yes**, and only after a recall question is missed |
 *
 * `build:web:assistance` turns on exactly one flag, and
 * `tests/e2e/assistance-build-lane.test.ts` pins that script for a real reason, so this lane
 * cannot widen it. The fishing slot is therefore the only surface a lane on this artifact can
 * reach, and `useVillageFishing` mounts it only once `missedRecall` is set - which happens in
 * exactly one place: `onDecide(choice, roomId)` with a non-null `roomId`, i.e. the learner
 * answered a recall question *wrong* for the room it came from.
 *
 * So the journey is: seed a synthetic subject with one cleared room, walk to the pond, cast, hook
 * a bite, keep the fish, and answer the recall question with "I got that wrong". Every step is a
 * real product control except the cast and the hook, which are pointer events on a canvas -
 * because on this artifact the pond is the Phaser `FishingScene`, whose only inputs are
 * `pointerdown` and `ESC`.
 *
 * ## Why the cast and the hook are driven by polling rather than by a scheduled event
 *
 * `FishingScene` publishes its state to a Phaser `Text` object on the canvas. Nothing about it
 * reaches the DOM, so there is no observable to wait on: the bite window is two seconds of
 * `biteWindowActive` and a learner sees it by watching the canvas. A lane cannot watch the canvas
 * without reading pixels, so the honest alternative is what a learner does - keep pressing - and
 * then wait for the DOM consequence, which is real: `onFishCaught` publishes the catch panel.
 *
 * Pressing is therefore safe to repeat by construction, and that is worth stating because it is
 * what makes the loop legitimate rather than a race: `handlePointerDown` acts only in `idle`
 * (start charging), `biting` **with an active window** (hook), and `caught`/`missed` (reset).
 * In `waiting` and in `biting` with an expired window it does nothing at all. So a press can
 * cast, can hook, can reset, or can be ignored - never misfire - and a loop that presses until
 * the catch panel appears converges on a catch within one bite window of sampling.
 *
 * ## The geometry, and why the assumption is asserted rather than trusted
 *
 * `createPhaserVillageRenderer` creates the game with `Phaser.Scale.RESIZE` and `100%` width and
 * height, so the game coordinate space is the canvas's own CSS box and a fractional click point
 * is a game-space point. `FishingScene.handlePointerDown` ignores a press in the top-left
 * 180x36 return-button box and anything below `shoreY - 20`, where `shoreY = floor(h * 0.80)`.
 * A press at 50% across and 45% down clears both for any canvas taller than 57 CSS pixels.
 *
 * {@link WATER_PRESS_FRACTION} is asserted against the measured box rather than assumed: if the
 * box is smaller than {@link MINIMUM_ASSUMED_CANVAS_PX}, the geometry no longer holds and the
 * lane fails with the measurement instead of pressing into the shore and reporting a mystery.
 *
 * ## Privacy
 *
 * The fixture is `tests/e2e/fishing-recall-fixture.ts`'s, three `localStorage` writes of two
 * invented ids and an invented display name. Every value this module reads back is a count, a
 * boolean, a closed vocabulary string, or a repository-relative path. No learner data, no request
 * body, no credential, no URL other than the loopback preview origin.
 */

import { expect, type Page, type Request } from '@playwright/test';

import { ASSISTANCE_PROBES } from './assistance-lane';
import { FISHING_PHASER_FALLBACK_CLASS } from './fishing-lane';
import {
  WALK_NEAR_APPROACH_TILES,
  WALK_SPAWN_TO_SW_POND,
  approachKey,
  burstMsFor,
  gridDistanceTiles,
  holdKey,
  waitForPlayerGrid,
  type VillageGridPoint,
  type WalkArrowKey,
} from './fishing-harness';
import {
  installRecallFixture,
  readSeededSubjectState,
  recallFixturePremiseFailures,
} from './fishing-recall-fixture';
import {
  ASSISTANCE_COUNT_ATTRIBUTES,
  ASSISTANCE_INTENSITY_ATTRIBUTE,
  ASSISTANCE_KIND_ATTRIBUTE,
  ASSISTANCE_REASON_ATTRIBUTE,
} from '../../src/ui/assistance/assistanceTestIds';

/** The suggestion row's own title element, a class the lane reads but never needs to own. */
const ASSISTANCE_TITLE_CLASS = '.assistance-suggestion__title';

/**
 * Where the cast and the hook press, as a fraction of the canvas box.
 *
 * `0.45` down rather than `0.5`: the water band is `horizonY = 0.10h` to `shoreY - 20 = 0.80h - 20`,
 * and sitting nearer the middle of the band is further from both edges than sitting at its centre
 * once the horizon margin is subtracted. Documented rather than tuned: the band is wide and the
 * press has to stay inside it on a canvas this module refuses to accept if it is small.
 */
export const WATER_PRESS_FRACTION: Readonly<{ x: number; y: number }> = Object.freeze({
  x: 0.5,
  y: 0.45,
});

/**
 * The smallest canvas the geometry above is valid for, in CSS pixels.
 *
 * Derived, not chosen: `0.45h < 0.80h - 20` holds exactly when `h > 57.14`, and the width has to
 * clear the 180-pixel return-button box at `x = 0.5w`. Rounded well past both so a canvas that
 * merely scrapes past the algebra still fails loudly rather than pressing into the shore.
 */
export const MINIMUM_ASSUMED_CANVAS_PX = 400;

/**
 * How long one press is held, in milliseconds.
 *
 * Long enough for the charge meter to build a little power, so the bobber lands in open water
 * rather than hard against the shore. `FishingScene` clamps to `max(0.12, power)` so a very short
 * press is not a failure, but a charged cast is what a learner does and it is what the lane
 * should reproduce.
 */
export const CHARGE_HOLD_MS = 140;

/** Wall-clock budget for the whole cast-to-catch loop, across every retry. */
export const CATCH_LOOP_BUDGET_MS = 150_000;

/** The catch panel and the recall control, as the product's own `data-fishing-touch-target` ids. */
export const KEEP_FISH_SELECTOR = '[data-fishing-touch-target="keep-fish"]';
export const RECALL_INCORRECT_SELECTOR = '[data-fishing-touch-target="recall-incorrect"]';

/** The village screen's own record that a fishing session began. */
export const FISHING_WORLD_SELECTOR = '[data-world="fishing"]';
/** The screen's own live region, which says the same thing in words. */
export const FISHING_LIVE_REGION_TEXT = 'You have started fishing';

/** The catch panel the Phaser scene's `onFishCaught` publishes. */
export const CATCH_PANEL_SELECTOR = '.fishing-catch-panel';

/** The recall dialog, and the branch that says there was no question to ask. */
export const RECALL_DIALOG_SELECTOR = '.fishing-recall__dialog';
export const RECALL_NO_QUESTION_SELECTOR = '[data-fishing-touch-target="keep-without-recall"]';

/**
 * The pond's own panel, and the one control on it that mints a fishing session.
 *
 * ## Why the lane walks to the panel rather than pressing the nearby row
 *
 * This is the hardest-won fact in the lane and it is a product finding, so it is stated here in
 * full rather than worked around silently.
 *
 * `useVillageFishing` mints its session in `beginFishing`, which is reached two ways, and the two
 * are not equivalent:
 *
 * - **`StructurePanel`'s `Cast Line` button**, via `onCastLine` -> `castFrom(structureId)`, which
 *   records the structure id in a ref *before* `studyFlow.enterFishing` runs. `beginFishing` then
 *   reads that ref.
 * - **`PixiFishingLane`'s `onSessionStarted(pondId)`**, which only the Pixi pond has.
 *
 * The nearby-action row is a **third** route into `enterFishing` - `structureInteract` calls it
 * directly - and it records nothing. So on a build where the pond is the Phaser `FishingScene`,
 * pressing the nearby row runs `prepareFishingSession`, which `VillageScreen` defines as
 * `setInfoPanel(null)` followed by `fishing.prepareSession()`. The ref is still `null`, so
 * `beginFishing` returns early, no session is opened, and the product says so on the catch panel:
 * **"This catch has no open pond session, so the question cannot be asked."** Measured, not
 * inferred - see the module header's own note and this lane's record.
 *
 * The consequence for this lane is precise and worth stating: on the shipping Phaser renderer the
 * recall question is unreachable through the nearby row, `onKeep` can never resolve a question, and
 * therefore `useVillageFishing`'s `assistance` can never become non-null - so **the fishing
 * assistance card cannot be reached on a Phaser build at all.** Walking to the pond's panel and
 * pressing `Cast Line` is the route a learner is offered and the only one that mints a session, so
 * it is the route this lane drives.
 *
 * A reader who would rather see that as a defect than as a lane detail should look at
 * `onInvokeNearby` and `prepareFishingSession` in `src/ui/screens/VillageScreen.tsx`. This file
 * cannot fix it: `src/ui/**` is not this change's to edit.
 */
export const CAST_LINE_SELECTOR = 'button:has-text("Cast Line")';

/**
 * How long a walk holds a key once it is inside the approach band.
 *
 * The far-field hold is `burstMsFor(tileDistance)`, the same schedule the shared harness walks
 * with; inside {@link WALK_NEAR_APPROACH_TILES} the walk uses a short nudge instead, because a
 * full burst at that distance overshoots a structure the learner is already standing next to -
 * which is what makes a panel that opened on approach close again before it can be read.
 */
const NEAR_BAND_HOLD_MS = 150;

/* ── The network spy ─────────────────────────────────────────────────────────── */

/**
 * One request, reduced to the four fields this lane records.
 *
 * Headers, queries, fragments and bodies are omitted deliberately. The lane uses synthetic
 * fixtures, but privacy evidence must not be able to capture anything at all, and a record shape
 * that has no field for a header cannot leak one.
 */
export interface AssistanceNetworkObservation {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
}

export interface AssistanceNetworkSpy {
  /** Every observation, in order. */
  readonly observations: () => readonly AssistanceNetworkObservation[];
  /** Paths of script requests whose file name matched `pattern`. */
  readonly scriptPathsMatching: (pattern: RegExp) => readonly string[];
  /** Every destination the page asked for that is not the preview origin. */
  readonly offOriginPaths: (localOrigin: string) => readonly string[];
  /** Uncaught page errors, which an empty list is itself worth asserting on. */
  readonly pageErrors: () => readonly string[];
}

function observeRequest(request: Request): AssistanceNetworkObservation {
  const url = new URL(request.url());
  const safeUrl =
    url.protocol === 'data:'
      ? 'data:'
      : url.protocol === 'blob:'
        ? `blob:${url.pathname}`
        : `${url.origin}${url.pathname}`;
  return { url: safeUrl, method: request.method(), resourceType: request.resourceType() };
}

/**
 * Install the spy and the non-loopback route guard, before the first navigation.
 *
 * The guard is registered before any navigation so a regression is both observed by the spy and
 * prevented from leaving, which is the order `fishing-harness.ts` records and the reason for it.
 */
export async function installAssistanceNetworkSpy(page: Page): Promise<AssistanceNetworkSpy> {
  const observations: AssistanceNetworkObservation[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => observations.push(observeRequest(request)));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
    if (isLoopback || url.protocol === 'data:' || url.protocol === 'blob:') {
      return route.continue();
    }
    return route.abort();
  });
  return {
    observations: () => observations,
    scriptPathsMatching: (pattern) =>
      observations
        .filter(({ resourceType, url }) => resourceType === 'script' && pattern.test(url))
        .map(({ url }) => new URL(url).pathname),
    offOriginPaths: (origin) => {
      const parsed = new URL(origin);
      const offenders: string[] = [];
      for (const { url } of observations) {
        let candidate: URL;
        try {
          candidate = new URL(url);
        } catch {
          continue;
        }
        if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') continue;
        if (candidate.origin !== parsed.origin && !offenders.includes(candidate.pathname)) {
          offenders.push(candidate.pathname);
        }
      }
      return offenders;
    },
    pageErrors: () => pageErrors,
  };
}

/* ── The journey ─────────────────────────────────────────────────────────────── */

export interface JourneyReading {
  /**
   * Whether the pond's own panel opened.
   *
   * Its own field rather than folded into `enteredFishing`, because the two fail for different
   * reasons and the diagnosis is the whole value of this return: the panel not opening is
   * `VillageScene`'s proximity callback never firing, and the session failing afterwards is the
   * route that was taken rather than the route that was needed.
   */
  readonly pondPanelOpened: boolean;
  /** Whether the learner was in a fishing session at all. */
  readonly enteredFishing: boolean;
  /** Iterations the walk spent before it gave up or arrived. */
  readonly walkIterations: number;
  /** The tile the village published when the walk stopped. */
  readonly walkStoppedAt: VillageGridPoint | null;
  /** How many presses the cast-to-catch loop spent. */
  readonly pressCount: number;
  /** The catch panel's accessible label, or `null` when no catch was revealed. */
  readonly caughtFishLabel: string | null;
  /** Whether the recall dialog offered the "I got that wrong" answer for a room. */
  readonly recallQuestionOffered: boolean;
  /** Whether that answer was pressed, which is what sets the missed-recall state. */
  readonly recallMissed: boolean;
  /** The canvas box the pond was driven through, or `null` when the journey stopped earlier. */
  readonly canvasBox: { readonly width: number; readonly height: number } | null;
}

export interface JourneyOutcome {
  readonly reading: JourneyReading;
  /** The premise failures that make the observation meaningless. Empty means the journey held. */
  readonly premiseFailures: readonly string[];
}

function earlyReading(
  walkIterations: number,
  walkStoppedAt: VillageGridPoint | null,
  extra: Partial<JourneyReading> = {},
): JourneyReading {
  return {
    pondPanelOpened: false,
    enteredFishing: false,
    walkIterations,
    walkStoppedAt,
    pressCount: 0,
    caughtFishLabel: null,
    recallQuestionOffered: false,
    recallMissed: false,
    canvasBox: null,
    ...extra,
  };
}

/**
 * Walk to the pond until its panel opens, and report how the walk went.
 *
 * Deliberately **not** {@link walkToStructureAndPress}: that helper presses the nearby row, and
 * pressing the nearby row is the route that opens no fishing session - see
 * {@link CAST_LINE_SELECTOR} for the measurement. So this walk has no press in it at all, and its
 * completion condition is a real DOM control rather than a row that has gone stale.
 *
 * Feedback-driven rather than a model schedule: `approachBursts` is a pure function of two grid
 * points and measurably walks past its target, which is why the shared harness corrects from the
 * tile the village publishes on every iteration. So does this one, with the same exported helpers.
 */
async function walkToPondPanel(
  page: Page,
): Promise<{ opened: boolean; iterations: number; stoppedAt: VillageGridPoint | null }> {
  const plan = WALK_SPAWN_TO_SW_POND;
  const castLine = page.getByRole('button', { name: 'Cast Line' });
  let at: VillageGridPoint;
  try {
    at = await waitForPlayerGrid(page, plan);
  } catch {
    return { opened: false, iterations: 0, stoppedAt: null };
  }
  const deadline = Date.now() + plan.budgetMs;
  let previous: WalkArrowKey | undefined;
  let iterations = 0;
  while (Date.now() < deadline) {
    iterations += 1;
    if ((await castLine.count()) > 0) return { opened: true, iterations, stoppedAt: at };
    const remaining = gridDistanceTiles(at, plan.to);
    const key = approachKey(at, plan.to, previous);
    await holdKey(page, key, remaining < WALK_NEAR_APPROACH_TILES ? NEAR_BAND_HOLD_MS : burstMsFor(remaining));
    previous = key;
    try {
      at = await waitForPlayerGrid(page, plan);
    } catch {
      // The tile stopped being published. Reported as a walk that ended there rather than thrown,
      // so the caller can say what it measured instead of losing the measurement to a stack.
      return { opened: false, iterations, stoppedAt: at };
    }
  }
  return { opened: false, iterations, stoppedAt: at };
}

/**
 * Drive the whole journey, and report what happened rather than only whether it worked.
 *
 * The return value exists for the two specs' shared failure diagnosis: a lane that reports "the
 * card never appeared" without saying whether the walk arrived, whether the cast ever caught, and
 * whether the recall dialog offered an answer at all is repeating the misleading-diagnosis failure
 * `walkToStructureAndPress` was written to end.
 */
export async function driveMissedRecallJourney(
  page: Page,
  spy: AssistanceNetworkSpy,
): Promise<JourneyOutcome> {
  const premiseFailures: string[] = [];

  await installRecallFixture(page);
  await expect
    .poll(
      async () => {
        await page.goto('/');
        const heading = page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' });
        await heading.waitFor({ timeout: 30_000 });
        // "Continue to Village" rather than "Start Tutorial": the tutorial mints a *second*
        // subject, which would put a room-less subject in the portal slot nearest the pond and
        // disable the charge control. The seeded fixture has to stay the only subject.
        await page.getByRole('button', { name: 'Continue to Village' }).click({ timeout: 60_000 });
        await page.locator('[data-world]').waitFor({ timeout: 60_000 });
        await page.locator('[data-village-nearby="true"]').waitFor({ timeout: 60_000 });
        return recallFixturePremiseFailures(await readSeededSubjectState(page)).join('\n');
      },
      { timeout: 90_000, message: 'the seeded subject never became the active one' },
    )
    .toBe('');
  premiseFailures.push(...recallFixturePremiseFailures(await readSeededSubjectState(page)));

  const walk = await walkToPondPanel(page);
  if (!walk.opened) {
    premiseFailures.push(
      `the walk to the fishing pond spent ${walk.iterations} iteration(s) and stopped at ` +
        `${JSON.stringify(walk.stoppedAt)} without the pond's panel opening. The panel is opened by ` +
        '`VillageScene`\'s proximity callback through `studyFlow.structureApproached`, so an unopened ' +
        'panel means that callback never fired for the pond rather than that the walk aimed badly.',
    );
    return { reading: earlyReading(walk.iterations, walk.stoppedAt), premiseFailures };
  }

  // Press `Cast Line`, which is the control that records the pond before entering it.
  await page.getByRole('button', { name: 'Cast Line' }).click({ timeout: 30_000 });
  await page.locator(FISHING_WORLD_SELECTOR).first().waitFor({ state: 'attached', timeout: 30_000 });
  // `data-world` flips from the React side a commit before `FishingScene.create` binds its own
  // handlers, and the scene swap is what the pond actually is. The live region is the product's own
  // signal that the session started, and settling after it covers the scene's deferred work.
  await expect(page.getByText(FISHING_LIVE_REGION_TEXT)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);

  const canvas = page.locator(`.${FISHING_PHASER_FALLBACK_CLASS} canvas`);
  const box = await canvas.boundingBox();
  const boxReading = box === null ? null : { width: Math.round(box.width), height: Math.round(box.height) };
  if (box === null || box.width < MINIMUM_ASSUMED_CANVAS_PX || box.height < MINIMUM_ASSUMED_CANVAS_PX) {
    premiseFailures.push(
      `the village canvas measured ${boxReading === null ? 'no box' : `${boxReading.width}x${boxReading.height}`}, ` +
        `which is below the ${MINIMUM_ASSUMED_CANVAS_PX}x${MINIMUM_ASSUMED_CANVAS_PX} the press geometry needs, so the ` +
        'cast would land in the shore rather than in the water.',
    );
    return {
      reading: earlyReading(walk.iterations, walk.stoppedAt, {
        pondPanelOpened: true,
        enteredFishing: true,
        canvasBox: boxReading,
      }),
      premiseFailures,
    };
  }
  const pressAt = {
    x: box.x + box.width * WATER_PRESS_FRACTION.x,
    y: box.y + box.height * WATER_PRESS_FRACTION.y,
  };
  await page.mouse.move(pressAt.x, pressAt.y);

  const catchPanel = page.locator(CATCH_PANEL_SELECTOR);
  const deadline = Date.now() + CATCH_LOOP_BUDGET_MS;
  let pressCount = 0;
  while (Date.now() < deadline && (await catchPanel.count()) === 0) {
    pressCount += 1;
    await page.mouse.down();
    await page.waitForTimeout(CHARGE_HOLD_MS);
    await page.mouse.up();
    await page.waitForTimeout(40);
    if (spy.pageErrors().length > 0) break;
  }
  const caught = (await catchPanel.count()) > 0;
  const caughtFishLabel = caught
    ? await catchPanel.first().getAttribute('aria-label').catch(() => null)
    : null;
  if (!caught) {
    return {
      reading: earlyReading(walk.iterations, walk.stoppedAt, {
        pondPanelOpened: true,
        enteredFishing: true,
        pressCount,
        canvasBox: boxReading,
      }),
      premiseFailures,
    };
  }

  // Keep the fish: this is the control that opens the recall question, and `useVillageFishing.onKeep`
  // is the only path to the dialog.
  await page.locator(KEEP_FISH_SELECTOR).first().click({ timeout: 30_000 });

  /*
   * Which branch of the dialog opened, and the diagnosis for each.
   *
   * `onKeep` resolves the question against the **session's own subject** and only when that
   * subject has a cleared room, and it offers the "I got that wrong" answer only when it found a
   * question. The other branch says so in words: "This subject has no cleared rooms yet, so there
   * is no question to ask." So the two branches are distinguishable from the DOM, and a lane that
   * reported "no answer offered" without saying which branch it saw would be repeating the
   * misleading-diagnosis failure `walkToStructureAndPress` exists to end. The fixture *is* a
   * cleared room, so the no-question branch here is a finding about the session rather than a
   * state the journey is entitled to reach - and the session is exactly what the `Cast Line` route
   * exists to mint.
   */
  const recallDialog = page.locator(RECALL_DIALOG_SELECTOR);
  await recallDialog.first().waitFor({ state: 'visible', timeout: 30_000 });
  const recallIncorrect = page.locator(RECALL_INCORRECT_SELECTOR);
  const noQuestionBranch = (await page.locator(RECALL_NO_QUESTION_SELECTOR).count()) > 0;
  const recallQuestionOffered = (await recallIncorrect.count()) > 0;
  if (!recallQuestionOffered) {
    premiseFailures.push(
      noQuestionBranch
        ? 'the recall dialog opened its "no cleared rooms yet" branch, so `useVillageFishing.onKeep` ' +
          'resolved no question. On a session opened through the pond\'s `Cast Line` control that means ' +
          "either the session's subject is not the seeded one, or its snapshot carried no cleared room - " +
          'and on a session opened through any other route it means no session was opened at all, which ' +
          'is the Phaser defect `CAST_LINE_SELECTOR` records.'
        : 'the recall dialog opened with neither a question nor its no-question branch, so the ' +
          "dialog's own structure is not what this lane reads.",
    );
  }
  let recallMissed = false;
  if (recallQuestionOffered) {
    await recallIncorrect.first().click({ timeout: 30_000 });
    recallMissed = true;
  }

  return {
    reading: {
      pondPanelOpened: true,
      enteredFishing: true,
      walkIterations: walk.iterations,
      walkStoppedAt: walk.stoppedAt,
      pressCount,
      caughtFishLabel,
      recallQuestionOffered,
      recallMissed,
      canvasBox: boxReading,
    },
    premiseFailures,
  };
}

/** The preview origins the two configs bind, as the lane's specs compute them. */
export function localOriginFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The suggestion row's published numbers, read as numbers rather than as prose.
 *
 * `data-assistance-priority` and `data-assistance-evidence-count` are the card's own machine
 * readable summary of why a suggestion outranks another and how much stands behind it, and reading
 * them is what makes "the card shows a ranked suggestion" a claim rather than "some text appeared".
 */
export interface SuggestionReading {
  readonly kind: string | null;
  readonly reasonCode: string | null;
  readonly intensity: string | null;
  readonly priority: number | null;
  readonly evidenceCount: number | null;
  readonly title: string;
  readonly reasonText: string;
  readonly dismissLabel: string;
  readonly dismissAccessibleName: string;
}

export async function readFirstSuggestion(page: Page): Promise<SuggestionReading> {
  const row = page.locator(ASSISTANCE_PROBES.suggestion).first();
  return {
    kind: await row.getAttribute(ASSISTANCE_KIND_ATTRIBUTE),
    reasonCode: await row.getAttribute(ASSISTANCE_REASON_ATTRIBUTE),
    // Read from the paragraph that carries it rather than from the row. The card publishes the
    // kind and the reason on the `<li>` and the intensity on the element that owns the intensity
    // *word*, because the word is what a learner reads and the attribute is only a test hook -
    // so reading it off the row would report `null` on a perfectly correct card.
    intensity: await row.locator(`[${ASSISTANCE_INTENSITY_ATTRIBUTE}]`).first().getAttribute(
      ASSISTANCE_INTENSITY_ATTRIBUTE,
    ),
    priority: Number(
      await row
        .locator(`[${ASSISTANCE_COUNT_ATTRIBUTES.priority}]`)
        .first()
        .getAttribute(ASSISTANCE_COUNT_ATTRIBUTES.priority),
    ),
    evidenceCount: Number(
      await row
        .locator(`[${ASSISTANCE_COUNT_ATTRIBUTES.evidence}]`)
        .first()
        .getAttribute(ASSISTANCE_COUNT_ATTRIBUTES.evidence),
    ),
    title: (await row.locator(ASSISTANCE_TITLE_CLASS).first().innerText()).trim(),
    reasonText: (await row.locator(ASSISTANCE_PROBES.reasonText).first().innerText()).trim(),
    dismissLabel: (await row.locator(ASSISTANCE_PROBES.dismiss).first().innerText()).trim(),
    dismissAccessibleName: (
      (await row.locator(ASSISTANCE_PROBES.dismiss).first().getAttribute('aria-label')) ?? ''
    ).trim(),
  };
}