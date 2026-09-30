import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page, type Request, type TestInfo } from '@playwright/test';

import {
  FONT_METRIC_SETS,
  PLAN_MINIMUM_TOUCH_TARGET_PX,
  PLAN_ZOOM_PERCENT,
  SUBJECT_NAME_LENGTH_CASES,
  WELCOME_NARROW_VIEWPORT,
  WELCOME_SECTION_TAB_NAMES,
  applyFontMetricSet,
  expectSweepCanSeeAForcedOffender,
  measureBiomeSelectWidth,
  measureHorizontalOverflow,
  measureTouchTargets,
  seedLegacySubject,
  selectWelcomeSectionTab,
  settleLayout,
  waitForSubjectListEntry,
  type HorizontalOverflowReading,
  type SubjectNameCase,
  type TouchTargetReading,
} from './welcome-narrow-viewport';
// Phase 8's remote-font gate. The predicate lives beside the QA test that proves
// it fails when the condition recurs, so there is one implementation rather than
// an inline assertion and a separate test of a copy. See the module header for
// why the known-legacy tolerance is kept alongside the assertion.
import {
  assertNoRemoteFontRequests,
  countRemoteFontRequests,
} from '../phase8/support/remoteFontGate';
// The sanctioned tablet viewports, read from the one support matrix rather than
// re-typed here. The narrow-viewport guard in `welcome-narrow-viewport.test.ts`
// forbids an inline `setViewportSize({ width: <not 320> })`, and using the matrix's
// own records is the honest shape: these two are the portrait/landscape pair the
// village resize check exercises, not a second definition of the 320px gate.
import { supportEntryForProject } from './support-matrix';

const WCAG_22_AA_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
] as const;

interface NetworkObservation {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
}

function observeRequest(request: Request): NetworkObservation {
  // Deliberately omit headers, queries, fragments, and request bodies. E2E uses
  // only synthetic tutorial data, and privacy evidence must not capture it.
  const url = new URL(request.url());
  const safeUrl =
    url.protocol === 'data:'
      ? 'data:'
      : url.protocol === 'blob:'
        ? `blob:${url.pathname}`
        : `${url.origin}${url.pathname}`;
  return {
    url: safeUrl,
    method: request.method(),
    resourceType: request.resourceType(),
  };
}

interface PrivacyNetworkReport {
  readonly violations: string[];
  readonly blockedLegacyFontRequests: NetworkObservation[];
}

function inspectPrivacyNetwork(
  observations: readonly NetworkObservation[],
  origin: string,
): PrivacyNetworkReport {
  const forbiddenDestination = /(?:analytics|telemetry|remote[-_]?config)/i;
  const knownLegacyFontHosts = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
  const violations: string[] = [];
  const blockedLegacyFontRequests: NetworkObservation[] = [];

  for (const observation of observations) {
    const url = new URL(observation.url);
    const method = observation.method.toUpperCase();

    if (method !== 'GET' && method !== 'HEAD') {
      violations.push(`unexpected request method: ${method} ${url.pathname}`);
      continue;
    }

    // Blob/data URLs are generated in memory and cannot contact a network
    // destination. A blob URL must still inherit the local preview origin.
    if (url.protocol === 'data:') continue;
    if (url.protocol === 'blob:') {
      const blobOrigin = new URL(url.pathname).origin;
      if (blobOrigin === origin) continue;
      violations.push(`external blob origin: ${blobOrigin}`);
      continue;
    }

    if (
      forbiddenDestination.test(url.pathname) ||
      url.pathname === '/api/upload' ||
      url.pathname.startsWith('/api/upload/') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/uploads/')
    ) {
      violations.push(`forbidden application destination: ${method} ${url.pathname}`);
      continue;
    }

    if (url.origin !== origin) {
      // Phase 8 removed the last remote font import, so on the current artifact
      // this branch is unreachable and the assertion below is the backstop. The
      // known-legacy static font hosts stay recognised: the tolerance is what
      // turns a reintroduced font import into a readable count instead of an
      // anonymous external destination, and the recognition is what lets
      // `assertNoRemoteFontRequests` below require that count to be zero. A
      // request to any other external host is still a violation.
      if (knownLegacyFontHosts.has(url.hostname)) {
        blockedLegacyFontRequests.push(observation);
      } else {
        violations.push(`external destination: ${observation.method} ${url.origin}${url.pathname}`);
      }
      continue;
    }

    const isStaticPath =
      url.pathname === '/' ||
      url.pathname === '/favicon.ico' ||
      url.pathname.startsWith('/assets/');
    if (!isStaticPath) {
      violations.push(`unexpected non-static local destination: ${method} ${url.pathname}`);
    }
  }

  return { violations, blockedLegacyFontRequests };
}

async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

async function waitForWelcome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
  ).toBeVisible();
  await expect(page.getByText(/local-first study dungeon-crawler/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Tutorial' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // Keep every E2E context offline. A privacy regression is still observed by
  // the network spy, but no external request can leave the test browser.
  await page.route(
    (url) =>
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
});

test('Welcome loads from the deterministic production preview', async ({ page }) => {
  await waitForWelcome(page);
  await expect(page.getByRole('tab', { name: 'Create / Load' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('Welcome introduces no new serious or critical automated accessibility violations', async ({
  page,
}, testInfo) => {
  await waitForWelcome(page);

  const results = await new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]).analyze();
  const blockingViolations = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  // Phase 1 records this pre-existing contrast defect rather than redesigning
  // the current UI. Every additional serious/critical node remains a failure;
  // Phase 21 owns removal of the recorded exception.
  let knownContrastExceptionsRemaining = 1;
  const knownBlockingViolations: string[] = [];
  const unexpectedBlockingViolations: string[] = [];

  for (const violation of blockingViolations) {
    for (const node of violation.nodes) {
      const signature = `${violation.id}|${violation.impact}|${node.target.join(' ')}`;
      if (
        signature === 'color-contrast|serious|.welcome-checklist-status--done' &&
        knownContrastExceptionsRemaining > 0
      ) {
        knownBlockingViolations.push(signature);
        knownContrastExceptionsRemaining -= 1;
      } else {
        unexpectedBlockingViolations.push(signature);
      }
    }
  }

  await attachJson(testInfo, 'welcome-axe-results.json', {
    testEngine: results.testEngine,
    knownBlockingViolations,
    unexpectedBlockingViolations,
  });

  expect(
    unexpectedBlockingViolations,
    unexpectedBlockingViolations.join('\n'),
  ).toEqual([]);
});

/**
 * The dungeon route, which is Phaser in both build variants.
 *
 * `VITE_PIXI_VILLAGE` switches only the village route, so this journey is the same
 * on the default and the flagged artifact and its "no Pixi request" claim is a true
 * statement about the Welcome-to-dungeon path in both. The village route's own
 * variant-aware coverage is the next test.
 */
test('safe tutorial action renders the Phaser dungeon world with static-only network traffic', async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Playwright baseURL is required for the privacy network spy.');

  const observations: NetworkObservation[] = [];
  const webSocketUrls: string[] = [];
  page.on('request', (request) => observations.push(observeRequest(request)));
  await page.routeWebSocket(() => true, (webSocket) => {
    const url = new URL(webSocket.url());
    webSocketUrls.push(`${url.origin}${url.pathname}`);
  });

  await waitForWelcome(page);
  await page.getByRole('button', { name: 'Start Tutorial' }).click();

  const canvas = page.locator('.game-canvas-host canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        canvas.evaluate((element) => {
          const worldCanvas = element as HTMLCanvasElement;
          return {
            width: worldCanvas.width,
            height: worldCanvas.height,
            clientWidth: worldCanvas.clientWidth,
            clientHeight: worldCanvas.clientHeight,
          };
        }),
      { timeout: 30_000 },
    )
    .toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
      clientWidth: expect.any(Number),
      clientHeight: expect.any(Number),
    });

  const canvasSize = await canvas.evaluate((element) => {
    const worldCanvas = element as HTMLCanvasElement;
    return {
      width: worldCanvas.width,
      height: worldCanvas.height,
      clientWidth: worldCanvas.clientWidth,
      clientHeight: worldCanvas.clientHeight,
    };
  });
  expect(canvasSize.width).toBeGreaterThan(0);
  expect(canvasSize.height).toBeGreaterThan(0);
  expect(canvasSize.clientWidth).toBeGreaterThan(0);
  expect(canvasSize.clientHeight).toBeGreaterThan(0);

  await page.waitForLoadState('networkidle');

  const scriptRequests = observations.filter(({ resourceType }) => resourceType === 'script');
  const phaserChunkRequests = scriptRequests.filter(({ url }) =>
    /\/assets\/vendor-phaser-[^/]+\.js(?:\?|$)/.test(url),
  );
  expect(
    phaserChunkRequests,
    'Expected the current production build to load its named Phaser vendor chunk.',
  ).not.toEqual([]);
  expect(scriptRequests.filter(({ url }) => /pixi/i.test(url))).toEqual([]);

  const privacyReport = inspectPrivacyNetwork(observations, new URL(baseURL).origin);
  await attachJson(testInfo, 'privacy-network-observations.json', {
    canvasSize,
    phaserChunkRequests,
    webSocketUrls,
    ...privacyReport,
  });
  expect(webSocketUrls, `Unexpected WebSocket destinations: ${webSocketUrls.join(', ')}`).toEqual([]);
  expect(privacyReport.violations, privacyReport.violations.join('\n')).toEqual([]);

  // Phase 8 exit criterion: "The app renders without remote font requests."
  //
  // `blockedLegacyFontRequests` used to be recorded and never asserted, so this
  // criterion had no failing state in the suite. It is asserted now, and the
  // assertion stays after the tolerance above: the hosts are still recognised as
  // known-legacy, so a reintroduced font import fails with a sentence about a
  // font host and a count rather than as an anonymous external destination in a
  // test whose premise is that there is no external traffic. The message carries
  // the count and the resource types only - never a hostname - so a failing run
  // cannot print the destination the privacy suite exists to prove is absent.
  //
  // The count is attached first so the artifact records the number even if the
  // assertion below is what turns the run red.
  const remoteFontRequestCount = countRemoteFontRequests(privacyReport.blockedLegacyFontRequests);
  await attachJson(testInfo, 'remote-font-request-check.json', {
    remoteFontRequestCount,
    // The count is the claim; the resource types are the only diagnostic that is
    // safe to record, because they are browser constants rather than destinations.
    resourceTypes: [
      ...new Set(privacyReport.blockedLegacyFontRequests.map((entry) => entry.resourceType)),
    ].sort(),
  });
  assertNoRemoteFontRequests(privacyReport.blockedLegacyFontRequests);
});

/*
 * ── The village route, in whichever renderer this build was asked for ──────
 *
 * `VITE_PIXI_VILLAGE=true` switches the village route to the lazy PixiJS world and
 * leaves the dungeon route on Phaser. The Phase 11 verification commands run this
 * file twice - once as the flagged build (all projects) and once as the default
 * build (the tablet project) - so this test has to pass on both artifacts. It
 * detects the mounted world from the DOM rather than assuming, and asserts the
 * variant it actually found matches the flag the build was made with, so a build
 * whose flag and artifact disagree fails instead of quietly passing.
 *
 * On the flagged build the claim is the deliverable itself: the Pixi surface
 * mounts, the DOM interact control exists, keyboard movement reaches the world
 * (read from the live scene graph through PixiJS's own `__PIXI_APP_INIT__` hook),
 * six subject slots are drawn, and a portrait/landscape resize does not raise.
 */

const VILLAGE_FIXTURE = path.join(
  process.cwd(),
  'tests/fixtures/persistence/subject/subject-1.1.0-full-unknown-fields.json',
);

/** Six synthetic subjects, so all six authored portal slots have an occupant. */
const VILLAGE_SUBJECT_NAMES = ['Algebra', 'Biology', 'Calculus', 'Drama', 'Ecology', 'French'] as const;

/**
 * Seeds several synthetic subjects into the legacy storage the default build reads.
 *
 * A local copy of `seedLegacySubject`'s storage shape rather than an extension of it:
 * the narrowed helper seeds exactly one, and the village needs the full six-slot set
 * to show what the data model can hold. Every value is synthetic.
 */
async function seedLegacySubjects(page: Page, names: readonly string[]): Promise<void> {
  const template = JSON.parse(readFileSync(VILLAGE_FIXTURE, 'utf8')) as {
    dungeon: Record<string, unknown>;
  };
  const entries = names.map((name, index) => {
    const id = `e2e-village-subject-${index}`;
    const snapshot = {
      ...template,
      dungeon: { ...template.dungeon, dungeonId: id, subjectName: name },
    };
    return { id, snapshot: JSON.stringify(snapshot) };
  });
  await page.addInitScript((payload: ReadonlyArray<{ id: string; snapshot: string }>) => {
    window.localStorage.setItem(
      'knowledge-dungeon:v1:subjects',
      JSON.stringify(payload.map((entry) => entry.id)),
    );
    for (const entry of payload) {
      window.localStorage.setItem(`knowledge-dungeon:v1:subject:${entry.id}`, entry.snapshot);
    }
  }, entries);
}

/**
 * Captures every PixiJS `Application` through the library's own documented hook.
 *
 * Read rather than replaced: if another tool installed the hook, it is still called.
 */
async function installVillageProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const applications: unknown[] = [];
    scope['__KD_E2E_PIXI_APPS__'] = applications;
    const previous = scope['__PIXI_APP_INIT__'];
    scope['__PIXI_APP_INIT__'] = (application: unknown) => {
      applications.push(application);
      if (typeof previous === 'function') (previous as (value: unknown) => void)(application);
    };
  });
}

interface VillageSceneReading {
  /** The player marker's world position, or `null` if the scene is not on the stage. */
  readonly player: { x: number; y: number } | null;
  /** Every `Text` value in the village layer, so the drawn labels can be asserted. */
  readonly labels: readonly string[];
}

/** Reads the live Pixi scene graph: the player position and every drawn text. */
async function readVillageScene(page: Page): Promise<VillageSceneReading> {
  return page.evaluate(() => {
    interface SceneNode {
      readonly text?: unknown;
      readonly x?: number;
      readonly y?: number;
      readonly children?: readonly SceneNode[];
      getChildByLabel?(label: string): SceneNode | null;
    }
    const scope = globalThis as unknown as Record<string, unknown>;
    const applications = (scope['__KD_E2E_PIXI_APPS__'] as unknown[] | undefined) ?? [];
    const application = applications[applications.length - 1] as { stage?: SceneNode } | undefined;
    const root = application?.stage?.getChildByLabel?.('village-world') ?? null;
    const layer = root?.getChildByLabel?.('village-world-layer') ?? null;
    const player = layer?.getChildByLabel?.('village-player') ?? null;
    const labels: string[] = [];
    const visit = (node: SceneNode): void => {
      if (typeof node.text === 'string') labels.push(node.text);
      for (const child of node.children ?? []) visit(child);
    };
    if (layer) visit(layer);
    return {
      player:
        player && typeof player.x === 'number' && typeof player.y === 'number'
          ? { x: player.x, y: player.y }
          : null,
      labels,
    };
  });
}

test('the village route mounts the renderer this build was asked for', async ({ page }, testInfo) => {
  const expectedPixi = process.env.VITE_PIXI_VILLAGE === 'true';
  const scriptRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') {
      scriptRequests.push(new URL(request.url()).pathname);
    }
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installVillageProbe(page);
  await seedLegacySubjects(page, VILLAGE_SUBJECT_NAMES);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await waitForSubjectListEntry(page, VILLAGE_SUBJECT_NAMES[0]);

  const continueButton = page.getByRole('button', { name: 'Continue to Village' });
  await expect(continueButton).toBeVisible();
  await continueButton.click();

  const pixiSurface = page.locator('.pixi-village-world');
  const phaserCanvas = page.locator('.village-canvas canvas');
  await expect
    .poll(
      async () =>
        (await pixiSurface.count()) > 0 ? 'pixi' : (await phaserCanvas.count()) > 0 ? 'phaser' : 'none',
      { timeout: 30_000 },
    )
    .not.toBe('none');
  const mounted = (await pixiSurface.count()) > 0 ? 'pixi' : 'phaser';
  const pixiScriptRequests = scriptRequests.filter((pathname) => /pixi/i.test(pathname));

  if (expectedPixi) {
    expect(mounted, 'VITE_PIXI_VILLAGE=true, but the Phaser village mounted').toBe('pixi');
    await expect(pixiSurface).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Interact (E or Space)' })).toBeVisible();
    expect(
      pixiScriptRequests,
      'the flagged village route requested no Pixi chunk, so the switch was not exercised',
    ).not.toEqual([]);

    // Six subject portal slots: one drawn label per seeded subject, read from the
    // live scene graph rather than from a DOM the canvas does not have.
    await expect
      .poll(async () => (await readVillageScene(page)).labels.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const reading = await readVillageScene(page);
    for (const subject of VILLAGE_SUBJECT_NAMES) {
      expect(reading.labels, subject).toContain(subject);
    }

    // Movement reaches the world: the player marker's world position changes.
    const before = reading.player;
    expect(before, 'the player marker was not on the real stage').not.toBeNull();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowRight');
    const after = (await readVillageScene(page)).player;
    expect(after, 'the player marker was not on the real stage after movement').not.toBeNull();
    const travelled =
      Math.abs((after?.x ?? 0) - (before?.x ?? 0)) + Math.abs((after?.y ?? 0) - (before?.y ?? 0));
    expect(travelled, 'keyboard movement did not reach the Pixi scene').toBeGreaterThan(1);

    // Portrait then landscape: the world resizes rather than throwing. The two
    // viewports are the support matrix's own tablet records, so this is the
    // sanctioned portrait/landscape pair rather than a third inline size.
    await page.setViewportSize({ ...supportEntryForProject('tablet').viewport });
    await expect(pixiSurface).toBeVisible();
    await page.setViewportSize({ ...supportEntryForProject('tablet-landscape').viewport });
    await expect(pixiSurface).toBeVisible();
    expect(pageErrors, `page errors during the Pixi village run: ${pageErrors.join(' | ')}`).toEqual([]);
  } else {
    expect(mounted, 'the default build mounted the Pixi village').toBe('phaser');
    await expect(phaserCanvas).toBeVisible({ timeout: 30_000 });
    expect(
      pixiScriptRequests,
      'the default village route requested a Pixi chunk',
    ).toEqual([]);
  }

  await attachJson(testInfo, 'village-renderer-variant.json', {
    expectedPixi,
    mounted,
    pixiScriptRequests,
    scriptRequestCount: scriptRequests.length,
    pageErrors,
  });
});

/*
 * ── The 320 CSS-pixel viewport gate ───────────────────────────────────────
 *
 * Plan §10.1 requires core operation at 200 % zoom and a 320 CSS-pixel viewport,
 * and the default production build did not meet it: `#welcome-panel-subjects`
 * has a min-content width, `.welcome-main` is a flex row, and a subject name is
 * rendered inside that panel, so the name set the floor of the whole row. A name
 * with a break opportunity in it measured zero, which is why this was not
 * reproducible from a short name.
 *
 * These two tests are that failure's regression gate, in this suite and no
 * other, for the reason `welcome-narrow-viewport.test.ts` records: this suite is
 * the one the shared production artifact's `browser-smoke` step already runs, so
 * the gate ships in an existing gating step on an already-built artifact with
 * no new project, no new config, and no second build.
 */

interface NarrowViewportMeasurement {
  readonly label: string;
  readonly characters: number;
  readonly fontMetricSet: string;
  readonly reading: HorizontalOverflowReading;
  /** Width of the seeded subject's own selection control, or 0 when unseeded. */
  readonly subjectEntryWidth: number;
  /** The biome `<select>`, whose intrinsic width is the floor's main input. */
  readonly biomeSelectWidth: number | null;
  /** The forced-overflow control run against this page. */
  readonly sweepControlSawTheForcedOffender: boolean;
}

/**
 * One name length, measured under every declared font metric set.
 *
 * A fresh context per name length rather than one context re-seeded, because the
 * subject list is read on mount: a seed applied to a page that is already showing
 * the list is a different state from the one that overflows.
 *
 * The metric sets are applied by swapping one stylesheet on the *same* page
 * rather than by loading a page per set. That is the difference between a
 * font-deterministic gate and a slow one: the cross product is 30 readings from
 * 5 page loads, and every reading is taken on a page whose fonts have been
 * reported as ready and whose layout has been re-settled after the swap.
 */
async function measureWelcomeShellForNameCase(
  browser: Browser,
  nameCase: SubjectNameCase,
): Promise<NarrowViewportMeasurement[]> {
  const context = await browser.newContext({ viewport: { ...WELCOME_NARROW_VIEWPORT } });
  try {
    const page = await context.newPage();
    await page.route(
      (url) =>
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname !== '127.0.0.1',
      async (route) => {
        await route.abort('blockedbyclient');
      },
    );
    await seedLegacySubject(page, nameCase.subjectName);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible();
    const subjectEntryWidth = await waitForSubjectListEntry(page, nameCase.subjectName);
    // The list is on the page before any font is touched, so a zero here is the
    // "measured an empty element" trap and not a layout result.
    if (nameCase.subjectName !== null) {
      expect(
        subjectEntryWidth,
        `${nameCase.label}: the seeded subject list entry was laid out at zero width.`,
      ).toBeGreaterThan(0);
    }
    await settleLayout(page);

    const measurements: NarrowViewportMeasurement[] = [];
    for (const metricSet of FONT_METRIC_SETS) {
      await applyFontMetricSet(page, metricSet);
      // The name is still the learner's name after a font swap, so the layout
      // being measured is still the layout that carries it. Asserted rather than
      // assumed, because a swap that somehow unmounted the list would leave a
      // shorter page and a clean reading.
      const entryWidthAfterSwap = await waitForSubjectListEntry(page, nameCase.subjectName);
      if (nameCase.subjectName !== null) {
        expect(
          entryWidthAfterSwap,
          `${nameCase.label} under ${metricSet.id}: the subject list entry was laid out at zero width after the font swap.`,
        ).toBeGreaterThan(0);
      }

      // Non-vacuity, before the reading that matters: break the page on purpose
      // and require the sweep to notice. A sweep that cannot see an overflow it
      // was handed would make every "no overflow" below meaningless.
      const control = await expectSweepCanSeeAForcedOffender(page);

      measurements.push({
        label: nameCase.label,
        characters: nameCase.characters,
        fontMetricSet: metricSet.id,
        reading: await measureHorizontalOverflow(page),
        subjectEntryWidth: entryWidthAfterSwap,
        biomeSelectWidth: await measureBiomeSelectWidth(page),
        sweepControlSawTheForcedOffender: control.seen,
      });
    }
    return measurements;
  } finally {
    await context.close();
  }
}

test('the Welcome shell has no horizontal overflow at 320 CSS pixels, at any subject-name length and under any font', async ({
  browser,
  page,
}, testInfo) => {
  const measurements: NarrowViewportMeasurement[] = [];
  for (const nameCase of SUBJECT_NAME_LENGTH_CASES) {
    measurements.push(...(await measureWelcomeShellForNameCase(browser, nameCase)));
  }

  await attachJson(testInfo, 'welcome-narrow-viewport-overflow.json', {
    viewport: WELCOME_NARROW_VIEWPORT,
    planZoomPercent: PLAN_ZOOM_PERCENT,
    note: '200% zoom at a 640 CSS-pixel window is this same 320 CSS-pixel layout viewport.',
    fontMetricSets: FONT_METRIC_SETS.map((metricSet) => ({
      id: metricSet.id,
      fontFamily: metricSet.fontFamily,
      fontSizePx: metricSet.fontSizePx,
      purpose: metricSet.purpose,
    })),
    measurements: measurements.map((entry) => ({
      label: entry.label,
      characters: entry.characters,
      fontMetricSet: entry.fontMetricSet,
      subjectEntryWidth: entry.subjectEntryWidth,
      biomeSelectWidth: entry.biomeSelectWidth,
      sweepControlSawTheForcedOffender: entry.sweepControlSawTheForcedOffender,
      ...entry.reading,
    })),
  });

  // ── The control, first, on every single reading, so a false pass is impossible.
  for (const entry of measurements) {
    expect(
      entry.sweepControlSawTheForcedOffender,
      `${entry.label} under ${entry.fontMetricSet}: the overflow sweep did not notice a 1280px box forced into a 320px viewport, so a clean reading from it proves nothing.`,
    ).toBe(true);
  }

  // ── The page fits, at every name length, under every declared metric set, on
  // both halves of the measurement.
  for (const entry of measurements) {
    const where = `${entry.label} (${entry.characters} characters) under ${entry.fontMetricSet}`;
    expect(
      entry.reading.clientWidth,
      `${where}: the reading is not at the plan's viewport width, so it is not the measurement this gate claims to be.`,
    ).toBe(WELCOME_NARROW_VIEWPORT.width);

    expect(
      entry.reading.pageOverflowPx,
      `${where}: documentElement.scrollWidth ${entry.reading.documentScrollWidth} exceeds clientWidth ${entry.reading.clientWidth} (biome select ${entry.biomeSelectWidth}px). Offenders: ${entry.reading.offenders
        .map((offender) => `${offender.selector} right=${offender.right} width=${offender.width}`)
        .join('; ')}`,
    ).toBe(0);

    expect(
      entry.reading.offenders,
      `${where}: elements reach right=${entry.reading.offenders[0]?.right ?? 'none'} past clientWidth=${entry.reading.clientWidth}. Offenders: ${entry.reading.offenders
        .map((offender) => `${offender.selector} right=${offender.right} width=${offender.width}`)
        .join('; ')}`,
    ).toEqual([]);

    // An empty sweep over an empty page is a pass with no content, so the number
    // of elements that were actually measured is asserted too.
    expect(
      entry.reading.measuredElementCount,
      `${where}: the sweep measured no elements at all.`,
    ).toBeGreaterThan(50);
  }

  // ── The sweep is a sweep, not a single extra reading. A metric-set list of one
  // would be a gate pinned to whichever set happened to pass, which is the
  // failure mode this sweep exists to remove.
  expect(FONT_METRIC_SETS.length).toBeGreaterThanOrEqual(4);
  expect(
    measurements.filter((entry) => entry.fontMetricSet === 'mono-20').length,
    'the widest declared metric set was not measured for every name length.',
  ).toBe(SUBJECT_NAME_LENGTH_CASES.length);
  expect(
    measurements.filter((entry) => entry.fontMetricSet === 'serif-16').length,
    'the narrow control metric set was not measured for every name length.',
  ).toBe(SUBJECT_NAME_LENGTH_CASES.length);
  // The cross product really is the product, not five readings under one set.
  expect(new Set(measurements.map((entry) => entry.fontMetricSet)).size).toBe(FONT_METRIC_SETS.length);
  expect(measurements.length).toBe(SUBJECT_NAME_LENGTH_CASES.length * FONT_METRIC_SETS.length);

  // ── The name is wrapped, not shortened. This is the reason the fix is allowed
  // to exist at all: a control that hid the tail of the name would satisfy every
  // width assertion above and fail the learner.
  await seedLegacySubject(
    page,
    SUBJECT_NAME_LENGTH_CASES.find((nameCase) => nameCase.characters === 122)?.subjectName ?? null,
  );
  await page.setViewportSize({ ...WELCOME_NARROW_VIEWPORT });
  await page.goto('/');
  const longName = SUBJECT_NAME_LENGTH_CASES.find((nameCase) => nameCase.characters === 122)
    ?.subjectName as string;
  await waitForSubjectListEntry(page, longName);
  await settleLayout(page);

  const entry = page.locator('#welcome-panel-subjects .welcome-actions button').filter({ hasText: longName }).first();
  const rendered = (await entry.innerText()).replace(/\s+/g, ' ').trim();
  // Every character of the name is still there. The button also carries a sibling
  // progress count, so the name is asserted as a prefix rather than the whole
  // label, and compared with whitespace removed: `overflow-wrap` inserts a line
  // break, not a character, so the name itself must be byte-identical.
  expect(rendered.startsWith(longName), `rendered as: ${rendered.slice(0, 140)}`).toBe(true);
  expect(rendered.replace(/\s/g, '')).toContain(longName);

  // It is real, selectable text rather than an image, a `title`, or a tooltip, and
  // the name's own text node is the one a learner selects. `Selection.toString()`
  // is not used: it depends on document focus, which a headless measurement
  // context does not have, so a `""` there would be an artefact rather than a
  // finding. The Range is the thing being asserted, and the selection is checked
  // for having taken it.
  const nameText = await entry.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return { text: '', lineBoxes: 0, rangeCount: -1, selectedTheName: false };
    const range = document.createRange();
    range.selectNodeContents(node);
    const current = window.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
    return {
      text: range.toString(),
      lineBoxes: range.getClientRects().length,
      rangeCount: current?.rangeCount ?? 0,
      selectedTheName: current?.anchorNode === node && current?.focusNode === node,
    };
  });
  expect(nameText.text.trim()).toBe(longName);
  expect(nameText.rangeCount).toBe(1);
  expect(nameText.selectedTheName).toBe(true);

  // ...and the name genuinely had to wrap. The number of client rects a Range over
  // the name's own text node produces is the number of line boxes it occupies,
  // which is the direct measurement of "this name does not fit on one line here".
  expect(
    nameText.lineBoxes,
    'the 122-character name fit on one line, so nothing was actually wrapped and the width fix is untested',
  ).toBeGreaterThan(1);
});

test('every Welcome shell control meets the 44 CSS-pixel minimum touch target at 320 pixels', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: { ...WELCOME_NARROW_VIEWPORT } });
  try {
    const page = await context.newPage();
    await page.route(
      (url) =>
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname !== '127.0.0.1',
      async (route) => {
        await route.abort('blockedbyclient');
      },
    );
    // The longest name, so the tab that carries the learner's own text is the one
    // being measured, and the sidebar's three primary controls are all present.
    const longName = SUBJECT_NAME_LENGTH_CASES.find((nameCase) => nameCase.characters === 122)
      ?.subjectName as string;
    await seedLegacySubject(page, longName);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible();
    await waitForSubjectListEntry(page, longName);
    await settleLayout(page);

    // The skip link App.tsx injects on boot. It is the shell's first control and
    // it is measured here unfocused, which is the size a tab stop lands on.
    await expect(page.locator('a.skip-link')).toHaveCount(1);

    const readings: Array<TouchTargetReading & { tab: string }> = [];
    readings.push({ tab: 'Create / Load', ...(await measureTouchTargets(page)) });
    for (const tab of WELCOME_SECTION_TAB_NAMES.slice(1)) {
      await selectWelcomeSectionTab(page, tab);
      readings.push({ tab, ...(await measureTouchTargets(page)) });
    }

    await attachJson(testInfo, 'welcome-narrow-viewport-touch-targets.json', {
      viewport: WELCOME_NARROW_VIEWPORT,
      minimumPx: PLAN_MINIMUM_TOUCH_TARGET_PX,
      readings,
    });

    let measuredTotal = 0;
    for (const reading of readings) {
      measuredTotal += reading.measuredControlCount;
      expect(
        reading.measuredControlCount,
        `${reading.tab}: no controls were measured, so a clean reading is vacuous.`,
      ).toBeGreaterThan(0);
      expect(
        reading.shortfalls,
        `${reading.tab}: controls below ${PLAN_MINIMUM_TOUCH_TARGET_PX}x${PLAN_MINIMUM_TOUCH_TARGET_PX} CSS pixels - ${reading.shortfalls
          .map((shortfall) => `${shortfall.selector} ${shortfall.width}x${shortfall.height}`)
          .join('; ')}`,
      ).toEqual([]);
    }
    // The whole shell across its four tabs, so a sweep that only ever looked at
    // one panel cannot pass this.
    expect(measuredTotal).toBeGreaterThanOrEqual(20);
  } finally {
    await context.close();
  }
});
