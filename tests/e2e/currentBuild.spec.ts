import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';

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
