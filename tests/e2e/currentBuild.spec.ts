import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page, type Request, type TestInfo } from '@playwright/test';

import {
  PLAN_MINIMUM_TOUCH_TARGET_PX,
  PLAN_ZOOM_PERCENT,
  SUBJECT_NAME_LENGTH_CASES,
  WELCOME_NARROW_VIEWPORT,
  WELCOME_SECTION_TAB_NAMES,
  expectSweepCanSeeAForcedOffender,
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
      // The current pre-Cozy UI still references Google Fonts. Phase 1 does
      // not redesign that UI; the test blocks these known static requests and
      // records the exact limitation rather than treating them as app data.
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

test('safe tutorial action renders the default Phaser world with static-only network traffic', async ({
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

interface NarrowViewportCase {
  readonly label: string;
  readonly characters: number;
  readonly reading: HorizontalOverflowReading;
  /** Width of the seeded subject's own selection control, or 0 when unseeded. */
  readonly subjectEntryWidth: number;
  /** The forced-overflow control run against this page. */
  readonly sweepControlSawTheForcedOffender: boolean;
}

/**
 * One measurement, on a device that has genuinely never been used.
 *
 * A fresh context per name length rather than one context re-seeded, because the
 * subject list is read on mount: a seed applied to a page that is already showing
 * the list is a different state from the one that overflows.
 */
async function measureWelcomeShellForNameCase(
  browser: Browser,
  nameCase: SubjectNameCase,
): Promise<NarrowViewportCase> {
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
    await settleLayout(page);

    // Non-vacuity, before the reading that matters: break the page on purpose and
    // require the sweep to notice. A sweep that cannot see an overflow it was
    // handed would make every "no overflow" below meaningless.
    const control = await expectSweepCanSeeAForcedOffender(page);

    const reading = await measureHorizontalOverflow(page);
    return {
      label: nameCase.label,
      characters: nameCase.characters,
      reading,
      subjectEntryWidth,
      sweepControlSawTheForcedOffender: control.seen,
    };
  } finally {
    await context.close();
  }
}

test('the Welcome shell has no horizontal overflow at 320 CSS pixels, at any subject-name length', async ({
  browser,
  page,
}, testInfo) => {
  const cases: NarrowViewportCase[] = [];
  for (const nameCase of SUBJECT_NAME_LENGTH_CASES) {
    cases.push(await measureWelcomeShellForNameCase(browser, nameCase));
  }

  await attachJson(testInfo, 'welcome-narrow-viewport-overflow.json', {
    viewport: WELCOME_NARROW_VIEWPORT,
    planZoomPercent: PLAN_ZOOM_PERCENT,
    note: '200% zoom at a 640 CSS-pixel window is this same 320 CSS-pixel layout viewport.',
    cases: cases.map((entry) => ({
      label: entry.label,
      characters: entry.characters,
      subjectEntryWidth: entry.subjectEntryWidth,
      sweepControlSawTheForcedOffender: entry.sweepControlSawTheForcedOffender,
      ...entry.reading,
    })),
  });

  // ── The control, first, so a false pass is impossible.
  for (const entry of cases) {
    expect(
      entry.sweepControlSawTheForcedOffender,
      `${entry.label}: the overflow sweep did not notice a 1280px box forced into a 320px viewport, so a clean reading from it proves nothing.`,
    ).toBe(true);
  }

  // ── The page fits, at every name length, on both halves of the measurement.
  for (const entry of cases) {
    expect(
      entry.reading.clientWidth,
      `${entry.label}: the reading is not at the plan's viewport width, so it is not the measurement this gate claims to be.`,
    ).toBe(WELCOME_NARROW_VIEWPORT.width);

    expect(
      entry.reading.pageOverflowPx,
      `${entry.label} (${entry.characters} characters): documentElement.scrollWidth ${entry.reading.documentScrollWidth} exceeds clientWidth ${entry.reading.clientWidth}. Offenders: ${entry.reading.offenders
        .map((offender) => `${offender.selector} right=${offender.right} width=${offender.width}`)
        .join('; ')}`,
    ).toBe(0);

    expect(
      entry.reading.offenders,
      `${entry.label} (${entry.characters} characters): elements reach right=${entry.reading.offenders[0]?.right ?? 'none'} past clientWidth=${entry.reading.clientWidth}. Offenders: ${entry.reading.offenders
        .map((offender) => `${offender.selector} right=${offender.right} width=${offender.width}`)
        .join('; ')}`,
    ).toEqual([]);

    // An empty sweep over an empty page is a pass with no content, so the number
    // of elements that were actually measured is asserted too.
    expect(
      entry.reading.measuredElementCount,
      `${entry.label}: the sweep measured no elements at all.`,
    ).toBeGreaterThan(50);
  }

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
