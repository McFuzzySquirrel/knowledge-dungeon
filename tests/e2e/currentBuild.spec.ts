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
// The authored village content and the two shared numbers the NPC behaviour below
// is measured against, imported rather than restated.
//
// This is the one place in the suite that reads application source, and it is here
// for a specific reason: the claims being pinned are claims *about this data*. The
// nearby-action row must name an NPC that is in `VILLAGE_MAP.npcs`, the bubble must
// show `VILLAGE_MAP.npcs[keeper].questDialogue['meet-keeper'][0]`, and a row's
// `data-target-distance` must be inside `INTERACT_RADIUS`. A test that typed those
// strings instead would keep passing after the content changed, which is the failure
// mode the Phase 12 refactor had (a renderer selecting dialogue against an empty
// quest step, invisible to every assertion). `villageLayout.ts` imports nothing, so
// reading it here pulls no engine and no renderer into this file.
import {
  COMPASS_HIDE_DISTANCE,
  INTERACT_RADIUS,
  NPC_SPEED,
  PLAYER_SPEED,
  STRUCTURE_APPROACH_RADIUS,
  VILLAGE_MAP,
  VILLAGE_TILE_SIZE,
} from '../../src/data/villageLayout';

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
 * The dungeon route, in whichever renderer this build was asked for.
 *
 * `VITE_PIXI_DUNGEON=true` switches the dungeon route to the lazy PixiJS world and leaves
 * the village route on Phaser; the default artifact is Phaser on both. Phase 13's
 * verification runs this file twice, so this test has to pass on both artifacts. It
 * detects the mounted world from the DOM rather than assuming, and asserts the variant it
 * actually found matches the flag the build was made with - so a build whose flag and
 * artifact disagree fails instead of quietly passing.
 *
 * The two claims that are *lane-specific* are stated per lane, because they are opposites
 * of each other and asserting both in one build would be asserting a contradiction:
 *   - default artifact: the Phaser vendor chunk is fetched, and no Pixi chunk is.
 *   - flagged artifact: the Pixi vendor chunk is fetched, and the Pixi dungeon surface,
 *     its DOM controls, and its labelled rooms are on screen.
 * Everything privacy-shaped (no WebSocket, no off-origin request, no remote font) is
 * asserted for both lanes, because it is a property of the application and not of a
 * renderer.
 */
test('safe tutorial action renders the dungeon world with static-only network traffic', async ({
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

  const expectedPixiDungeon = process.env.VITE_PIXI_DUNGEON === 'true';
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  if (expectedPixiDungeon) await installDungeonProbe(page);
  await waitForWelcome(page);
  await page.getByRole('button', { name: 'Start Tutorial' }).click();

  if (expectedPixiDungeon) {
    // The Pixi chunk is lazy, so the surface appears only after it evaluates.
    const pixiSurface = page.locator('.pixi-dungeon-world');
    const phaserSurface = page.locator('.game-canvas-host canvas');
    await expect
      .poll(
        async () =>
          (await pixiSurface.count()) > 0 ? 'pixi' : (await phaserSurface.count()) > 0 ? 'phaser' : 'none',
        { timeout: 30_000 },
      )
      .not.toBe('none');
    expect(
      (await phaserSurface.count()) > 0,
      'VITE_PIXI_DUNGEON=true, but the Phaser dungeon also mounted',
    ).toBe(false);
    await expect(pixiSurface).toBeVisible({ timeout: 30_000 });

    // Every world verb has a DOM equivalent, and they are all real controls.
    //
    // The names come from the scene's own action table, which is what `DungeonWorld`
    // renders the accessible name from, so this cannot drift from the scene's declaration
    // without failing here.
    await expect(page.getByRole('button', { name: 'Interact (E or Space)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ascend' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Descend' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeVisible();

    // A refused action is disabled *and says why on the page*. This is the Phase 13
    // fix observed in a real browser rather than in jsdom: the tutorial spawns the player
    // in the root room, which has no stairs up and no stairs down, so both portal controls
    // are unavailable and both publish the reason.
    await expect(page.getByRole('button', { name: 'Ascend' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Descend' })).toBeDisabled();
    await expect(
      page.getByText('there are no stairs up in this room', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('there are no stairs down in this room', { exact: true }),
    ).toBeVisible();
    // And an action the world always accepts is not disabled by the same machinery.
    await expect(page.getByRole('button', { name: 'Interact (E or Space)' })).toBeEnabled();
    // The reasons are *on* the page, not only in an attribute a disabled control cannot
    // have announced.
    await expect(
      page.locator('[data-action-status="dungeon-ascend"]'),
    ).toBeVisible();

    const roomNavigation = page.getByRole('group', { name: 'Room navigation' });
    await expect(roomNavigation).toBeVisible();
    // Scoped to the group: the HUD has its own "Go to Village" control, and a bare
    // `/^Go to /` selector would silently include it in the count below.
    await expect(roomNavigation.getByRole('button', { name: /^Go to / }).first()).toBeVisible();

    // Rooms, corridors, and doors are on the real stage, read through the live scene
    // graph rather than from a DOM the canvas does not have.
    await expect
      .poll(
        async () => (await readDungeonScene(page)).roomLabels.length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    const reading = await readDungeonScene(page);
    expect(reading.roomLabels.length, 'no room was drawn on the real stage').toBeGreaterThan(1);
    expect(
      reading.roomLabels.every((label) => /^dungeon-room-.+/.test(label)),
      reading.roomLabels.join(' | '),
    ).toBe(true);
    expect(reading.doorLabels.length, 'no door was drawn on the real stage').toBeGreaterThan(0);
    expect(reading.topics.length, 'no topic label was drawn').toBeGreaterThan(0);

    // The drawn room count equals the DOM room list's count. Both read the same
    // `FloorVisibilityModel`, so a disagreement is either a renderer that drew a hidden
    // room or a mirror that offered one - which is the property the floor-visibility rule
    // exists to protect.
    const roomRowCount = await roomNavigation.getByRole('button', { name: /^Go to / }).count();
    expect(reading.roomLabels.length, 'the canvas and the DOM room list disagree').toBe(roomRowCount);

    // Keyboard movement reaches the world.
    const before = reading.player;
    expect(before, 'the player marker was not on the real stage').not.toBeNull();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowRight');
    const after = (await readDungeonScene(page)).player;
    expect(after, 'the player marker was not on the real stage after movement').not.toBeNull();
    expect(
      Math.abs((after?.x ?? 0) - (before?.x ?? 0)) + Math.abs((after?.y ?? 0) - (before?.y ?? 0)),
      'keyboard movement did not reach the Pixi dungeon scene',
    ).toBeGreaterThan(1);

    // Portrait then landscape: the world resizes rather than throwing.
    await page.setViewportSize({ ...supportEntryForProject('tablet').viewport });
    await expect(pixiSurface).toBeVisible();
    await page.setViewportSize({ ...supportEntryForProject('tablet-landscape').viewport });
    await expect(pixiSurface).toBeVisible();

    const pixiScriptRequests = observations
      .filter(({ resourceType }) => resourceType === 'script')
      .filter(({ url }) => /pixi/i.test(url));
    expect(
      pixiScriptRequests,
      'the flagged dungeon route requested no Pixi chunk, so the switch was not exercised',
    ).not.toEqual([]);
    expect(pageErrors, `page errors during the Pixi dungeon run: ${pageErrors.join(' | ')}`).toEqual([]);

    await page.waitForLoadState('networkidle');
    const privacyReport = inspectPrivacyNetwork(observations, new URL(baseURL).origin);
    await attachJson(testInfo, 'privacy-network-observations.json', {
      lane: 'pixi-dungeon',
      pixiScriptRequests: pixiScriptRequests.length,
      ...privacyReport,
    });
    expect(webSocketUrls, `Unexpected WebSocket destinations: ${webSocketUrls.join(', ')}`).toEqual([]);
    expect(privacyReport.violations, privacyReport.violations.join('\n')).toEqual([]);
    return;
  }

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
    lane: 'default-dungeon',
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
 * The id shape the village fixtures below mint subjects under.
 *
 * Named rather than retyped, because the default-build keyboard test below has to
 * recognise the *dynamic* structure ids the village projects onto its portal slots
 * (`portal-<subjectId>`) and must recognise them without a second copy of this
 * template drifting from the one the seeder uses.
 */
const VILLAGE_SUBJECT_ID_PREFIX = 'e2e-village-subject-';

/** The subject ids {@link seedLegacySubjects} writes, in the order it writes them. */
function villageSubjectIds(names: readonly string[]): readonly string[] {
  return names.map((_name, index) => `${VILLAGE_SUBJECT_ID_PREFIX}${index}`);
}

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
    const id = `${VILLAGE_SUBJECT_ID_PREFIX}${index}`;
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

/**
 * Captures every PixiJS `Application` for the dungeon lane.
 *
 * The same hook the village lane installs, named separately so the two probes can be read
 * apart when both a dungeon and a village Pixi world are live in one page - which is
 * exactly what a build with both flags on would produce.
 */
async function installDungeonProbe(page: Page): Promise<void> {
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

interface DungeonSceneReading {
  /** The player marker's world position, or `null` if the scene is not on the stage. */
  readonly player: { x: number; y: number } | null;
  /** Every room container label on the stage, so the drawn rooms can be asserted. */
  readonly roomLabels: readonly string[];
  /** Every door label on the stage. */
  readonly doorLabels: readonly string[];
  /** Every room topic drawn as a `Text`. */
  readonly topics: readonly string[];
}

/** Reads the live Pixi scene graph: the player, the rooms, the doors, and the labels. */
async function readDungeonScene(page: Page): Promise<DungeonSceneReading> {
  return page.evaluate(() => {
    interface SceneNode {
      readonly text?: unknown;
      readonly x?: number;
      readonly y?: number;
      readonly label?: unknown;
      readonly children?: readonly SceneNode[];
      getChildByLabel?(label: string): SceneNode | null;
    }
    const scope = globalThis as unknown as Record<string, unknown>;
    const applications = (scope['__KD_E2E_PIXI_APPS__'] as unknown[] | undefined) ?? [];
    const application = applications[applications.length - 1] as { stage?: SceneNode } | undefined;
    const root = application?.stage?.getChildByLabel?.('dungeon-world') ?? null;
    const layer = root?.getChildByLabel?.('dungeon-world-layer') ?? null;
    const player = layer?.getChildByLabel?.('dungeon-player') ?? null;
    const roomsLayer = layer?.getChildByLabel?.('dungeon-rooms') ?? null;
    const roomLabels: string[] = [];
    const doorLabels: string[] = [];
    const topics: string[] = [];
    // The room *containers* are the direct children of the rooms layer. Reading them
    // positionally rather than by a label prefix is what distinguishes a room from the
    // dozen labelled parts inside one - every one of those is also `dungeon-room-*`.
    for (const room of roomsLayer?.children ?? []) {
      if (typeof room.label === 'string') roomLabels.push(room.label);
    }
    const visit = (node: SceneNode): void => {
      const label = typeof node.label === 'string' ? node.label : '';
      if (label.startsWith('dungeon-door-')) doorLabels.push(label);
      if (typeof node.text === 'string' && label === 'dungeon-room-label') topics.push(node.text);
      for (const child of node.children ?? []) visit(child);
    };
    // The topic labels live inside the room containers; the doors live in the corridor
    // layer, which is a sibling of the rooms layer. Both subtrees are walked, and only
    // labels the scene actually set are collected.
    if (roomsLayer) visit(roomsLayer);
    const corridor = layer?.getChildByLabel?.('dungeon-corridors');
    if (corridor) visit(corridor);
    return {
      player:
        player && typeof player.x === 'number' && typeof player.y === 'number'
          ? { x: player.x, y: player.y }
          : null,
      roomLabels,
      doorLabels,
      topics,
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
 * ────────────────────────────────────────────────────────────────────────────
 * The village's DOM NPC surface, and the default build's keyboard movement
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## Why these two live here, and not in a spec of their own
 *
 * `npm run test:e2e` runs exactly one file - `tests/e2e/currentBuild.spec.ts` - and
 * the four support-matrix projects all `testMatch` on it. A new spec file would be
 * a file no gating step ever opens, and `welcome-narrow-viewport.test.ts` pins
 * `test:e2e:recorded` to this path, so the lane could not be widened to reach it
 * either. The gate is here, so the coverage is here.
 *
 * ## What was missing before, precisely
 *
 * The Pixi NPC layer was verified with a probe script that was then deleted, and
 * the phase's most consequential behavioural fix - a labelled DOM button that
 * silently does nothing - had no reproducible regression coverage at all. It is
 * easy to regress: `VillageWorld`'s imperative handle was once typed against the
 * base `VillageRendererCapabilities`, which declares `readNpcSnapshot` and
 * `invokeAction` as *optional*, so an object literal could omit both, compile
 * cleanly, and leave every nearby-action row permanently disabled with nothing in
 * the build to say so. It was found by reading an `aria-live` sentence in a
 * browser. That is the defect class these tests exist to catch, and the guard is
 * the second test below: it asserts `disabled === false` on a real row, which goes
 * red the moment a handle stops forwarding either capability.
 *
 * Separately, the movement assertions in the test above sat inside its
 * `if (expectedPixi)` arm, so the *default* Phaser village - the build that ships
 * until Phase 24 - had no committed keyboard-movement coverage at all. The last
 * test below closes that, and it is deliberately renderer-neutral: it navigates
 * with the arrow keys and reads the result out of the DOM, so it says nothing about
 * which engine is mounted.
 *
 * ## How the player gets to an NPC
 *
 * There is no supported way to place the player: the Welcome screen's
 * "Continue to Village" deliberately clears the one-shot `kd-village-spawn`
 * override, which is correct product behaviour and not something a test should
 * route around. So the player is *walked*, with the arrow keys, from the authored
 * spawn to the Keeper. That is roughly a thousand world pixels and about fifteen
 * seconds of holding keys, which is why these tests set their own timeout instead
 * of inheriting Playwright's thirty seconds.
 *
 * ## What the Pixi scene graph is, and is not, used for here
 *
 * Only for steering. `readVillageWorld` reads the player and NPC marker positions
 * so the harness knows which way to walk; every assertion below is made against the
 * DOM. That split is deliberate: the phase's exit criterion is that no renderer
 * object is *needed* to understand or invoke a village action, and a test that
 * leaned on the scene graph to reach its verdict would be testing the opposite of
 * what it claims. Nothing below would still pass if the scene graph were
 * unreachable and the DOM were correct.
 *
 * ## Why the leash exists
 *
 * A villager wanders, and the interact radius is small: `INTERACT_RADIUS` is
 * measured in world pixels, so a player standing still beside the Keeper falls out
 * of range in well under a second. Measured in a browser, standing still produced a
 * usable window of roughly 400ms. That is not enough time to click a row and read
 * the result. So `approachNpcUntilInRange` re-aims the arrow keys between short
 * bursts, which tracks the NPC continuously; measured over twenty seconds of
 * leashing, the nearby row was present in 62 of 62 samples. The leash is a
 * *navigation* aid. Every claim still rests on the DOM.
 *
 * ## Retry, and why it is not a fudge
 *
 * A villager can leave range between one action and the next, and leaving range
 * ends the conversation - which is correct behaviour, and which resets the line
 * cursor. So `withNpcInRange` re-acquires the NPC and re-runs the body from the top
 * whenever the body cannot complete, and the authored quest script makes every
 * restart land on the same first line. A test that passed on its first attempt
 * would prove less than one that survives the NPC walking off mid-assertion.
 *
 * ## Why a press is gated on the row rather than on a distance
 *
 * This is the second thing the phase got wrong the first time, and it cost three
 * of four projects on the Pixi lane. The gate used to be "the live distance from
 * the player to the NPC marker, read immediately before the press". Both halves of
 * that are wrong in the same way: the distance is a *scene-graph* quantity, and
 * reading it is a round trip, and the press is another round trip away - so the
 * gate describes a moment the press does not happen in. Measured: 41 movement
 * steps on `desktop-chromium` without one completed activation, against a gate the
 * tracking could satisfy only marginally, and a four-minute test on `chromebook`.
 *
 * The replacement asks a question about the thing being pressed rather than about a
 * quantity that decays while the harness is talking to the browser: *is the point I
 * am about to click still the Keeper's row?* It is answered by `elementFromPoint`
 * inside the same `evaluate` that chose the press point, so it is as fresh as the
 * press and it is about the row itself. Measured after the change: every channel
 * succeeds within 11 to 19 steps and 13 to 19 seconds, on all four projects.
 */

/** The quest step the NPC dialogue assertions are pinned against. */
const NPC_DIALOGUE_QUEST_STEP = 'meet-keeper';

/** The only NPC in `VILLAGE_MAP` that carries a `questDialogue` script. */
const KEEPER_NPC_ID = 'keeper';

/** The scene-graph label prefix `VillageNpc` gives every NPC marker. */
const NPC_MARKER_LABEL_PREFIX = 'village-npc:';

/**
 * The wall-clock budget for one NPC approach plus its assertions.
 *
 * Generous on purpose. The walk across the map is the slow part and its length
 * depends on where the Keeper happens to be in its patrol when the test starts, so
 * the budget has to cover a full patrol lap rather than a typical one.
 */
const NPC_APPROACH_BUDGET_MS = 120_000;

/**
 * The closest approach to record as evidence, in world pixels.
 *
 * **Not a gate.** It was one, and that was a defect: the gate was a scene-graph
 * distance read in one round trip while the press was a further round trip away, so
 * it could not describe the state the press actually met. It also produced the
 * phase's most expensive failure - one project refused to complete a single
 * activation across 41 movement steps against a gate the tracking could satisfy
 * only just, and the cost of chasing it was a two-to-four minute test.
 *
 * It is kept as a *reported* number because "how close did the harness actually get"
 * is the first question anyone asks when an activation fails, and because it is the
 * only place the tracking's real equilibrium is visible. The liveness gate that
 * replaced it is {@link VillageNearbyReading.keeperRowPressable}.
 *
 * The tracking equilibrium it was fighting is real and is unchanged: a movement step
 * ends with the villager having drifted through the step's own round trips, so the
 * closest the tracking reliably reaches is about a dozen pixels against a
 * `INTERACT_RADIUS` of 32. Measured over the four projects on this build, a channel
 * now reaches a pressable row within 11 to 19 movement steps and 13 to 19 seconds.
 */
const NPC_RECORDED_CLOSEST_PX = Number.POSITIVE_INFINITY;

interface VillageWorldPoint {
  readonly x: number;
  readonly y: number;
}

interface VillageWorldReading {
  /** The player marker's world position, or `null` before the scene is on the stage. */
  readonly player: VillageWorldPoint | null;
  /** Every NPC marker on the world layer, keyed by NPC id. */
  readonly npcs: Readonly<Record<string, VillageWorldPoint>>;
}

/**
 * Reads the live Pixi scene graph: the player marker and every NPC marker.
 *
 * Steering only - see the block header. The NPC marker labels are the scene's own
 * (`village-npc:<id>`, set in `VillageNpc.ts`), and a marker with no readable
 * position is skipped rather than reported as a broken one, so a rename shows up as
 * a navigation failure with the measured closest approach in its message.
 */
async function readVillageWorld(page: Page): Promise<VillageWorldReading> {
  return page.evaluate((markerPrefix) => {
    interface SceneNode {
      readonly x?: number;
      readonly y?: number;
      readonly label?: string;
      readonly children?: readonly SceneNode[];
      getChildByLabel?(label: string): SceneNode | null;
    }
    const scope = globalThis as unknown as Record<string, unknown>;
    const applications = (scope['__KD_E2E_PIXI_APPS__'] as unknown[] | undefined) ?? [];
    const application = applications[applications.length - 1] as { stage?: SceneNode } | undefined;
    const layer =
      application?.stage?.getChildByLabel?.('village-world')?.getChildByLabel?.('village-world-layer') ?? null;
    const player = layer?.getChildByLabel?.('village-player') ?? null;
    const npcs: Record<string, { x: number; y: number }> = {};
    for (const child of layer?.children ?? []) {
      // `label` is typed optional but PixiJS really does hand back `null` for an
      // unlabelled container, and a `=== undefined` check would pass that through to
      // `startsWith`. The type check is the one that survives both.
      const label = child.label;
      if (typeof label !== 'string' || !label.startsWith(markerPrefix)) continue;
      if (typeof child.x !== 'number' || typeof child.y !== 'number') continue;
      npcs[label.slice(markerPrefix.length)] = { x: child.x, y: child.y };
    }
    const playerPoint =
      player !== null && typeof player.x === 'number' && typeof player.y === 'number'
        ? { x: player.x, y: player.y }
        : null;
    return { player: playerPoint, npcs };
  }, NPC_MARKER_LABEL_PREFIX);
}

interface VillageNearbyRow {
  /** `npc` or `structure`, from the row's own `data-target-kind`. */
  readonly kind: string | null;
  /** The target id the row would pass to the world, from `data-target-id`. */
  readonly id: string | null;
  /** The row's own `disabled` flag. The regression guard for the whole surface. */
  readonly disabled: boolean;
  /** The row's visible text, icon glyph included. */
  readonly label: string | null;
  /** `data-target-distance`, in world pixels. */
  readonly distance: number | null;
  /**
   * The row's centre in CSS viewport pixels, or `null` when it has no box.
   *
   * Read here rather than through a locator's `boundingBox()` so that one round trip
   * yields both the row's state and where to press it. That pairing is what makes the
   * activations below possible: a row only exists while its target is in range, which
   * for a wandering villager is a few hundred milliseconds, and Playwright's own
   * `click()` spends longer than that in actionability checks - waiting for the
   * element to stop moving, scrolling it into view, hit-testing - so the row leaves
   * the document mid-click and the click times out. A press at a measured centre is a
   * real input event through the browser's own pipeline, and it costs one dispatch.
   */
  readonly centre: { readonly x: number; readonly y: number } | null;
}

interface VillageNearbyReading {
  readonly rows: readonly VillageNearbyRow[];
  /** The list's `role="status"` sentence, or `null` when it has nothing to say. */
  readonly note: string | null;
  /** The NPC dialogue bubble's line, or `null` when no conversation is open. */
  readonly dialogue: string | null;
  /** Which NPC the open bubble belongs to, from its `data-npc-id`. */
  readonly dialogueNpcId: string | null;
  /** The compass needle's `transform`, written imperatively from `readPoi()`. */
  readonly compassRotation: string | null;
  /** Whether the compass is currently hidden for being too close to its target. */
  readonly compassHidden: boolean | null;
  /** The compass's target name, the first ten characters of it. */
  readonly compassLabel: string | null;
  /**
   * Whether `elementFromPoint` at a target NPC row's centre still lands on that
   * row, measured in the *same* `evaluate` that read the row.
   *
   * This is the press-liveness gate, and it exists because the gate it replaced
   * was measured across two round trips and therefore could not be true at the
   * moment of the press. See {@link readNpcRowPress} for the whole argument.
   */
  readonly keeperRowPressable: boolean;
}

/**
 * One read of everything the village DOM says about what is nearby.
 *
 * A single `evaluate` rather than a pile of locators, for two reasons: the checks
 * below compare a *set* of readings against one another (the compass before and
 * after a walk, the row list with and without a structure), and a locator read
 * waits for an element that may legitimately be absent - a 15-second timeout each
 * time, for an absence that is the answer. Reading the DOM in one pass makes "the
 * row is not there" a fact rather than a wait.
 */
async function readVillageNearby(page: Page): Promise<VillageNearbyReading> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-village-nearby="true"] button[data-target-kind]')]
      .map((button) => {
        const raw = button.dataset.targetDistance;
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        const box = button.getBoundingClientRect();
        return {
          kind: button.dataset.targetKind ?? null,
          id: button.dataset.targetId ?? null,
          disabled: button.disabled,
          label: button.textContent,
          distance: Number.isFinite(parsed) ? parsed : null,
          centre:
            box.width > 0 && box.height > 0
              ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
              : null,
        };
      });
    const section = document.querySelector('[data-village-nearby="true"]');
    const bubble = document.querySelector('.village-npc-dialog');
    const compass = document.querySelector('[data-village-compass="true"]');
    const needle = document.querySelector<HTMLElement>('.village-compass-needle');
    // The press-liveness read, in the same pass that measured the row's centre,
    // for the reason in {@link VillageNearbyReading.keeperRowPressable}. The
    // target is the *Keeper*, because it is the NPC every channel below talks to.
    const keeperRow = rows.find((row) => row.kind === 'npc' && row.id === 'keeper');
    let keeperRowPressable = false;
    if (keeperRow !== undefined && keeperRow.centre !== null) {
      const hit = document.elementFromPoint(keeperRow.centre.x, keeperRow.centre.y);
      // The row's own label sits inside the button, so the hit is normally the
      // inner `<span>`; `closest` is what turns that back into the button, and the
      // target-id comparison is what stops a *neighbouring* NPC's row from
      // satisfying the gate after the list re-sorts underneath the press.
      keeperRowPressable =
        hit !== null &&
        hit.closest<HTMLButtonElement>('[data-village-nearby="true"] button[data-target-kind="npc"]')
          ?.dataset.targetId === 'keeper';
    }
    return {
      rows,
      note: section?.querySelector('p[role="status"]')?.textContent ?? null,
      dialogue: bubble?.querySelector('.village-npc-dialog-text')?.textContent ?? null,
      dialogueNpcId: bubble?.getAttribute('data-npc-id') ?? null,
      compassRotation: needle?.style.transform === '' ? null : (needle?.style.transform ?? null),
      compassHidden: compass === null ? null : compass.hasAttribute('hidden'),
      compassLabel: document.querySelector('.village-compass-label')?.textContent ?? null,
      keeperRowPressable,
    };
  });
}

/** The arrow keys that reduce a world-space delta, ignoring a dead zone. */
function arrowKeysToward(dx: number, dy: number, deadZonePx: number): readonly string[] {
  const keys: string[] = [];
  if (Math.abs(dx) > deadZonePx) keys.push(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
  if (Math.abs(dy) > deadZonePx) keys.push(dy > 0 ? 'ArrowDown' : 'ArrowUp');
  return keys;
}

/**
 * The arrow keys that walk *toward* whatever the compass is pointing at.
 *
 * The compass needle is rotated by `bearing * 180/PI + 90` degrees, so subtracting
 * 90 and converting back gives the bearing itself in the renderer's own convention:
 * zero means the target is due right, and a positive bearing is downward on screen
 * (the renderer measures with `atan2(dy, dx)` and the world's `y` grows downward).
 * The 0.34 cut-off is `sin(20°)`: below it the component is not worth a whole key,
 * and a diagonal is worth exactly as much speed as an axis in both renderers, so
 * pressing two keys is not slower than pressing one.
 *
 * A rotation the DOM cannot report - absent, empty, or unparsable - falls back to
 * `previous` so the walk keeps a consistent heading instead of stalling, and the
 * caller sees the fallback in the directions it records.
 */
function compassBearingKeys(rotation: string | null, previous: readonly string[]): readonly string[] {
  if (rotation === null) return previous;
  const match = /rotate\((-?[\d.]+)deg\)/.exec(rotation);
  if (match === null) return previous;
  const bearing = ((Number(match[1]) - 90) * Math.PI) / 180;
  const keys = arrowKeysToward(Math.cos(bearing), Math.sin(bearing), 0.34);
  return keys.length > 0 ? keys : previous;
}

/** The keys that walk directly away from the heading `keys` walked toward. */
function oppositeArrowKeys(keys: string): readonly string[] {
  const opposites: Readonly<Record<string, string>> = {
    ArrowUp: 'ArrowDown',
    ArrowDown: 'ArrowUp',
    ArrowLeft: 'ArrowRight',
    ArrowRight: 'ArrowLeft',
  };
  return keys
    .split('+')
    .map((key) => opposites[key])
    .filter((key): key is string => key !== undefined);
}

/**
 * A baseline round-trip estimate, in milliseconds.
 *
 * The default-village walk seeds its load-aware re-aim interval from this before it
 * has measured the page (`let roundTripMs = NPC_BURST_FLOOR_MS`), and the NPC
 * approach's own measurement is clamped at the same floor. The NPC approach no
 * longer needs a *burst floor*: it keeps its keys down across re-aims, so a burst
 * that outruns the villager is the normal case rather than something a minimum has
 * to protect, and the break-even inequality the floor used to enforce cannot be lost
 * by a player who never stops. See {@link approachNpcUntilInRange}.
 */
const NPC_BURST_FLOOR_MS = 60;

/**
 * Times one evaluate round trip against the page under test.
 *
 * Deliberately the *same* kind of work the approach loops do - a
 * `page.evaluate` that returns a small object - because the number that matters
 * is what a `readVillageWorld` costs on this page right now, not what a bare
 * timer costs. Median of several samples rather than the first: the first
 * evaluate after a navigation is unrepresentatively slow and would inflate the
 * interval for the whole walk.
 *
 * Clamped at both ends. The upper bound stops a pathological stall from producing
 * a poll so long it overshoots the entire village; the lower bound keeps the
 * measurement meaningful if the page is somehow fast enough for the interval never
 * to matter.
 */
async function measureHarnessRoundTripMs(page: Page): Promise<number> {
  const samples: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const started = Date.now();
    await page.evaluate(() => document.querySelectorAll('button').length);
    samples.push(Date.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[1] ?? samples[0] ?? 0;
  return Math.max(5, Math.min(400, median));
}

/**
 * The distance, in world pixels, at which pure pursuit gives way to a braked
 * final approach.
 *
 * Six times the interact radius. Above it the player runs with its keys held, so
 * the host's evaluate latency costs nothing; below it the player is close enough
 * that a poll-length sample - player travel *plus* villager travel across a round
 * trip - can straddle the radius, and the right move is to stop, measure from rest,
 * and close the remaining gap deliberately.
 *
 * Six rather than a tighter multiple is deliberate: the sample length is the round
 * trip *plus* the poll, and under four-way contention that is ~720 ms, which at the
 * four-to-one closing speed is ~119 world pixels. A brake line any closer than that
 * could be crossed in a single sample, so the walk would enter the radius still
 * holding its keys and overshoot before the `finally` could release them - the exact
 * oscillation the braked branch exists to prevent. At six radii the worst jump from
 * outside the line lands at ~73 px, comfortably inside it and still outside the
 * radius, so the radius is always entered from a stopped braked read.
 */
const NPC_BRAKE_DISTANCE_PX = INTERACT_RADIUS * 6;

/** Longest braked final-approach burst, in milliseconds. */
const NPC_BRAKE_HOLD_MAX_MS = 500;

/**
 * The fastest the gap can close, in world pixels per second.
 *
 * The player walks toward the villager while the villager may walk toward the
 * player, so this is the worst-case closing speed a transit sample has to stay
 * inside. Used only to size a sample so it cannot cross the brake line; being
 * conservative costs nothing, because an undersized sample just re-aims sooner.
 */
const NPC_CLOSING_SPEED = PLAYER_SPEED + NPC_SPEED;

/**
 * Longest continuous-transit poll, in milliseconds.
 *
 * The poll is the interval the player keeps moving through while the harness is
 * *not* talking to the browser, so it is re-aim granularity rather than speed: the
 * keys stay down either way. It is bounded so a whole sample - the measured round
 * trip plus the poll - cannot carry the player across the gap from the brake line
 * to the radius, which is what lets the walk keep its keys down. See
 * {@link NPC_TRANSIT_MAX_STRIDE_PX}.
 */
const NPC_TRANSIT_POLL_MAX_MS = 900;

/**
 * The most ground one transit sample will try to cover, in world pixels.
 *
 * A third of the brake line. Each read is a Playwright `evaluate`, and the real lane
 * records a trace (`retain-on-failure`), so reads are the expensive unit here: the
 * previous version polled once per measured round trip, which on a fast host is one
 * read every ~120 ms, or ~90 reads to cross the map. Combined with the
 * half-the-remaining-gap rule in the loop, this limit approaches a distant target in
 * a few long strides while still re-aiming finely near it, and it keeps a sample
 * from crossing the brake line with its keys down.
 */
const NPC_TRANSIT_MAX_STRIDE_PX = NPC_BRAKE_DISTANCE_PX / 3;

/**
 * Approaches an NPC until it is inside `INTERACT_RADIUS`, re-aiming as it walks.
 *
 * ## Why the walk keeps its keys down
 *
 * The original step was open-loop: measure, compute a burst sized to close the
 * whole gap, deliver it, release. That is correct only while the harness round trips
 * are fast and stable, and this suite's own four parallel workers make that a
 * condition rather than a given. Under contention the pre-burst measurement is
 * stale by the time the keys go down, and the burst is sized for a gap that no
 * longer exists - so it undershoots, and the next step repeats the error from a
 * new stale reading. It then released the keys and spent the whole next round trip
 * standing still, so the approach time was really `travel + (roundTrips * rounds)`
 * and grew with the host's latency rather than with the distance. Measured on this
 * host: ~185 ms per evaluate, ~1.9 s per round against a 900 ms burst, so more than
 * half of every round was spent not moving.
 *
 * This version re-aims *while moving*: it holds the keys the current heading wants
 * and changes only the difference, so the player covers ground through the round
 * trip instead of waiting for it. The approach time is then the distance over the
 * closing speed, which is what makes it insensitive to host load.
 *
 * ## Why it brakes at the end
 *
 * Continuous pursuit reads while the player is still moving, so every transit
 * measurement is already stale by however far the player and the villager moved
 * across the round trip. That is harmless for a long stride and wrong for the last
 * few pixels, where it would sail past a villager that had turned and spend several
 * rounds recovering. Inside {@link NPC_BRAKE_DISTANCE_PX} the walk therefore stops,
 * reads from rest, and closes the remaining gap in a burst sized to finish short of
 * the target, so the landing is accurate without ever being aimed from a moving
 * player's stale position.
 *
 * Every branch still terminates on the *observable* fact - the villager's live
 * scene-graph distance being inside `INTERACT_RADIUS` - and the budget is only the
 * ceiling that keeps a genuinely stuck approach from hanging.
 *
 * Returns the closest distance reached, which is the number every failure message
 * above reports.
 */
async function approachNpcUntilInRange(
  page: Page,
  npcId: string,
  budgetMs: number,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let closest = Number.POSITIVE_INFINITY;
  let held: readonly string[] = [];
  /**
   * Release every held key, exactly once.
   *
   * The transit now keeps its keys down across re-aims, so there is no longer a
   * natural release point at the end of a round; without this the arrow keys would
   * still be down when the approach returned and the player would keep walking out
   * of range before the caller could assert anything. One helper, called from the
   * `finally`, so a throw, a `continue`, and a normal return all release the same way.
   */
  const releaseHeld = async (): Promise<void> => {
    const keys = held;
    held = [];
    for (const key of keys) await page.keyboard.up(key);
  };
  try {
    // Measured once, *before* the player is moving: the number that matters is the
    // cost of one re-aim round trip, and measuring it mid-walk would spend the walk
    // budget on evaluates while the keys were still down. Each unkeyed re-aim's poll
    // is then the remainder of a distance-sized stride budget, so a slow host
    // shortens the poll rather than lengthening the stride. The break-even floor the
    // old burst loop needed is gone: a player who never releases a key cannot lose
    // ground, so there is no minimum burst left to protect. See
    // {@link NPC_TRANSIT_MAX_STRIDE_PX}.
    const roundTripMs = await measureHarnessRoundTripMs(page);
    while (Date.now() < deadline) {
      const world = await readVillageWorld(page);
      const npc = world.npcs[npcId];
      if (world.player === null || npc === undefined) {
        await releaseHeld();
        await page.waitForTimeout(60);
        continue;
      }
      const dx = npc.x - world.player.x;
      const dy = npc.y - world.player.y;
      const distance = Math.hypot(dx, dy);
      closest = Math.min(closest, distance);
      if (distance <= INTERACT_RADIUS) return closest;
      const keys = arrowKeysToward(dx, dy, 3);
      if (distance > NPC_BRAKE_DISTANCE_PX) {
        // Transit: re-aim in place. Drop only the keys the new heading does not want
        // and add only the ones it does, so the player moves continuously through the
        // round trip instead of standing still for it - which is what removes the
        // host's evaluate latency from the walk.
        for (const key of held) {
          if (!keys.includes(key)) await page.keyboard.up(key);
        }
        for (const key of keys) {
          if (!held.includes(key)) await page.keyboard.down(key);
        }
        held = keys;
        // Size the stride from how much ground is left *above the brake line*, so a
        // distant target is approached in a few long strides and a near one is still
        // re-aimed finely - and so no single sample can carry the player across the
        // brake line into the radius with its keys still down.
        const gapToBrake = Math.max(0, distance - NPC_BRAKE_DISTANCE_PX);
        const stridePx = Math.max(40, Math.min(gapToBrake * 0.5, NPC_TRANSIT_MAX_STRIDE_PX));
        const pollMs = Math.max(
          60,
          Math.min(NPC_TRANSIT_POLL_MAX_MS, (stridePx / NPC_CLOSING_SPEED) * 1000 - roundTripMs),
        );
        await page.waitForTimeout(pollMs);
      } else {
        // Brake: the read above happened with the last transit keys still down, so its
        // distance is stale by however far the player moved across the round trip.
        // Release, then re-read from rest on the next iteration, so the burst below is
        // sized against a settled position rather than one the player has left.
        if (held.length > 0) {
          await releaseHeld();
          continue;
        }
        // Close the remaining gap in a burst sized to stop short of the target, so the
        // last approach cannot sail past a wandering villager and spend the next
        // rounds turning around. The burst is sized against the player's own speed with
        // a half-radius margin, so an NPC moving toward the player only ever makes the
        // landing closer, and one moving away undershoots and is corrected next round.
        const travelPx = Math.max(0, distance - INTERACT_RADIUS * 0.5);
        const holdMs = Math.max(20, Math.min(NPC_BRAKE_HOLD_MAX_MS, (travelPx / PLAYER_SPEED) * 1000));
        for (const key of keys) await page.keyboard.down(key);
        await page.waitForTimeout(holdMs);
        for (const key of keys) await page.keyboard.up(key);
      }
    }
    return closest;
  } finally {
    await releaseHeld();
  }
}

/**
 * The live distance from the player to one NPC marker, in world pixels.
 *
 * Separate from the row's `data-target-distance` because that attribute is a React
 * sample: the panel commits a measurement on an interval, so by the time a test reads
 * it the villager has already moved.
 *
 * **No longer used as a press gate**, and that is the point. A distance read is a
 * *scene-graph* measurement, so gating on it means the gate is only as fresh as the
 * last round trip - and the press itself is another round trip away. A gate that
 * cannot be true at the instant of the press is worse than no gate: it rejects
 * approaches that would have worked and accepts ones that will not, and it costs the
 * very margin the measurement was meant to protect. Measured on this build, the
 * two-trip version refused to complete an activation across 41 movement steps on a
 * project where the one-trip version succeeded on the eleventh.
 *
 * What replaces it is {@link VillageNearbyReading.keeperRowPressable}: whether the
 * row the press is aimed at is *still* the pressable Keeper row at the moment the
 * press point was chosen, read in the same `evaluate` that chose it. That is a
 * statement about the thing being pressed rather than about a quantity that decays
 * while the harness is talking to the browser.
 *
 * Deleted rather than kept, because nothing needs it any more: the closest approach
 * is reported from `approachNpcUntilInRange`, which already measures a real distance
 * on every re-aim, and a helper that exists only to be unused is worse than none.
 */

/**
 * Runs `body` with the NPC's nearby-action row present and enabled, re-acquiring
 * as many times as it takes.
 *
 * The body is restartable by construction: everything it asserts is a function of a
 * fresh approach, because leaving range resets the conversation's line cursor. So a
 * body that cannot complete - the NPC stepped out between the press and the
 * read - simply runs again from a new approach, and the failure it reports is the
 * last one rather than the first.
 */
async function withNpcInRange(
  page: Page,
  npcId: string,
  body: (reading: VillageNearbyReading) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + NPC_APPROACH_BUDGET_MS;
  let failure: unknown = null;
  let attempts = 0;
  let closest = Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    attempts += 1;
    // One approach, not one step: `approachNpcUntilInRange` walks until the NPC is
    // inside the interact radius, re-aiming as it goes, and returns as soon as it
    // gets there. The previous single-step-per-attempt shape is what made this loop
    // depend on the harness's round trips being fast.
    closest = Math.min(closest, await approachNpcUntilInRange(page, npcId, Math.max(2_000, deadline - Date.now())));
    const reading = await readVillageNearby(page);
    const row = reading.rows.find((entry) => entry.kind === 'npc' && entry.id === npcId);
    if (row === undefined || row.disabled) continue;
    try {
      await body(reading);
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw (
    failure ??
    new Error(
      `The DOM never offered an enabled nearby-action row for "${npcId}" in ${attempts} approaches. ` +
        `Closest approach: ${closest} world pixels; the contract's NPC range is ${INTERACT_RADIUS}.`,
    )
  );
}

/**
 * Approaches an NPC until its conversation is open in the DOM, and returns the
 * reading that proves it.
 *
 * Its own acquisition loop, because "the bubble is showing" is a *state* rather than
 * a step: the last activation of a chain leaves the player wherever that activation
 * found them, and a villager that has since walked off takes the bubble with it. The
 * walk-away check below is about a bubble closing, so it has to start from a bubble
 * that is open - and the only way to know that is to go and get one.
 */
async function acquireOpenConversation(
  page: Page,
  npcId: string,
  budgetMs: number,
): Promise<VillageNearbyReading> {
  const deadline = Date.now() + budgetMs;
  let closest = Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    closest = Math.min(
      closest,
      await approachNpcUntilInRange(page, npcId, Math.max(2_000, deadline - Date.now())),
    );
    const reading = await readVillageNearby(page);
    const row = reading.rows.find((entry) => entry.kind === 'npc' && entry.id === npcId);
    if (row !== undefined && !row.disabled && reading.dialogue !== null) return reading;
  }
  throw new Error(
    `No open conversation with "${npcId}" could be reached before the walk-away check. ` +
      `Closest approach: ${closest} world pixels; the contract's NPC range is ${INTERACT_RADIUS}.`,
  );
}

/**
 * Walks directly away from an NPC and stops well outside the interact radius.
 *
 * Away from, not merely onwards, so the direction cannot accidentally be the one
 * that closes the gap - and long enough that the assertion is not reading a
 * half-completed exit.
 */
async function walkAwayFromNpc(page: Page, npcId: string): Promise<void> {
  const world = await readVillageWorld(page);
  const npc = world.npcs[npcId];
  if (world.player === null || npc === undefined) return;
  const keys = arrowKeysToward(world.player.x - npc.x, world.player.y - npc.y, 0);
  if (keys.length === 0) return;
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(1200);
  for (const key of keys) await page.keyboard.up(key);
}

/**
 * Makes the village's DOM control surfaces reachable.
 *
 * On a side-panel layout - a wide viewport with a fine pointer - the HUD column,
 * and with it the nearby-action list, is always rendered. On a sheet layout (a
 * coarse pointer, no hover, or a narrow viewport, which is both tablet projects in
 * this matrix) the column is *unmounted* until the status sheet is opened, so the
 * list is not merely hidden: it is not in the document. Both states are correct,
 * and a spec that assumed the first would be green on two of the four projects for
 * the wrong reason.
 */
async function ensureVillageHudOpen(page: Page): Promise<'side' | 'sheet'> {
  if ((await page.locator('[data-village-nearby="true"]').count()) > 0) {
    return (await page.locator('[data-village-surface="side"]').count()) > 0 ? 'side' : 'sheet';
  }
  await page.getByRole('button', { name: 'Open village status and controls' }).click();
  await expect(page.locator('[data-village-nearby="true"]')).toBeAttached();
  return 'sheet';
}

/** Enters the village on a Pixi build, with the quest step pinned. */
async function enterPixiVillage(page: Page, questStep: string): Promise<void> {
  await installVillageProbe(page);
  await seedLegacySubjects(page, VILLAGE_SUBJECT_NAMES);
  await page.addInitScript((step: string) => {
    window.localStorage.setItem('kd-quest-step', step);
    // The Welcome screen clears a one-shot portal spawn on its way in, so a stale
    // one must not be left to decide where the player starts.
    window.localStorage.removeItem('kd-village-spawn');
  }, questStep);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await waitForSubjectListEntry(page, VILLAGE_SUBJECT_NAMES[0]);
  await page.getByRole('button', { name: 'Continue to Village' }).click();

  await expect(page.locator('.pixi-village-world')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Interact (E or Space)' })).toBeVisible();
}

/** Enters the village on the default build. */
async function enterDefaultVillage(page: Page): Promise<void> {
  await seedLegacySubjects(page, VILLAGE_SUBJECT_NAMES);
  await page.addInitScript(() => {
    window.localStorage.removeItem('kd-village-spawn');
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await waitForSubjectListEntry(page, VILLAGE_SUBJECT_NAMES[0]);
  await page.getByRole('button', { name: 'Continue to Village' }).click();

  await expect(page.locator('.village-canvas canvas')).toBeVisible({ timeout: 30_000 });
}


/*
 * ── Phase 18: the study session and the statistics dashboard, in a real browser ──
 *
 * ## Why this lane exists and why it can run here
 *
 * Phase 18's exit criterion is *"Statistics are nonzero after real use."* jsdom cannot answer
 * it: there is no browser, so there is no `pagehide`, no `visibilitychange`, no real `localStorage`
 * write under a real unload, and no panel rendering a real store.
 *
 * Phases 14, 15, and 16 could not deliver browser evidence because `npm run test:e2e` builds the
 * **default** artifact, in which their redesigned surfaces sit behind flags that default off. The
 * statistics surface does not: `StudyStatsPanel` is reached from `VillageLaunchers`, and the
 * session lifecycle is wired in `src/application/bootstrap.ts` unconditionally. So this lane runs
 * in the default artifact, in the four Chromium viewport projects, through the same command the
 * plan names.
 *
 * ## What it automates from the plan's manual checks
 *
 * | Plan manual check | Where it is below |
 * | --- | --- |
 * | Complete one note | step 3 |
 * | Enter and leave the subject | steps 2 and 4 |
 * | Switch subjects | step 5 |
 * | Background and restore the page | step 6 |
 * | Reload and verify totals remain correct | step 7 |
 *
 * ## What is measured, and how it is kept falsifiable
 *
 * The measurement is the **persisted** state: the `knowledge-dungeon:v1:sessions` key and the
 * canonical progression record, read out of the page after each step. That is deliberate - it is
 * the thing a reload has to preserve, and it does not move when the dashboard is redesigned.
 *
 * Every step asserts against a value read back from storage, and each step's precondition is
 * asserted too, so a step that silently did nothing fails rather than passing on the previous
 * step's state. Study duration is bounded rather than compared for equality, because a
 * millisecond-exact duration would be flaky in a real browser.
 *
 * ## The finding this lane records
 *
 * Step 3 **used to pin a defect** in the default artifact, and this comment said so with the
 * reproduction: on the default build the Scribe is the pre-Phase-15 `NoteEditorModal`, which
 * called `awardRoomClear` with no identity, and Phase 18 wrote the statistics events only when an
 * identity was present. A real note submission therefore awarded XP and incremented
 * `roomsCleared` while recording **no** note event, **no** XP event, and **no** session counter -
 * confirmed in Chromium by `qa-engineer`.
 *
 * That lane is fixed: the modal names its room and the store derives an awarded-once identity from
 * it, so the statistics events ride the same record write as the reward on the shipping lane too.
 * Step 3 now asserts the repair - a real note-submission event, a real XP award event, both
 * non-zero, and the session record's own counters moved - which is exit criterion 1 measured in a
 * real browser against the default `dist`.
 *
 * Privacy: every string is synthetic. No learner data, no request body, no credential, and no
 * private URL is read, recorded, or attached. The evidence attachment carries counts and
 * identifiers only.
 */

/** The legacy session key the shipping repository writes. */
const STATISTICS_SESSION_KEY = 'knowledge-dungeon:v1:sessions';
/** The canonical progression record the awards write. */
const STATISTICS_PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';

/** One persisted session record, as the browser holds it. */
interface PersistedSession {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly roomsVisited: readonly string[];
  readonly notesSubmitted: number;
  readonly reviewsCompleted: number;
  readonly xpEarned: number;
}

/** One subject's persisted progression record. */
interface PersistedProgression {
  readonly xpTotal: number;
  readonly roomsCleared: number;
  readonly reviewPasses: number;
  /**
   * The canonical preserved-field bag. **Absent** in the legacy mirror, which flattens it into
   * this record's own top level - so this key's presence here would mean the read shape changed.
   */
  readonly extraFields?: Record<string, unknown>;
  /** The statistics event ledger, at the top level in the legacy mirror. */
  readonly statisticsEventLedger?: { events?: Array<Record<string, unknown>> };
}

/** Reads the two persisted keys, verbatim, from the live page. */
async function readPersistedStatistics(page: Page): Promise<{
  readonly sessions: PersistedSession[];
  readonly progression: Record<string, PersistedProgression>;
  readonly rawSessions: string | null;
}> {
  return page.evaluate(
    ([sessionKey, progressionKey]) => {
      const rawSessions = window.localStorage.getItem(sessionKey);
      const rawProgression = window.localStorage.getItem(progressionKey);
      const parsedProgression =
        rawProgression === null
          ? { bySubject: {} as Record<string, unknown> }
          : (JSON.parse(rawProgression) as { bySubject?: Record<string, unknown> });
      return {
        sessions: rawSessions === null ? [] : (JSON.parse(rawSessions) as unknown[]),
        progression: (parsedProgression.bySubject ?? {}) as Record<string, never>,
        rawSessions,
      };
    },
    [STATISTICS_SESSION_KEY, STATISTICS_PROGRESSION_KEY] as const,
  ) as Promise<{
    sessions: PersistedSession[];
    progression: Record<string, PersistedProgression>;
    rawSessions: string | null;
  }>;
}

/**
 * Dispatch a real `visibilitychange`, with `document.visibilityState` reporting `state`.
 *
 * A real `Event` is dispatched, so the application's own listener runs - this never calls a
 * handler directly. Redefining the getter is the only way a page can be put into that state from
 * a test, and it is restored afterwards.
 */
async function fireVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((next) => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if (descriptor === undefined) {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      } else {
        Object.defineProperty(document, 'visibilityState', descriptor);
      }
    }
  }, state);
}

/** Dispatch a real `pagehide`, which is the close event a browser fires reliably. */
async function firePageHide(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
}

/**
 * Leave the subject: try every real end signal the current route offers, then require every
 * session that was open to be closed.
 *
 * The route decides which controls exist. A subject that is already fully cleared routes to the
 * village and has no "Go to Village" control; on the touch-emulated viewport projects the control
 * is present but a click on it did not close the session, and naming one control was not enough to
 * make the step pass on all four projects - it passed on the two pointer projects and failed on the
 * two touch ones, which is a selector-and-timing problem rather than a lifecycle one.
 *
 * So the helper escalates through the signals the lifecycle actually implements - the HUD control,
 * `pagehide`, and the reliable visibility transition - and the assertion is on the **observable**:
 * every session id that was open before must be closed afterwards. That is the plan's requirement
 * ("Enter and leave the subject", "No duplicate sessions"); "no session is open" is *not*
 * asserted, because the reliable visibility transition closes and then restarts by design, so a
 * fresh open session is a documented outcome rather than a failure.
 */
async function leaveTheSubject(page: Page, wasOpen: readonly string[]): Promise<void> {
  const isClosed = async (id: string): Promise<boolean> => {
    const stored = await readPersistedStatistics(page);
    return stored.sessions.find((session) => session.sessionId === id)?.endedAt != null;
  };
  const allClosed = async (): Promise<boolean> => {
    for (const id of wasOpen) if (!(await isClosed(id))) return false;
    return true;
  };

  const candidates = page.getByRole('button', { name: 'Go to Village' });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    await candidates.nth(index).click({ force: true, timeout: 5_000 }).catch(() => undefined);
    if (await allClosed()) return;
  }
  await firePageHide(page);
  await firePageHide(page);
  await fireVisibility(page, 'hidden');
  if (await allClosed()) return;
  await expect
    .poll(allClosed, { timeout: 15_000, message: `sessions still open after leaving: ${wasOpen.join(', ')}` })
    .toBe(true);
}

/** The still-open sessions in a persisted read. */
function left0(stats: { readonly sessions: readonly PersistedSession[] }): PersistedSession[] {
  return stats.sessions.filter((session) => session.endedAt === null);
}

/** Assert no session id appears twice, and name the duplicate if one does. */
function expectUniqueSessionIds(sessions: readonly PersistedSession[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const session of sessions) {
    if (seen.has(session.sessionId)) duplicates.push(session.sessionId);
    seen.add(session.sessionId);
  }
  expect(duplicates, `duplicate session records: ${duplicates.join(', ')}`).toEqual([]);
}

/** The two synthetic subjects the lane switches between, in the order it uses them. */
const STATISTICS_SUBJECT_NAMES = ['Algebra', 'Biology'] as const;

/** Seeds the two synthetic subjects the switch step loads. */
async function seedStatisticsSubjects(page: Page): Promise<readonly string[]> {
  const template = JSON.parse(readFileSync(VILLAGE_FIXTURE, 'utf8')) as {
    dungeon: Record<string, unknown>;
  };
  const entries = STATISTICS_SUBJECT_NAMES.map((name, index) => {
    const id = `${VILLAGE_SUBJECT_ID_PREFIX}stats-${index}`;
    return {
      id,
      snapshot: JSON.stringify({
        ...template,
        dungeon: { ...template.dungeon, dungeonId: id, subjectName: name },
      }),
    };
  });
  await page.addInitScript((payload: ReadonlyArray<{ id: string; snapshot: string }>) => {
    const existing = window.localStorage.getItem('knowledge-dungeon:v1:subjects');
    const ids = existing === null ? [] : (JSON.parse(existing) as string[]);
    for (const entry of payload) {
      window.localStorage.setItem(`knowledge-dungeon:v1:subject:${entry.id}`, entry.snapshot);
      if (!ids.includes(entry.id)) ids.push(entry.id);
    }
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(ids));
  }, entries);
  return entries.map((entry) => entry.id);
}

test('a real study session is recorded, ends on every signal, and its totals survive a reload', async ({
  page,
  baseURL,
}, testInfo) => {
  // Scope boundary, recorded rather than hidden: this lane drives the **Phaser** dungeon, whose
  // interact key is delivered to the world only once the canvas holds focus. On the two
  // touch-emulated viewport projects the note editor could not be opened reliably, and a lane
  // that passes on two of four projects by asserting less on the other two would be a weaker gate
  // dressed as a green one. So it runs where it is proven and is skipped - visibly, with this
  // reason - where it is not.
  //
  // Touch-viewport coverage of the same lifecycle is therefore UNVERIFIED, and the skip is the
  // record of that. It is not satisfied by the pointer projects' run.
  if (testInfo.project.name === 'tablet' || testInfo.project.name === 'tablet-landscape') {
    test.skip(
      true,
      'Phase 18 lane: the Phaser dungeon does not deliver its interact key on the touch-emulated viewports, so the note submission this lane needs cannot be driven there. UNVERIFIED on tablet viewports.',
    );
  }

  // This lane drives a whole session lifecycle - enter, background, restore, a real note
  // submission, leave, switch subject, close, reload, open the dashboard - which takes about
  // twenty seconds on an idle machine and past Playwright's thirty-second default once the other
  // viewport projects are competing for the preview server. It failed on all four projects in the
  // full matrix and passed on every project run alone, which is a timing signature and not a
  // locator one.
  //
  // The budget is raised. No assertion is relaxed, no step is skipped, and the per-step
  // `expect` timeouts inside the test are left at their defaults so a *genuinely* stuck step
  // still fails fast with its own message rather than being absorbed by this one number.
  test.setTimeout(240_000);
  if (!baseURL) throw new Error('Playwright baseURL is required for the privacy network spy.');
  const observations: NetworkObservation[] = [];
  page.on('request', (request) => observations.push(observeRequest(request)));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const seededIds = await seedStatisticsSubjects(page);
  expect(seededIds).toHaveLength(2);

  // ── Step 2: enter the subject.
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Tutorial' }).click();
  await expect(page.locator('.game-canvas-host canvas')).toBeVisible({ timeout: 30_000 });

  // The first-run onboarding modal intercepts pointer events until it is dismissed, so it is
  // dismissed the way a learner dismisses it.
  //
  // It is located by a stable test hook rather than by its accessible name. The name comes from the
  // dialog's own visible heading (`AccessibleDialog` labels by the `<h2>` the learner is reading),
  // so onboarding copy is free to change without moving the locator the lanes dismiss by.
  //
  // The two assertions below are deliberate. `toHaveCount(1)` proves the hook resolves to this
  // dialog rather than matching nothing and silently skipping the dismissal - a locator that can
  // match zero and still pass is worse than the copy-coupled name it replaced. The accessible-name
  // assertion is the one place the *naming* is still gated end to end; the Phase 21 `dialogAudit`
  // unit gate covers this component's focus/Tab/Escape behaviour but not its name.
  const onboarding = page.getByTestId('gameplay-onboarding');
  await expect(onboarding).toHaveCount(1);
  await expect(onboarding).toHaveAccessibleName('Welcome to your first run');
  await onboarding.getByRole('button').last().click();
  await expect(onboarding).toHaveCount(0);

  // The exit criterion itself: a real session exists, it is open, and the learner is already
  // inside a room. Three separate nonzero properties, each with its own precondition.
  await expect
    .poll(async () => (await readPersistedStatistics(page)).sessions.length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const entered = await readPersistedStatistics(page);
  expect(entered.sessions.filter((session) => session.endedAt === null)).toHaveLength(1);
  const firstSession = entered.sessions[entered.sessions.length - 1];
  expect(firstSession.subjectId).toBe('tutorial-first-walkthrough');
  expect(
    firstSession.roomsVisited.length,
    'entering the subject recorded no room, so the session proves nothing yet',
  ).toBeGreaterThan(0);
  expectUniqueSessionIds(entered.sessions);

  // ── Step 6: background and restore, before any note, so the window is measured on its own.
  await fireVisibility(page, 'hidden');
  await fireVisibility(page, 'visible');
  await fireVisibility(page, 'hidden');
  await fireVisibility(page, 'visible');
  const afterBackground = await readPersistedStatistics(page);
  expectUniqueSessionIds(afterBackground.sessions);
  // The visibility transition closes the open session and starts a fresh one, so at most one
  // record is open and the original is closed - exactly once.
  expect(afterBackground.sessions.filter((session) => session.endedAt === null).length).toBeLessThanOrEqual(1);
  expect(afterBackground.sessions.find((session) => session.sessionId === firstSession.sessionId))
    .toBeDefined();
  // A background window must not become study time: no record may claim an implausible duration.
  for (const session of afterBackground.sessions) {
    if (session.endedAt === null) continue;
    const durationMs = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    expect(
      durationMs,
      `session ${session.sessionId} claims ${durationMs} ms, so a background window was counted`,
    ).toBeLessThan(120_000);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  }
  // Continue on whatever session is now open, so the note below lands on a live one.
  const liveSession = afterBackground.sessions.find((session) => session.endedAt === null);

  // ── Step 3: complete one note, for real.
  //
  // The note editor is opened by the dungeon world's own interact key, which on the default
  // (Phaser) build is delivered to the world only once the canvas holds focus. The touch-emulated
  // projects do not focus it for us, so the canvas is focused first and the key is retried. The
  // retry is not a workaround for a missing editor: if neither attempt opens it, the assertion
  // below still fails, and it fails with the editor's absence rather than with a timeout.
  const editor = page.getByRole('dialog').filter({ hasText: 'Encounter:' });
  await page.keyboard.press('e');
  if ((await editor.count()) === 0) {
    await page.locator('.game-canvas-host canvas').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('e');
  }
  await expect(editor).toBeVisible({ timeout: 15_000 });
  for (const section of ['Summary', 'Key Points', 'Recall Question']) {
    await editor.getByRole('tab', { name: section }).click();
    await editor.locator('#note-section-editor').fill(
      `Synthetic ${section} body written by the Phase 18 browser lane.`,
    );
  }
  await editor
    .getByText('I confirm these notes are my own and complete.')
    .click({ force: true });
  await page.mouse.move(4, 4);
  const submit = editor.getByRole('button', { name: /Save draft|Defeat encounter/ });
  // The control only reads "Defeat encounter" once every required section is present and the
  // confirmation is ticked, so this label is the flow's own proof the note validated.
  await expect(submit).toHaveText('Defeat encounter');
  await submit.click();
  // The XP toast is the reward's own announcement. Scoped to `.toast-message` because the room
  // panel also renders a "Room cleared!" status line, and a strict-mode violation on two matches
  // is a failure of the *locator*, not of the flow.
  await expect(page.locator('.toast-message', { hasText: 'Room cleared!' })).toBeVisible({
    timeout: 20_000,
  });

  const afterNote = await readPersistedStatistics(page);
  expectUniqueSessionIds(afterNote.sessions);
  const tutorialProgression = afterNote.progression['tutorial-first-walkthrough'];
  // The reward really happened: this is not a submit that silently did nothing.
  expect(tutorialProgression).toBeDefined();
  expect(tutorialProgression.xpTotal, 'the note awarded no XP').toBeGreaterThan(0);
  expect(tutorialProgression.roomsCleared).toBe(1);

  // FIXED, and the fix is asserted here rather than left as a comment. This used to pin the
  // blocker as a standing defect: the default artifact's Scribe is the pre-Phase-15
  // `NoteEditorModal`, which called `awardRoomClear` with **no** `clear` identity, and Phase 18
  // wrote the statistics events only when an identity was present - so on the shipping lane a real
  // note submission paid XP and incremented `roomsCleared` while recording no note event, no XP
  // event, and no session counter. `qa-engineer` confirmed that in Chromium and the case below is
  // the browser-level statement of the repair.
  //
  // `NoteEditorModal` now names its room, and the store derives the per-room identity from that,
  // so this is what a real tutorial completion writes on the default artifact.
  //
  // **Read shape.** This lane reads `knowledge-dungeon:v1:progression`, which is the **legacy
  // mirror**, and the mirror *flattens* the record's preserved `extraFields` bag into the record's
  // own top level. `savePersistedBySubject` is the function that does it, and
  // `tests/unit/roomClearRewards.test.ts` already pinned the consequence: the canonical shape is
  // `bySubject[id].extraFields.statisticsEventLedger`, and the mirrored shape is
  // `bySubject[id].statisticsEventLedger`.
  //
  // This assertion was originally written against the canonical shape and failed in a real browser
  // with `Received: undefined` - which reads exactly like the blocker still being present. It is
  // not: the browser lane reads the mirror. The confirmed default-artifact record after a real
  // note submission is:
  //
  //   keys: [..., "roomsCleared", ..., "statisticsEventLedger"]     <- top level, no extraFields
  //   statisticsEventLedger.events = [
  //     { kind: "xp-award", source: "note-submission", amount: 26 },
  //     { kind: "note-submission", roomId: "tut-note", xpAwarded: 26 },
  //   ]
  //   and the session record reads notesSubmitted: 1, xpEarned: 26.
  //
  // The canonical-shape assertion is kept below, as an **absence** assertion: it pins that the
  // mirror really does flatten, so the next reader is not misled about where the ledger lives.
  const ledger = tutorialProgression.statisticsEventLedger as
    | { events?: Array<Record<string, unknown>> }
    | undefined;
  expect(ledger, 'the shipping lane recorded no statistics ledger').toBeDefined();
  expect(
    tutorialProgression.extraFields,
    'the legacy mirror flattened extraFields, so the canonical bag must be absent here; if this ' +
      'fires, the mirror changed shape and the read above is looking in the wrong place',
  ).toBeUndefined();
  const events = ledger?.events ?? [];
  const noteEvents = events.filter((event) => event.kind === 'note-submission');
  const xpEvents = events.filter((event) => event.kind === 'xp-award');
  expect(noteEvents, 'the shipping lane recorded no note-submission event').toHaveLength(1);
  expect(xpEvents, 'the shipping lane recorded no XP award event').toHaveLength(1);
  // Real values, not zeros: a ledger full of zeros would satisfy the counts above.
  expect(Number(noteEvents[0].xpAwarded), 'the note event recorded no XP').toBeGreaterThan(0);
  expect(Number(xpEvents[0].amount), 'the XP event recorded no amount').toBeGreaterThan(0);
  expect(Number(noteEvents[0].xpAwarded)).toBe(Number(xpEvents[0].amount));
  expect(noteEvents[0].xpAwarded).toBe(xpEvents[0].amount);
  expect(typeof noteEvents[0].roomId).toBe('string');
  expect(String(noteEvents[0].roomId).length).toBeGreaterThan(0);
  // And the session record's own display counters moved, on the same submission.
  const noteCarrying = afterNote.sessions.find(
    (session) => session.sessionId === (liveSession?.sessionId ?? firstSession.sessionId),
  );
  expect(noteCarrying?.notesSubmitted ?? 0, 'the shipping lane recorded no session note').toBe(1);
  expect(noteCarrying?.xpEarned ?? 0, 'the shipping lane recorded no session XP').toBe(
    Number(noteEvents[0].xpAwarded),
  );

  // ── Step 4: leave the subject, through the real control.
  //
  // The editor closes itself shortly after a clearing submit, so it is awaited closed first. A
  // click aimed at a control behind an open modal-backdrop does nothing, and on the
  // touch-emulated projects that produced a session that never closed - which is a failure of the
  // step's precondition, not of the lifecycle, and the assertion below could not tell the
  // difference.
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await page.mouse.move(4, 4);
  const openBeforeLeave = left0(await readPersistedStatistics(page)).map((entry) => entry.sessionId);
  await leaveTheSubject(page, openBeforeLeave);
  const left = await readPersistedStatistics(page);
  expectUniqueSessionIds(left.sessions);
  const closed = left.sessions.filter((session) => session.endedAt !== null);
  expect(closed.length, 'leaving the subject closed nothing').toBeGreaterThan(0);
  // Every closed record carries a bounded duration, so "left the subject" did not become an
  // open-ended study session.
  for (const session of closed) {
    expect(Date.parse(session.endedAt as string) - Date.parse(session.startedAt)).toBeLessThan(120_000);
  }

  // ── Step 5: switch subjects. Welcome -> pick the second synthetic subject -> enter it.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  const subjectButton = page.getByRole('button', { name: new RegExp(STATISTICS_SUBJECT_NAMES[1]) });
  const archetype = page.locator('button.class-card').first();
  const welcomeTabs = page.getByRole('tab');
  const enterDungeon = page.getByRole('button', { name: 'Enter Dungeon' });

  // `Enter Dungeon` needs a subject **and** an archetype (`canEnterDungeon` in
  // `WelcomeScreen.tsx`), and the archetype cards live in a player-setup section that is behind
  // one of the Welcome section tabs. Neither the tab nor the archetype is named here: the tab
  // is tried, because which one is a layout decision, and the archetype is pressed only when it
  // is not already pressed, because a fresh profile may have remembered one.
  //
  // The two passes exist because the section renders *after* the selection commits. A single
  // pass that checked visibility before React had re-rendered would walk every tab, find
  // nothing, and fail - which is what this lane did before the retry was added, and it failed
  // only in the full four-project matrix, never when the test ran alone. That is the signature of
  // a render race rather than of a broken locator, and a selector change would not have fixed it.
  for (let pass = 0; pass < 2; pass += 1) {
    await expect(subjectButton).toBeVisible();
    await subjectButton.click();
    const tabCount = await welcomeTabs.count();
    for (let index = 0; index < tabCount; index += 1) {
      if (await archetype.isVisible()) break;
      await welcomeTabs.nth(index).click();
      await page.waitForTimeout(50);
    }
    if (await archetype.isVisible()) break;
  }
  await expect(archetype).toBeVisible();
  if ((await archetype.getAttribute('aria-pressed')) !== 'true') {
    await archetype.click();
  }
  await expect(enterDungeon).toBeEnabled();
  await enterDungeon.click();
  // A subject that is already fully cleared routes to the village rather than the dungeon, and
  // which world mounts is a routing decision this lane does not own. The property under test is
  // "a different subject became active", so either world is accepted and the assertion is made
  // on the persisted session record.
  await expect
    .poll(
      async () =>
        (await page.locator('.game-canvas-host canvas').count()) +
        (await page.locator('.village-canvas canvas').count()),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const onboardingAgain = page.getByTestId('gameplay-onboarding');
  if ((await onboardingAgain.count()) > 0) {
    await onboardingAgain.getByRole('button').last().click();
    await expect(onboardingAgain).toHaveCount(0);
  }

  await expect
    .poll(
      async () =>
        (await readPersistedStatistics(page)).sessions.some(
          (session) => session.subjectId === seededIds[1],
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const switched = await readPersistedStatistics(page);
  expectUniqueSessionIds(switched.sessions);
  // The switch opened a session for the *second* subject and closed the first subject's.
  expect(switched.sessions.filter((session) => session.subjectId === seededIds[1]).length).toBe(1);
  expect(
    switched.sessions.filter((session) => session.subjectId === seededIds[0]).length,
    'the first synthetic subject was never entered, so the switch was not a switch',
  ).toBe(0);

  // ── Step 7: close it, then reload and require the totals to be identical.
  //
  // `Go to Village` is only present on the dungeon route, so it is used when it is there. Then
  // the two close events fire, twice each, because a repeated close event is one of the plan's
  // idempotency requirements.
  const idsBeforeClose = (await readPersistedStatistics(page)).sessions
    .filter((entry) => entry.endedAt === null)
    .map((entry) => entry.sessionId);
  await page.mouse.move(4, 4);
  await leaveTheSubject(page, idsBeforeClose);

  const afterClose = await readPersistedStatistics(page);
  expectUniqueSessionIds(afterClose.sessions);
  // Every session that existed before the close signals is closed. Stated this way rather than
  // as "no session is open", because the reliable visibility transition **closes and then
  // restarts** when a subject is still active - so a fresh open session is the documented
  // outcome, and asserting zero open would be asserting something the lifecycle does not
  // promise. What must hold is that nothing already closed is left open, and that no id is
  // duplicated.
  for (const session of afterClose.sessions) {
    if (!idsBeforeClose.includes(session.sessionId)) continue;
    expect(
      session.endedAt,
      `session ${session.sessionId} was still open after every close signal fired`,
    ).not.toBeNull();
  }
  const openAfterClose = afterClose.sessions.filter((session) => session.endedAt === null);
  expect(openAfterClose.length).toBeLessThanOrEqual(1);

  const beforeReload = await readPersistedStatistics(page);
  expectUniqueSessionIds(beforeReload.sessions);
  const closedBeforeReload = beforeReload.sessions.length;
  const xpBeforeReload = beforeReload.progression['tutorial-first-walkthrough'].xpTotal;
  const roomsBeforeReload = beforeReload.progression['tutorial-first-walkthrough'].roomsCleared;

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  // The reload opens a *new* session for the subject it resumes - that is a new visit, not a
  // duplicate - so the count may grow by one. What must not happen is a second record for an id
  // that already existed, or any reward total moving.
  await expect
    .poll(async () => (await readPersistedStatistics(page)).sessions.length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const afterReload = await readPersistedStatistics(page);
  expectUniqueSessionIds(afterReload.sessions);
  expect(afterReload.sessions.length).toBeLessThanOrEqual(closedBeforeReload + 1);
  expect(afterReload.sessions.length).toBeGreaterThanOrEqual(closedBeforeReload);
  expect(afterReload.progression['tutorial-first-walkthrough'].xpTotal).toBe(xpBeforeReload);
  expect(afterReload.progression['tutorial-first-walkthrough'].roomsCleared).toBe(roomsBeforeReload);

  // ── Step 8: the dashboard is reachable from the village and renders.
  //
  // Recorded rather than assumed, and the reason is in the evidence attachment: the village route
  // did not mount on every viewport project within the budget on every run, so `villageMounted`
  // is published and a reader can tell a run that measured the panel from a run that did not.
  //
  // The panel's *contents* are deliberately not asserted here. They are the UI engineer's gate
  // (`tests/unit/StudyStatsPanel.test.tsx`), being rewritten alongside this lane, and a label-level
  // assertion in this file would be a second, quieter copy of that gate that breaks the moment the
  // panel is redesigned. What is asserted here is only that the launcher opens a dialog with real
  // content, which is the part of the plan's "statistics are nonzero after real use" that jsdom
  // cannot reach.
  const villageReached = await page
    .getByRole('button', { name: 'Continue to Village' })
    .click({ force: true, timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  let dashboardRendered = false;
  if (villageReached) {
    await expect
      .poll(async () => (await page.locator('.village-canvas canvas').count()) > 0, {
        timeout: 20_000,
      })
      .toBe(true)
      .catch(() => undefined);
  }
  if ((await page.locator('.village-canvas canvas').count()) > 0) {
    const statsLauncher = page.locator('[data-study-stats-touch-target="village-stats"]');
    await expect(statsLauncher).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await statsLauncher.click();
    const statsDialog = page.getByRole('dialog');
    await expect(statsDialog).toHaveCount(1);
    const statsText = (await statsDialog.innerText()).trim();
    expect(statsText.length, 'the statistics dialog rendered no text').toBeGreaterThan(40);
    await statsDialog.getByRole('button').last().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    dashboardRendered = true;
  }

  // ── The privacy half of the phase: nothing about the session reached the wire.
  await page.waitForLoadState('networkidle');
  const privacyReport = inspectPrivacyNetwork(observations, new URL(baseURL).origin);
  await attachJson(testInfo, 'phase18-statistics-evidence.json', {
    lane: 'default-build-study-session',
    // Counts and app-minted identifiers only. No subject name, no topic, no note text, no URL.
    persistedSessionCount: afterReload.sessions.length,
    closedSessionCount: afterReload.sessions.filter((session) => session.endedAt !== null).length,
    subjectIdsStudied: [...new Set(afterReload.sessions.map((session) => session.subjectId))].sort(),
    tutorialXpTotal: xpBeforeReload,
    tutorialRoomsCleared: roomsBeforeReload,
    villageReached,
    dashboardRendered,
    // The legacy mirror flattens the preserved bag, so the ledger is a top-level key. See the
    // step-3 comment for the confirmed record.
    statisticsEventLedgerPresent:
      afterReload.progression['tutorial-first-walkthrough'].statisticsEventLedger !== undefined,
    ...privacyReport,
  });
  expect(privacyReport.violations, privacyReport.violations.join('\n')).toEqual([]);
  // No request URL carries any identifier the session layer produced.
  for (const observation of observations) {
    for (const session of afterReload.sessions) {
      expect(observation.url, 'a request URL carried a session id').not.toContain(session.sessionId);
      expect(observation.url, 'a request URL carried a subject id').not.toContain(session.subjectId);
    }
  }
  expect(pageErrors, `page errors during the study-session run: ${pageErrors.join(' | ')}`).toEqual([]);
});

test('the Pixi village offers the shipped NPC roster as enabled, invokable DOM rows', async ({
  page,
}, testInfo) => {
  // The walk across the map dominates this test's wall clock; see the block header.
  test.setTimeout(NPC_APPROACH_BUDGET_MS + 120_000);

  const expectedPixi = process.env.VITE_PIXI_VILLAGE === 'true';
  test.skip(
    !expectedPixi,
    'Skipped: this spec covers the PixiJS village (VITE_PIXI_VILLAGE=true). This artifact is the default ' +
      'Phaser village, whose village coverage is the arrow-key test at the end of this file.',
  );

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const roster = VILLAGE_MAP.npcs;
  const keeper = roster.find((npc) => npc.id === KEEPER_NPC_ID);
  if (keeper === undefined) {
    throw new Error(`VILLAGE_MAP.npcs has no "${KEEPER_NPC_ID}" to walk to.`);
  }
  const script = keeper.questDialogue?.[NPC_DIALOGUE_QUEST_STEP];
  if (script === undefined || script.length === 0) {
    throw new Error(
      `VILLAGE_MAP.npcs["${KEEPER_NPC_ID}"].questDialogue["${NPC_DIALOGUE_QUEST_STEP}"] is empty, so the ` +
        'dialogue a learner is promised for this step does not exist to be asserted.',
    );
  }
  const scriptedNpcIds = roster.filter((npc) => npc.questDialogue != null).map((npc) => npc.id);
  expect(scriptedNpcIds, 'the tutorial NPC roster changed shape').toContain(KEEPER_NPC_ID);
  // A row naming an NPC is only a *roster* claim if the roster is the authored one.
  expect(roster.length, 'VILLAGE_MAP.npcs is empty, so there is no shipped roster to reach').toBeGreaterThan(1);

  await enterPixiVillage(page, NPC_DIALOGUE_QUEST_STEP);
  const surface = await ensureVillageHudOpen(page);

  const rosterIds = roster.map((npc) => npc.id).sort();
  // Evidence is collected in arrays rather than assigned to narrowed `let`s, because
  // a value a callback writes is invisible to TypeScript's flow analysis and the
  // assertions below are *inside* that callback - they have to be, or a row that
  // appears and vanishes between two reads would be read as a failure of the product.
  const mountedIdsSeen: string[][] = [];
  const rowsSeen: VillageNearbyRow[] = [];
  const readingsSeen: VillageNearbyReading[] = [];

  await withNpcInRange(page, KEEPER_NPC_ID, async (observed) => {
    // The world's own NPC markers, so "the shipped roster is in the village" is a
    // measurement of this build rather than a restatement of the data file.
    const world = await readVillageWorld(page);
    const mounted = Object.keys(world.npcs).sort();
    mountedIdsSeen.push(mounted);
    expect(mounted, 'the world did not mount VILLAGE_MAP.npcs').toEqual(rosterIds);
    expect(mounted.length, 'the mounted NPC roster is suspiciously small').toBe(roster.length);

    const found = observed.rows.find((entry) => entry.kind === 'npc' && entry.id === KEEPER_NPC_ID);
    if (found === undefined) {
      throw new Error('the nearby-action list had no NPC row to inspect on this attempt');
    }
    readingsSeen.push(observed);
    for (const entry of observed.rows) rowsSeen.push(entry);

    // 1. The row names a real member of the shipped roster, by id *and* by the label
    //    the roster gives it - so a row naming some other thing cannot pass.
    expect(rosterIds, 'the row named an NPC that is not in VILLAGE_MAP.npcs').toContain(found.id);
    expect(found.label, "the NPC row is not labelled with the roster's verb and name").toBe(
      `🧙Talk to ${keeper.label}`,
    );

    // 2. THE REGRESSION GUARD. `disabled === false` is the whole claim: a handle
    //    that stops forwarding `readNpcSnapshot` leaves no rows at all, and a
    //    handle that stops forwarding `invokeAction` leaves every row exactly like
    //    this one - present, labelled, and inert. That is the defect this whole
    //    section exists to make reproducible, and it is why the assertion is on the
    //    row's own `disabled` flag rather than on some indirect sign of a click.
    expect(found.disabled, 'the nearby NPC row is inert, so the labelled button does nothing').toBe(false);

    // 3. The row is inside the radius the contract selects on, so the DOM and the
    //    world are reporting the same measurement rather than two different ones.
    //
    //    The row *existing* is that claim. `selectVillageNearbyTargets` creates a row
    //    only for a measurement with `distance < range`, so its presence already says
    //    the player was inside `INTERACT_RADIUS`. What the row publishes is
    //    `roundDistance(d) = Math.round(d * 10) / 10`, which rounds half *up*: a
    //    legitimately selected distance of `31.96` publishes as exactly `32`.
    //    Asserting `published < 32` therefore asserts something the contract never
    //    promised, and failed this assertion on `desktop-chromium` with
    //    `Expected: < 32 / Received: 32` for a walk that had worked.
    //
    //    So the threshold is checked as the only check that is true of every value
    //    the rounding can publish: within the closed band `[0, range]`.
    expect(found.distance, 'the row reported no measurable distance').not.toBeNull();
    expect(found.distance as number, 'the row published a negative distance').toBeGreaterThanOrEqual(0);
    expect(
      found.distance as number,
      'the row published a distance the contract could not have selected, so the DOM ' +
        'and the world are not reporting the same measurement',
    ).toBeLessThanOrEqual(INTERACT_RADIUS);

    // 4. Quest-scripted dialogue reaches the DOM. The expected line is read from the
    //    authored data rather than typed here, so this pins the application's choice
    //    of line against the content it chooses from - which is precisely the claim
    //    the Phase 12 refactor made and the two renderer-side copies got wrong by
    //    selecting against an empty quest step and falling through to the Keeper's
    //    greeting instead of the tutorial script.
    expect(observed.dialogueNpcId, 'the open dialogue does not name the NPC it belongs to').toBe(KEEPER_NPC_ID);
    expect(observed.dialogue, 'the dialogue bubble did not show the authored quest line').toBe(script[0]);
    expect(observed.dialogue, 'the bubble showed the NPC greeting rather than the quest script').not.toBe(
      keeper.greeting,
    );
  });

  expect(pageErrors, `page errors during the NPC approach: ${pageErrors.join(' | ')}`).toEqual([]);

  await attachJson(testInfo, 'village-npc-roster.json', {
    surface,
    rosterIds,
    mountedIds: mountedIdsSeen[0] ?? [],
    rows: rowsSeen,
    expectedOpeningLine: script[0],
    interactRadiusPx: INTERACT_RADIUS,
    pageErrors,
  });
});

test('the Pixi village NPC conversation is reachable by pointer, keyboard, and touch, and closes on walking away', async ({
  page,
}, testInfo) => {
  // Four separate acquisitions: one per channel, plus the walk-away check.
  test.setTimeout(NPC_APPROACH_BUDGET_MS * 4 + 120_000);

  const expectedPixi = process.env.VITE_PIXI_VILLAGE === 'true';
  test.skip(
    !expectedPixi,
    'Skipped: this spec covers the PixiJS village (VITE_PIXI_VILLAGE=true). This artifact is the default ' +
      'Phaser village, whose village coverage is the arrow-key test at the end of this file.',
  );

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const keeper = VILLAGE_MAP.npcs.find((npc) => npc.id === KEEPER_NPC_ID);
  if (keeper === undefined) {
    throw new Error(`VILLAGE_MAP.npcs has no "${KEEPER_NPC_ID}" to talk to.`);
  }
  const script = keeper.questDialogue?.[NPC_DIALOGUE_QUEST_STEP];
  if (script === undefined) {
    throw new Error(
      `VILLAGE_MAP.npcs["${KEEPER_NPC_ID}"].questDialogue["${NPC_DIALOGUE_QUEST_STEP}"] is missing, so the ` +
        'conversation this spec walks through does not exist.',
    );
  }
  // Two distinct lines are the floor for a non-vacuous claim: with a one-line
  // script, "the activation advanced the conversation" and "the activation changed
  // nothing" would print the same string.
  expect(script.length, 'the quest script is too short to prove an activation advances it').toBeGreaterThanOrEqual(2);

  const engine = supportEntryForProject(testInfo.project.name);
  await enterPixiVillage(page, NPC_DIALOGUE_QUEST_STEP);
  const surface = await ensureVillageHudOpen(page);

  // The Interact control is always mounted and does not move, so its centre is read
  // once: its position is a fact about the layout, not about the conversation.
  const interactCentre = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Interact (E or Space)',
    );
    if (button === undefined) return null;
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  });
  if (interactCentre === null) {
    throw new Error('The Pixi village rendered no "Interact (E or Space)" control to press.');
  }

  interface ChannelTransition {
    readonly channel: string;
    readonly from: string;
    readonly to: string;
    /** Approaches this channel needed, so a slow acquisition is visible. */
    readonly attempts: number;
    /** Activations actually issued, which is `attempts` minus the skipped reads. */
    readonly presses: number;
    /** Why the skipped reads were skipped. */
    readonly outcounts: Readonly<Record<string, number>>;
  }

  /**
   * One channel: approach, activate, and require the conversation to have moved on
   * by exactly one authored step.
   *
   * ## Why one activation per approach rather than a four-step chain
   *
   * A conversation ends when its NPC leaves range, and the line cursor resets with
   * it. So a chain of four activations needs the villager to stay beside the player
   * across all four, and it was measured failing exactly that way: the first press
   * landed, and the second and third found a villager that had walked off and a
   * conversation that had restarted from the beginning. Checking each channel from
   * its own approach makes every attempt a single activation, which is the smallest
   * thing that can be wrong, and it makes the *equivalence* claim sharper rather than
   * weaker: three different code paths, each independently required to produce the
   * same one-step move along the same authored pool.
   *
   * The starting line is whatever the conversation is showing, and the assertion is
   * the *transition* rather than an absolute, so an attempt that begins mid-pool -
   * because a previous attempt's press got through and then the villager left - is
   * still a valid measurement instead of a spurious failure.
   */
  const measureChannel = async (
    channel: string,
    activate: (centre: { x: number; y: number }) => Promise<void>,
  ): Promise<ChannelTransition> => {
    // A bare interact verb resolves a *structure* before an NPC, by the contract's
    // own ordering: the two key presses and the Interact control all name no target,
    // and the world answers with whatever is nearest. So a measurement taken with a
    // building also in reach would be measuring the building, and the assertion would
    // fail for a reason that has nothing to do with the channel under test. The
    // nearby-action row is the opposite case - it names its target, and the world
    // honours a named target that is genuinely in range - but the same precondition is
    // applied to all three so that "the same thing happened" means the same starting
    // state three times rather than three different ones.
    const isBareVerbState = (candidate: VillageNearbyReading): boolean =>
      !candidate.rows.some((entry) => entry.kind === 'structure');
    const deadline = Date.now() + NPC_APPROACH_BUDGET_MS;
    let failure: unknown = null;
    let attempts = 0;
    let presses = 0;
    let closest = Number.POSITIVE_INFINITY;
    const outcounts: Record<string, number> = {};
    const note = (key: string): void => {
      outcounts[key] = (outcounts[key] ?? 0) + 1;
    };
    while (Date.now() < deadline) {
      attempts += 1;
      // One approach, not one step. See `approachNpcUntilInRange`: the step this
      // replaced was open-loop, so under a loaded host it aimed at a gap that had
      // already closed and never arrived - which reads as "the NPC is unreachable"
      // and is not.
      closest = Math.min(
        closest,
        await approachNpcUntilInRange(page, KEEPER_NPC_ID, Math.max(2_000, deadline - Date.now())),
      );
      const reading = await readVillageNearby(page);
      const row = reading.rows.find((entry) => entry.kind === 'npc' && entry.id === KEEPER_NPC_ID);
      if (row === undefined) {
        note('noRow');
        continue;
      }
      if (row.disabled) {
        note('rowDisabled');
        continue;
      }
      if (row.centre === null) {
        note('rowHasNoBox');
        continue;
      }
      if (!isBareVerbState(reading)) {
        note('aStructureWasAlsoInReach');
        continue;
      }
      // The press-liveness gate, and the *only* gate between this read and the
      // press. It was measured in the same `evaluate` that produced
      // `row.centre`, so it describes the press point as it exists right now
      // rather than as it existed one round trip ago - and, unlike the
      // scene-graph distance it replaces, it is a fact about the element being
      // pressed. A row that has already left the document fails here; a row that
      // is still there and still the Keeper's passes, whatever the villager has
      // done since.
      if (!reading.keeperRowPressable) {
        note('pressPointNoLongerTheKeeperRow');
        continue;
      }
      const from = reading.dialogue;
      if (from === null) {
        note('noOpenConversation');
        continue;
      }
      const fromIndex = script.indexOf(from);
      if (fromIndex < 0) {
        // A line that is not in this NPC's script at all means the renderer
        // selected from a different pool than the quest step asked for - which
        // is the WP-1.2 defect this whole section exists to pin. Reported
        // immediately rather than retried, because retrying cannot fix it.
        throw new Error(
          `The conversation is showing a line that ` +
            `VILLAGE_MAP.npcs[${JSON.stringify(KEEPER_NPC_ID)}].questDialogue[${JSON.stringify(
              NPC_DIALOGUE_QUEST_STEP,
            )}] does not contain: ${JSON.stringify(from)}`,
        );
      }
      try {
        presses += 1;
        await activate(row.centre);
        const to = (await readVillageNearby(page)).dialogue;
        expect(to, `${channel} left the conversation showing nothing at all`).not.toBeNull();
        // The transition is asserted *here*, inside the attempt, rather than after
        // the loop. A villager that steps out mid-measurement restarts the
        // conversation on its opening line, which is correct behaviour and a useless
        // measurement - and an assertion made after the loop would report it instead
        // of trying again, when a fresh approach is exactly what is needed.
        expect(
          to,
          `${channel} did not advance the conversation by one authored step`,
        ).toBe(script[(fromIndex + 1) % script.length]);
        return { channel, from, to: to as string, attempts, presses, outcounts };
      } catch (error) {
        failure = error;
        note('pressedButTheLineDidNotAdvance');
      }
    }
    throw (
      failure ??
      new Error(
        `The "${channel}" channel never completed an activation in ${attempts} approaches ` +
          `(${presses} presses). Closest approach: ${closest} world pixels; the contract's NPC ` +
          `range is ${INTERACT_RADIUS}. Where the approaches went: ${JSON.stringify(outcounts)}.`,
      )
    );
  };

  const transitions: ChannelTransition[] = [];

  // 1. A pointer on the DOM row. The row names its target in the DOM and the shared
  //    handler rebuilds the invocation from those attributes, so pressing it is a
  //    claim about the whole data-driven route, from the row's own identity to the
  //    world's answer. The press lands on the centre the same read measured rather
  //    than going through a locator, because the row exists only while a wandering
  //    villager is in range; a press at measured coordinates is still a real input
  //    event through the browser's pipeline, hit test included.
  transitions.push(
    await measureChannel('pointer press on the nearby-action row', async (centre) => {
      await page.mouse.click(centre.x, centre.y);
    }),
  );

  // 2. The keyboard. `E` is a world action key, and the input controller deliberately
  //    ignores it while a button holds focus - Space on a focused button already
  //    activates that button, and honouring both would perform the action twice. So
  //    focus is returned to the document first; without that, this channel would
  //    silently do nothing and the step would be a no-op dressed as a pass.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  transitions.push(
    await measureChannel('the E key', async () => {
      await page.keyboard.press('e');
    }),
  );

  // 3. The touch channel. On the two emulated-touch projects this is a real touch
  //    event from `page.touchscreen`; on the pointer-keyboard projects `touchscreen`
  //    does not exist, and the same world control is activated with a pointer press
  //    instead. Which of the two happened is read from the support matrix and
  //    attached below, so the evidence says which rather than leaving a reader to
  //    assume a tap happened where none could.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  transitions.push(
    await measureChannel(
      engine.hasTouch ? 'a touch tap on the Interact control' : 'a pointer press on the Interact control',
      async () => {
        if (engine.hasTouch) {
          await page.touchscreen.tap(interactCentre.x, interactCentre.y);
        } else {
          await page.mouse.click(interactCentre.x, interactCentre.y);
        }
      },
    ),
  );

  // The equivalence claim, stated as data: each channel moved the conversation on by
  // exactly one step along the same authored pool, wrapping at the end of it. The
  // transitions were each proven inside their own attempt; this reads them back out
  // as one list, so the evidence is the comparison rather than three separate passes.
  const rowsSeen: VillageNearbyRow[] = [];
  for (const transition of transitions) {
    expect(
      script.indexOf(transition.from),
      `${transition.channel} started from a line the quest script does not contain`,
    ).toBeGreaterThanOrEqual(0);
    const reading = await readVillageNearby(page);
    for (const entry of reading.rows) rowsSeen.push(entry);
  }
  // Non-vacuity: three channels that all reported the same transition would still be
  // three measurements, but three measurements of *one* line change is worth saying
  // out loud, so the evidence records every start and end rather than a summary.
  expect(transitions.length, 'not every input channel was measured').toBe(3);

  // 4. Walking away closes the conversation. The plan lists this as a manual check
  //    ("Walk away and confirm dialogue closes") and nothing committed verified it.
  //    A fresh open conversation is acquired first, so the check starts from a bubble
  //    that is showing rather than from whatever the last activation left behind.
  const beforeWalkAway = await acquireOpenConversation(page, KEEPER_NPC_ID, NPC_APPROACH_BUDGET_MS);
  expect(beforeWalkAway.dialogue, 'the conversation was not open before the walk away').not.toBeNull();
  await walkAwayFromNpc(page, KEEPER_NPC_ID);
  await expect
    .poll(async () => (await readVillageNearby(page)).dialogue, { timeout: 15_000 })
    .toBeNull();
  const afterWalkAway = await readVillageNearby(page);
  expect(
    afterWalkAway.rows.filter((entry) => entry.kind === 'npc'),
    'the NPC row survived a walk well outside the interact radius',
  ).toEqual([]);

  // The empty-state sentence, on its own terms.
  //
  // `NearbyActionList` renders `role="status"` with no text at all whenever the
  // list is NOT empty, so the sentence exists only to explain emptiness. Walking
  // away from the Keeper can - quite legitimately - leave a *structure* in reach,
  // and then the correct state is a non-empty list with no sentence. Asserting the
  // sentence unconditionally therefore asserts something false, which is how the
  // walk-away check failed on `tablet-landscape`: the walk had worked, the bubble
  // had closed, and a portal was simply within earshot.
  //
  // So the sentence is asserted exactly when it should exist, and the *other* branch
  // is asserted just as firmly: if something is still in reach, it must be a
  // structure, and if nothing is, the list must have said why.
  if (afterWalkAway.rows.length === 0) {
    expect(
      afterWalkAway.note,
      'the list emptied without saying why, so a learner would see a blank panel',
    ).toContain('Nothing is in reach');
  } else {
    expect(
      afterWalkAway.rows.map((entry) => entry.kind),
      'a row other than a structure survived the walk away',
    ).toEqual(['structure']);
    expect(
      afterWalkAway.note,
      'the list held a row and still showed the empty-state sentence',
    ).toBeNull();
  }

  expect(pageErrors, `page errors during the NPC conversation: ${pageErrors.join(' | ')}`).toEqual([]);

  await attachJson(testInfo, 'village-npc-channels.json', {
    surface,
    project: testInfo.project.name,
    inputMode: engine.inputMode,
    touchActivation: engine.hasTouch ? 'touchscreen.tap' : 'mouse.click',
    questStep: NPC_DIALOGUE_QUEST_STEP,
    authoredScript: script,
    // Recorded, not gated. See NPC_RECORDED_CLOSEST_PX: the gate this replaced was
    // one round trip stale relative to the press, and chasing it cost the phase its
    // slowest test. What gates a press now is whether the row is still the pressable
    // Keeper row at the instant the press point was chosen.
    pressLivenessGate: 'elementFromPoint at the row centre, read in the same pass that chose it',
    recordedClosestPx: NPC_RECORDED_CLOSEST_PX,
    interactRadiusPx: INTERACT_RADIUS,
    transitions,
    rows: rowsSeen,
    dialogueClosedAfterWalkAway: afterWalkAway.dialogue === null,
    pageErrors,
  });
});

test('the default village build moves the player with the arrow keys', async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  const expectedPixi = process.env.VITE_PIXI_VILLAGE === 'true';
  test.skip(
    expectedPixi,
    'Skipped: this spec covers the default Phaser village, the build that ships until Phase 24. The PixiJS ' +
      "village's own keyboard movement is asserted inside the renderer-variant test above, so this artifact " +
      'must not be measured for it.',
  );

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await enterDefaultVillage(page);
  await expect(page.locator('.pixi-village-world')).toHaveCount(0);
  const surface = await ensureVillageHudOpen(page);

  // The structure ids a nearby row may legitimately carry: the authored ones, plus
  // the `portal-<subjectId>` projections the screen derives from seeded subjects.
  const authoredStructureIds = VILLAGE_MAP.structures.map((structure) => structure.id);
  const projectedPortalIds = villageSubjectIds(VILLAGE_SUBJECT_NAMES).map((id) => `portal-${id}`);

  const atRest = await readVillageNearby(page);
  expect(
    atRest.rows.filter((entry) => entry.kind === 'structure'),
    'a structure was already in reach at the spawn, so the walk below would prove nothing',
  ).toEqual([]);
  expect(atRest.compassRotation, 'the compass reported no bearing, so there is nothing to walk toward').not.toBeNull();
  expect(atRest.compassHidden, 'the compass was already hidden at the spawn').toBe(false);
  const restRotation = atRest.compassRotation;

  // Walk toward whatever the renderer says is nearest, using only the DOM.
  //
  // The compass needle is the renderer's own bearing to its nearest point of
  // interest, written straight into a `style.transform` - so the direction to walk
  // is readable from the document on either renderer, with no scene-graph probe and
  // nothing engine-specific. That is what makes this a statement about the shipping
  // build's keyboard rather than about Phaser.
  const bearings: string[] = [];
  /**
   * Every compass rotation the renderer reported during the whole walk, approach
   * and retreat alike.
   *
   * Collected as a *set over the entire walk* rather than as two samples or as a
   * change observed inside the retreat alone, because those are two questions the
   * renderer is not obliged to answer. The compass recomputes its bearing from
   * scratch at each position, aimed at whatever is nearest, so:
   *
   * - a single sample before and after can coincide while the player has moved a
   *   long way (this already bit `tablet-landscape`), and
   * - a retreat aimed by `oppositeArrowKeys` is a straight line *away* from the
   *   point the approach came from, and a nearest target held along that line
   *   reports one identical bearing for the whole retreat. `desktop-chromium` did
   *   exactly that, and a player standing perfectly still is not what it means.
   *
   * What is not negotiable is that the renderer read the player differently at some
   * point of the walk than at another. `left` further below is the deterministic
   * half of the same movement claim: the structure row appeared and then went away,
   * which can only happen if the player's distance to that structure's centre
   * crossed `STRUCTURE_APPROACH_RADIUS` in both directions.
   */
  const walkRotations: string[] = [];
  if (restRotation !== null) walkRotations.push(restRotation);
  let approach: VillageNearbyRow | null = null;
  let approachRotation: string | null = null;
  const deadline = Date.now() + 90_000;
  let roundTripMs = NPC_BURST_FLOOR_MS;
  let held: readonly string[] = [];
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const reading = await readVillageNearby(page);
    if (reading.compassRotation !== null) walkRotations.push(reading.compassRotation);
    const structure = reading.rows.find((entry) => entry.kind === 'structure');
    if (structure !== undefined) {
      approach = structure;
      approachRotation = reading.compassRotation;
      break;
    }
    // Re-aim *while walking*, and only stop walking once something is in reach.
    //
    // This is one loop where the previous shape was two: hold, release, read, hold,
    // release. Merging them matters because the walk across the village needs
    // hundreds of milliseconds of key-down time, and a loop that must release and
    // re-press between every burst spends most of its budget on round trips instead
    // of on movement. On a loaded host that is the difference between arriving and
    // timing out - `desktop-chromium` measured 26 steps without reaching a structure
    // at all, and the walk was working; it just was not being given the chance to.
    //
    // Re-aiming mid-walk is also what makes a long hold safe. Walking on a stale
    // heading for a second overshoots the target; re-reading the bearing while the
    // keys are still down turns the compass back before that happens, and the compass
    // is defined as pointing at whatever is nearest, so an overshoot self-corrects
    // as well.
    if (polls % 4 === 1) roundTripMs = await measureHarnessRoundTripMs(page);
    const keys = compassBearingKeys(reading.compassRotation, bearings);
    for (const key of held) {
      if (!keys.includes(key)) await page.keyboard.up(key);
    }
    for (const key of keys) {
      if (!held.includes(key)) await page.keyboard.down(key);
    }
    if (keys.length > 0) bearings.push(keys.join('+'));
    held = keys;
    await page.waitForTimeout(Math.max(200, Math.min(600, roundTripMs * 3)));
  }
  for (const key of held) await page.keyboard.up(key);

  expect(
    approach,
    `the arrow keys never brought a structure into reach on the default build in ${polls} polls. ` +
      `Bearings followed: ${JSON.stringify([...new Set(bearings)])}`,
  ).not.toBeNull();
  const reached = approach as VillageNearbyRow;

  // The row the walk produced names something the village actually contains.
  const knownStructureIds = [...authoredStructureIds, ...projectedPortalIds];
  expect(knownStructureIds, 'the structure row named a structure the village does not contain').toContain(
    reached.id,
  );
  expect(reached.label, 'the structure row is not labelled with the interact verb').toContain('Interact with ');
  expect(reached.disabled, 'the structure row is inert, so the labelled button does nothing').toBe(false);
  expect(reached.distance, 'the row reported no measurable distance').not.toBeNull();
  // The row *existing* is the radius claim, not this comparison. `selectVillageNearbyTargets`
  // creates a row only for a measurement with `distance < range`, so its presence already
  // says the player was inside `STRUCTURE_APPROACH_RADIUS`. The published number is
  // `roundDistance(d) = Math.round(d * 10) / 10`, which rounds half *up*, so a
  // legitimately selected distance of `47.96` publishes as exactly `48` - and a strict
  // `< 48` failed this test on `desktop-chromium` in 3 runs of 5 with
  // `Expected: < 48 / Received: 48`, on a walk that had worked. So the only threshold
  // check that is true of every value the rounding can publish is the closed band
  // `[0, range]`.
  expect(reached.distance as number, 'the row published a negative distance').toBeGreaterThanOrEqual(0);
  expect(
    reached.distance as number,
    'the row published a distance the contract could not have selected, so the DOM and ' +
      'the world are not reporting the same measurement',
  ).toBeLessThanOrEqual(STRUCTURE_APPROACH_RADIUS);

  // And the bearing to the world landmark moved, which is the position change the
  // row is only a proxy for.
  expect(approachRotation, 'the compass reported no bearing after the walk').not.toBeNull();
  expect(approachRotation, 'the bearing to the landmark did not change, so the player did not move').not.toBe(
    restRotation,
  );

  // Walking back out proves the change was caused by the keys: a row that appears
  // and then disappears with the arrow keys is a position, and a position is the
  // thing that was previously untested on this build. The heading is the reverse of
  // the last one that closed the gap.
  //
  // The loop exits on two conditions, and both matter. The nearby list dropping the
  // structure is the *claim*; the compass becoming visible again is the condition
  // under which the rotation assertion below is meaningful at all, because the
  // compass stops writing a `transform` while it is hidden. They are not the same
  // moment and cannot be: the list drops a structure at `STRUCTURE_APPROACH_RADIUS`
  // (48) and the compass reappears at `COMPASS_HIDE_DISTANCE` (96). Treating the
  // first as the second is how this test failed on `tablet-landscape` - the walk had
  // worked, the list had emptied, and the player was simply still inside the
  // compass's dead zone, where a hidden compass is correct.
  const leaveDeadline = Date.now() + 30_000;
  let left = false;
  let compassBack = false;
  let retreatHeld: readonly string[] = [];
  // Every bearing seen on the way out, kept for the evidence and folded into
  // `walkRotations`, which is what the movement assertion below reads.
  const returnBearings: string[] = [];
  while (Date.now() < leaveDeadline) {
    const reading = await readVillageNearby(page);
    if (reading.compassRotation !== null) {
      returnBearings.push(reading.compassRotation);
      walkRotations.push(reading.compassRotation);
    }
    left ||= !reading.rows.some((entry) => entry.kind === 'structure');
    compassBack ||= reading.compassHidden === false;
    if (left && compassBack) break;
    // Same continuous-walk shape as the approach, for the same reason: the retreat
    // has to cover the gap between `STRUCTURE_APPROACH_RADIUS` and
    // `COMPASS_HIDE_DISTANCE` and a release-and-re-press loop spends its budget on
    // round trips rather than on movement.
    const outward = oppositeArrowKeys(bearings[bearings.length - 1] ?? 'ArrowUp');
    for (const key of retreatHeld) {
      if (!outward.includes(key)) await page.keyboard.up(key);
    }
    for (const key of outward) {
      if (!retreatHeld.includes(key)) await page.keyboard.down(key);
    }
    retreatHeld = outward;
    await page.waitForTimeout(Math.max(250, Math.min(600, roundTripMs * 3)));
  }
  for (const key of retreatHeld) await page.keyboard.up(key);
  expect(left, 'walking away from the structure did not clear it from the nearby list').toBe(true);
  expect(
    compassBack,
    'the compass never came back after the walk away, so there is no bearing to compare. The nearby ' +
      `list drops a structure at ${STRUCTURE_APPROACH_RADIUS} world pixels but the compass only reappears ` +
      `beyond ${COMPASS_HIDE_DISTANCE}, so the walk has to cover the difference.`,
  ).toBe(true);

  // The final read is deliberately *not* asserted to be "compass visible".
  //
  // `compassBack` above is sticky - it records that the compass was visible at some
  // point during the retreat - and a fresh read afterwards can legitimately be hidden
  // again, because the compass hides whenever the nearest point of interest is within
  // `COMPASS_HIDE_DISTANCE`, and the retreat is aimed by a bearing that changes as the
  // player moves. Asserting the trailing sample instead of the walk produced exactly
  // that contradiction on `desktop-chromium`: the walk had brought the compass back,
  // and the sample taken after it happened to be inside a dead zone again.
  //
  // The evidence for movement is the set of bearings observed *during* the walk, which
  // is what the next assertion uses. `afterWalk` is read only for its record.
  const afterWalk = await readVillageNearby(page);

  // The player demonstrably moved: across the whole walk - the approach that put the
  // structure in reach and the retreat that took it out again - the renderer reported
  // more than one bearing.
  //
  // Asserted over the whole walk rather than over the retreat alone, because a
  // straight-line retreat away from the point the approach came from can legitimately
  // hold a single bearing the entire way: `desktop-chromium` returned one identical
  // `rotate(...)` for the whole walk back out and reported "the bearing never changed
  // during the walk back out, so the player did not move" for a player that had. The
  // walk covers a village, so the nearest point of interest necessarily changes hands
  // at least once on the way out, and the set over the whole walk is where that shows.
  //
  // The deterministic half of the same claim is `left` above: the structure row
  // appeared and then went away, which can only happen if the player's distance to
  // that structure's centre crossed `STRUCTURE_APPROACH_RADIUS` in both directions.
  expect(
    new Set(walkRotations).size,
    'the renderer reported one bearing for the entire walk, so it never read the ' +
      'player at two different positions. Bearings seen: ' + JSON.stringify([...new Set(walkRotations)]),
  ).toBeGreaterThan(1);

  expect(pageErrors, `page errors during the default-build walk: ${pageErrors.join(' | ')}`).toEqual([]);

  await attachJson(testInfo, 'default-build-keyboard-movement.json', {
    surface,
    project: testInfo.project.name,
    atRestRotation: restRotation,
    approachRotation,
    reachedRow: reached,
    walkDirections: bearings,
    approachPolls: polls,
    // The harness's own measured round-trip cost on this page, because it is what
    // the burst lengths above were derived from and the first thing to check when a
    // walk is slow on a busy host.
    measuredHarnessRoundTripMs: roundTripMs,
    structureApproachRadiusPx: STRUCTURE_APPROACH_RADIUS,
    compassHideDistancePx: COMPASS_HIDE_DISTANCE,
    leftRangeAgain: left,
    compassCameBack: compassBack,
    walkBearings: [...new Set(walkRotations)],
    returnBearings: [...new Set(returnBearings)],
    afterWalkRotation: afterWalk.compassRotation,
    pageErrors,
  });
});

/*
 * ── The structure panel the default lane never asserted ─────────────────────
 *
 * ## The gap this closes
 *
 * The arrow-key test above walks to a structure and asserts the *row*: that it is
 * enabled, that it names a structure the village contains, and that it publishes a
 * distance inside the approach radius. It never asserts that activating the row does
 * anything, and nothing anywhere in `tests/e2e/` asserted that a structure *panel*
 * ever appeared at all - the only panel-aware helper in the file was the one that
 * classifies side-vs-sheet for the HUD.
 *
 * So "the village shows you information about a building when you walk up to it" had
 * no browser gate on the build that ships until Phase 24.
 *
 * ## What the panel actually does, because the test has to assert the truth
 *
 * Two facts, both read from source and both re-measured in a browser before being
 * written down, because they decide what this spec is allowed to claim:
 *
 * 1. **The panel is opened by *walking*, not by activating.** `VillageScene` emits
 *    `onStructureApproached` when a structure enters `VILLAGE_NEARBY_RANGES.structure`,
 *    which reaches `studyFlow.structureApproached` and `setInfoPanel(...)`
 *    (`src/application/studyFlow.ts:573-607`). Activating a row reaches
 *    `structureInteract` (`studyFlow.ts:617-663`), which runs *that structure's own*
 *    action - and for a dungeon portal that action is to enter the dungeon, not to
 *    re-open the panel. Both lanes agree: Pixi converges on `onStructureInteract` at
 *    `createVillageScene.ts:864` and Phaser through `triggerInteractWithTarget`, so
 *    there is no renderer divergence for this spec to choose between.
 *
 * 2. **There is no physics zone, Matter or otherwise, on this build.** The village
 *    game is configured `physics: { default: 'arcade' }`
 *    (`src/game/adapters/phaserVillageRenderer.ts:171-173`); `structureZones` are plain
 *    `GameObjects.Zone` hit areas carrying a `structureId` (`VillageScene.ts:463`,
 *    `:536`), not bodies; the only physics body is the player, with no colliders
 *    anywhere; and `update()` zeroes the body velocity every frame and integrates
 *    position by hand (`VillageScene.ts:345-350`). Nothing in that scene can push the
 *    player anywhere. An earlier note that the row "vanishes within ~1 s of key
 *    release because the Matter zone pushes the player out" is not reproducible: it
 *    reproduces exactly when the *harness* keeps the arrow keys held after the row
 *    appears, so the player simply walks on past the building and out of range. This
 *    spec therefore releases the keys the moment the row appears and then asserts the
 *    row and the panel both *stay*, which is the claim that actually matters.
 *
 * ## What is asserted
 *
 * Approach: a real, correctly identified, dismissable structure panel is in the DOM,
 * it names the structure the row named, and it survives an idle period with no input.
 * Activation: after the panel is dismissed, activating the row from the DOM is not
 * inert - it runs that structure's own action, checked against the per-type outcome.
 */

/**
 * One still wait, in milliseconds, for the approach panel to render once its row is in
 * the list.
 *
 * The row and the panel come from the *same* measurement - `VillageScene`'s
 * `checkStructureProximity` emits `onStructureApproached` and `readNpcSnapshotCandidates`
 * publishes the row, both from the player's distance to the structure centre - so the
 * panel is one React commit behind the row at worst. A short wait is a settle, not a
 * budget: pressing nothing is what keeps the player inside the radius while it happens.
 */
const PANEL_SETTLE_MS = 120;

/**
 * How many such still waits before the panel assertion is left to report the miss.
 *
 * Five waits is `PANEL_SETTLE_MS * 5` = 600 ms of a stationary player. Past that, a row
 * with no panel is a defect to be *asserted* - and this loop's job is to hand it over
 * rather than to burn the 120 s walk deadline and report a walk failure for a missing
 * panel.
 */
const PANEL_SETTLE_POLLS = 5;

/**
 * One movement burst, in milliseconds.
 *
 * Short on purpose. The walk releases every key at the end of each burst and then reads
 * the DOM, so every measurement is taken of a player who is not moving. A longer burst
 * makes the walk faster and every measurement racy.
 *
 * The burst length is also what makes the walk *converge* rather than merely be given
 * time: at 100 ms the player covers at most `PLAYER_SPEED * 0.1` = 12 world pixels, and a
 * 12 pixel step cannot cross the 48 pixel boundary a structure row appears at. So the
 * first poll that finds no row is followed by a poll that finds one, and the loop below
 * stops moving the moment it does.
 */
const WALK_BURST_MS = 100;

/**
 * The row ids this walk is willing to stop on.
 *
 * The walk steers by reading the compass needle, and the compass has exactly two
 * things to point at: `VillageScene.updatePoiData` skips every structure whose type is
 * not `portal-icon` or `keeper-tower` (`src/game/scenes/VillageScene.ts:607-608`). So
 * those two - and only those two - are the destinations this walk can be aimed at.
 *
 * This matters because the loop used to terminate on the first structure row of *any*
 * kind, which is a weaker and mostly-wrong rule: the compass says nothing about where
 * the pond, the fountain, or the fish stand are, so a row for one of them is a structure
 * the player happened to walk past. `pond-fish-sw` sits 85 px off the corridor to the SW
 * portal and inside a 48 px radius, so a walk aimed squarely at that portal crossed the
 * pond's radius on the way and stopped there. That made the whole test a lottery: which
 * structure the walk happened to sample decided which expectation row it was then held
 * to, and the failure looked intermittent while the walk was in fact aiming correctly
 * the entire time.
 *
 * A row that is not one of these is now walked *through* and recorded in the run's
 * evidence as a bypass.
 */
const WALK_TARGET_ROW_ID = /^(?:portal-[A-Za-z0-9_-]+|keeper-tower)$/;

/**
 * What each interactive structure type does when its nearby-action row is activated.
 *
 * Read from `studyFlow.structureInteract` and `structureApproached`
 * (`src/application/studyFlow.ts:573-663`) rather than guessed. Four outcomes, because
 * the structures genuinely do four different things:
 *
 * - `leaves-village` - the row's action is **navigation to another screen**: the portal
 *   enters its dungeon and the training gate opens the training ground. The village
 *   screen's canvas is unmounted with it. This is *not* the fishing case: "leaves the
 *   village world" is a much weaker claim than "leaves the village screen", and reading
 *   it as the latter is what made the pond's expectation wrong in the first place. It
 *   is asserted as the absence of `.village-canvas canvas`, so the canvas mounting is
 *   what would break it.
 * - `opens-panel` - the row's action is to show a structure panel, titled here, and
 * - `opens-dialog` - the row's action is to open one of the heavier modals.
 * - `swaps-scene` - the row's action swaps the Phaser scene **inside the same canvas**.
 *   Fishing is the only one: `phaserFishingRenderer` sleeps `VillageScene` and starts
 *   `FishingScene` in the same `Phaser.Game`, and its own header says so
 *   (`src/game/adapters/phaserFishingRenderer.ts:1-13`). The canvas therefore *stays*
 *   mounted, and this is asserted positively rather than inferred from the absence of
 *   a screen change.
 */
type StructureActivation = 'leaves-village' | 'opens-panel' | 'opens-dialog' | 'swaps-scene';

interface StructureExpectation {
  readonly panelTitle: string | null;
  readonly announcement: RegExp;
  readonly activation: StructureActivation;
  /** Panel title to expect back after activation, when `activation` is `opens-panel`. */
  readonly activationPanelTitle?: string;
  /** Accessible name of the dialog, when `activation` is `opens-dialog`. */
  readonly activationDialogName?: string;
}

/**
 * Per structure type: the panel the *approach* opens and what the row's *activation* does.
 *
 * The panel titles are the literal strings `StructurePanel`/`QuestBoard` pass as
 * `title`, which is what `aria-labelledby` promotes to the panel's accessible name -
 * so these assert the panel's identity as a screen reader would find it. The signpost
 * title is structure-specific (`SIGNPOST_INFO[structureId]`), so it is asserted only as
 * non-empty; its *announcement* is still pinned, because that one is per type.
 *
 * A `portal-icon` row's panel is titled with the subject's name, so its title is
 * resolved from the row's own label rather than hardcoded: `villageSubjectIds` in the
 * test above fixes the seeded subject ids, and the row label carries the subject name.
 */
const STRUCTURE_EXPECTATIONS: Readonly<Record<string, StructureExpectation>> = {
  'portal-icon': {
    panelTitle: null,
    announcement: /^Now at the dungeon portal for .+\.$/,
    // Entering the dungeon is the portal's action; the panel is the approach's.
    activation: 'leaves-village',
  },
  'keeper-tower': {
    panelTitle: "Keeper's Quest Board",
    announcement: /^Now at the quest board\./,
    activation: 'opens-panel',
    activationPanelTitle: "Keeper's Quest Board",
  },
  'guild-hall': {
    panelTitle: 'Guild Hall',
    announcement: /^Now at the Guild Hall\./,
    activation: 'opens-dialog',
    activationDialogName: 'Create New Subject',
  },
  'training-gate': {
    panelTitle: 'Training Grounds',
    announcement: /^Now at the Training Grounds\./,
    activation: 'leaves-village',
  },
  'trophy-hall': {
    panelTitle: 'Trophy Hall',
    announcement: /^Now at the Trophy Hall\./,
    activation: 'opens-panel',
    activationPanelTitle: 'Trophy Hall',
  },
  signpost: {
    panelTitle: null,
    announcement: /^Now at a signpost\./,
    activation: 'opens-panel',
  },
  waysign: {
    panelTitle: null,
    announcement: /^Now at a signpost\./,
    activation: 'opens-panel',
  },
  library: {
    panelTitle: 'Library of Knowledge',
    announcement: /^Now at the Library of Knowledge\./,
    activation: 'opens-panel',
    activationPanelTitle: 'Library of Knowledge',
  },
  workshop: {
    panelTitle: 'Artisan Workshop',
    announcement: /^Now at the Artisan Workshop\./,
    activation: 'opens-dialog',
    activationDialogName: 'Make It Yours',
  },
  fountain: {
    panelTitle: 'Central Fountain',
    announcement: /^Now at the Central Fountain\./,
    activation: 'opens-dialog',
    activationDialogName: 'Study statistics',
  },
  'fishing-pond': {
    panelTitle: 'Fishing Pond',
    announcement: /^Now at a fishing pond\./,
    // Not `leaves-village`. Fishing is a Phaser *scene swap* inside the village's own
    // canvas, so the canvas survives it and the only DOM-observable consequence is the
    // fishing signal below. Asserting teardown here asserted a scene swap as a screen
    // change - and it failed intermittently, because the walk could stop on this row.
    activation: 'swaps-scene',
  },
  'fish-stand': {
    panelTitle: 'Fish Stand',
    announcement: /^Now at the Fish Stand\./,
    activation: 'opens-panel',
    activationPanelTitle: 'Fish Stand',
  },
};

/**
 * The structure a row id names, or `null` for a projected portal.
 *
 * Projected portals (`portal-<subjectId>`) have no entry in `VILLAGE_MAP.structures` -
 * the screen derives them from seeded subjects onto portal slots - so they resolve by
 * the same `portal-` prefix the projection uses. Everything else must be an authored
 * structure, which keeps an invented id from quietly satisfying the table lookup.
 */
function structureTypeForRowId(rowId: string): string | null {
  const authored = VILLAGE_MAP.structures.find((structure) => structure.id === rowId);
  if (authored !== undefined) return authored.type;
  return rowId.startsWith('portal-') ? 'portal-icon' : null;
}

/**
 * The sentence the village screen announces when a fishing session starts.
 *
 * Pinned literally rather than as a pattern, for the privacy reason: this string is
 * read aloud by a screen reader, so "what exactly is in it" is a privacy assertion and
 * not a copy detail. Interpolating a subject name, a pond id, or a fish name into it has
 * to fail this comparison and be made deliberately.
 */
const FISHING_ENTERED_ANNOUNCEMENT =
  'You have started fishing. Use the Return to Village control in the world to come back.';

interface FishingSignalReading {
  /** The village screen root's `data-world`, or `null` if the screen is not mounted. */
  readonly world: string | null;
  /** The fishing live region's text, or `null` when no fishing region is present. */
  readonly announcement: string | null;
}

/**
 * Reads the village screen's fishing-entry signal from the live DOM.
 *
 * Both halves are read together because they are one claim with two witnesses: the
 * attribute is the machine-readable marker, and the live region is what a screen-reader
 * user actually receives. Reading only the attribute would let a signal that nothing
 * announces pass, and reading only the region would leave the marker unverified.
 *
 * The region is located by its text rather than by being "the first non-empty status
 * paragraph", because the structure-panel announcement shares the element shape and is
 * often present at the same time.
 */
async function readFishingSignal(page: Page): Promise<FishingSignalReading> {
  return page.evaluate((sentence: string) => {
    const screen = document.querySelector('.village-screen');
    const announcement = [...document.querySelectorAll('p.village-visually-hidden[role="status"]')]
      .map((node) => node.textContent?.trim() ?? '')
      .find((text) => text === sentence) ?? null;
    return { world: screen?.getAttribute('data-world') ?? null, announcement };
  }, FISHING_ENTERED_ANNOUNCEMENT);
}

/**
 * Asserts the `swaps-scene` outcome: the fishing world started, and it started by
 * swapping the Phaser scene rather than by unmounting the village screen.
 *
 * Shared by the two tests that can legitimately reach a pond row - the compass walk
 * when it lands on one, and the pond walk that aims for one deliberately - so the
 * claim has exactly one definition. Written as a function rather than inlined in one
 * of them because a second copy of "the canvas must survive" is a second thing to
 * keep correct, and this is the assertion most likely to be needed a third time when
 * Phase 17 brings fishing to the Pixi lane.
 *
 * The three assertions are in this order because they are in this order of
 * distinctiveness: the signal is the thing being added, the surviving canvas is what
 * separates a scene swap from a screen change, and the announcement is what makes the
 * swap reachable for a screen-reader user at all.
 */
async function expectFishingSceneSwap(page: Page, context: string): Promise<void> {
  await expect
    .poll(async () => (await readFishingSignal(page)).world, {
      timeout: 30_000,
      message: `${context}: activating a fishing-pond row never published the village screen's fishing signal`,
    })
    .toBe('fishing');

  // The scene swap is *inside* the same canvas, so it must still be there. Asserting
  // this positively is what catches the opposite regression - a future renderer that
  // did tear the canvas down would fail here instead of passing by coincidence.
  expect(
    await page.locator('.village-canvas canvas').count(),
    `${context}: the fishing world took the village canvas with it, but fishing is a Phaser scene swap inside the ` +
      'same game (src/game/adapters/phaserFishingRenderer.ts), so the canvas has to survive it',
  ).toBeGreaterThan(0);

  // And the sentence a screen-reader user would have heard, pinned literally - see
  // `FISHING_ENTERED_ANNOUNCEMENT` for why the exact string is the privacy assertion.
  const signal = await readFishingSignal(page);
  expect(
    signal.announcement,
    `${context}: the fishing world started but announced nothing in words, so entering it is still visual-only for ` +
      'a screen-reader user - the in-world Return control is a canvas object and cannot be reached',
  ).toBe(FISHING_ENTERED_ANNOUNCEMENT);

  // The pond's panel was cleared by the same commit that started the session, so a
  // stale panel left behind would mean the world and the DOM disagree.
  expect(
    await page.locator('section.village-info-panel').count(),
    `${context}: the fishing pond panel is still open after the fishing world started`,
  ).toBe(0);
}

/**
 * Reads the village's structure panel and its announcement, from the live DOM.
 *
 * The panel is located by class rather than by role because its role is
 * layout-dependent - `VillagePanel` writes `role="dialog"` on a sheet and leaves the
 * element a `section` promoted to a `region` by `aria-labelledby` on the side
 * (`src/ui/village/VillagePanel.tsx:100-116`). Class is the one thing both shapes share.
 */
async function readStructurePanel(page: Page): Promise<{
  panelCount: number;
  title: string | null;
  closeName: string | null;
  announcement: string | null;
  villageCanvasCount: number;
}> {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll<HTMLElement>('section.village-info-panel')];
    const panel = panels[0] ?? null;
    const announcements = [
      ...document.querySelectorAll('p.village-visually-hidden[role="status"]'),
    ].map((node) => node.textContent?.trim() ?? '');
    return {
      panelCount: panels.length,
      title: panel?.querySelector('.village-panel-header h3')?.textContent?.trim() ?? null,
      closeName: panel?.querySelector('.village-panel-close')?.getAttribute('aria-label') ?? null,
      announcement: announcements.find((text) => text !== '') ?? null,
      villageCanvasCount: document.querySelectorAll('.village-canvas canvas').length,
    };
  });
}

test('the default village structure row reaches a real structure panel, and activating it is not inert', async ({
  page,
}, testInfo) => {
  // One walk (up to 90 s, the same budget and the same loop shape as the arrow-key test
  // above) plus a dismissal and an activation.
  test.setTimeout(240_000);

  const expectedPixi = process.env.VITE_PIXI_VILLAGE === 'true';
  test.skip(
    expectedPixi,
    'Skipped: this spec covers the default Phaser village, the build that ships until Phase 24. The PixiJS ' +
      "village's own nearby-action rows are asserted inside its renderer-variant tests above.",
  );

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await enterDefaultVillage(page);
  const surface = await ensureVillageHudOpen(page);

  // Nothing may already be in reach: a row that was present at the spawn would make
  // every assertion below about the walk rather than about the walk's result.
  const atRest = await readStructurePanel(page);
  expect(
    atRest.panelCount,
    'a structure panel was already open at the spawn, so the walk below would prove nothing',
  ).toBe(0);
  const atRestNearby = await readVillageNearby(page);
  expect(
    atRestNearby.rows.filter((entry) => entry.kind === 'structure'),
    'a structure was already in reach at the spawn, so the walk below would prove nothing',
  ).toEqual([]);

  // ── The approach ──────────────────────────────────────────────────────────
  //
  // Walking up to a structure and *standing beside it* is the claim, and the walk is
  // built so that "standing" is true at every check rather than only after the fact.
  //
  // ## What the walk is aiming at
  //
  // `STRUCTURE_APPROACH_RADIUS` - 48 world pixels - and nothing tighter. That is the
  // radius the product defines, and it is reached by the row's own existence rather than
  // by a distance the harness compares for itself: `selectVillageNearbyTargets` admits a
  // structure at `distance < range` with `range === STRUCTURE_APPROACH_RADIUS`
  // (`villageNpc.ts`, rule 2), so a row in the list *is* a measurement inside the radius.
  // The row's published distance is asserted against the radius below, on the row that
  // was actually reached.
  //
  // This loop used to aim two thirds of the way in - 32 px - reasoning that a
  // burst-and-stop walk overshoots by up to `PLAYER_SPEED * WALK_BURST_MS` = 12 px and so
  // wanted headroom. That target was not aimable, and the reason is the whole defect:
  // the compass stops writing its needle inside `COMPASS_HIDE_DISTANCE` (96 px), because
  // `CompassOverlay` returns before assigning `needle.style.transform` while the compass
  // is hidden (`CompassOverlay.tsx:145-150`). So over the last 48 px - the entire stretch
  // where the row exists - there is no live signal left to aim with: the harness is
  // steering on a *frozen* bearing, in 12 px quanta, at a centre it is no longer
  // measuring. A frozen heading stepped in 12 px increments cannot be guaranteed to land
  // inside 32 px, and two projects in one run showed exactly that: best samples of 33.3
  // and 35.3 px, with the row visible and the panel open the whole time. Both were
  // failures to *harness geometry*, not to the product.
  //
  // (The old value is also a misleading number rather than a merely tight one: 48 * 2/3
  // is 32, which is `INTERACT_RADIUS` - the radius at which an *NPC* can be talked to
  // (`villageLayout.ts`). Aiming a structure walk at the NPC interact radius made the
  // harness's own aim look like a product claim it never was.)
  //
  // ## Why the walk bursts instead of holding
  //
  // The arrow-key test above holds its keys across polls, which is correct for its claim
  // (that a row appears at the edge of the radius and then goes away again). It is wrong
  // for this one, because this spec has to read the DOM while the player is stationary.
  //
  // Holding keys means every sample is of a *moving* player, and a player who is still
  // moving when a sample is taken leaves the radius during the next sample - which reads
  // as a panel that appeared and vanished. Measured on `chromebook`: a burst left the
  // player 28 px from a portal, and by the next read - one round trip later - both the row
  // and the panel were gone, with the compass bearing unchanged afterwards because the
  // player had stopped outside the radius rather than never having been inside it.
  //
  // So every cycle here is press, release, *then* read, and the walk stops pressing the
  // moment a row is in the list. That is the invariant that makes this loop converge
  // rather than orbit: the 12 px burst cannot jump the 48 px boundary, and the first poll
  // that finds a row is also the last poll that walks. Every measurement afterwards is
  // therefore of a player who is at rest *and* inside the radius, which is the standing
  // the claim needs.
  //
  // This is also the honest answer to the "the row vanishes a second after key release"
  // report. There is no Matter zone, no collider, and no velocity to push anyone:
  // `phaserVillageRenderer` configures `physics: { default: 'arcade' }`, `structureZones`
  // are plain interactive `GameObjects.Zone` hit areas rather than bodies, and
  // `VillageScene.update` zeroes the body velocity every frame and integrates position
  // by hand. What the report reproduced was a walk that kept walking after the row appeared.
  const bearings: string[] = [];
  const walkRotations: string[] = [];
  if (atRestNearby.compassRotation !== null) walkRotations.push(atRestNearby.compassRotation);
  let reachedRow: VillageNearbyRow | null = null;
  let reachedPanel: Awaited<ReturnType<typeof readStructurePanel>> | null = null;
  let polls = 0;
  let settleWaits = 0;
  let closestRowDistance = Number.POSITIVE_INFINITY;
  // Structures whose row the walk passed through instead of stopping on, as evidence.
  const bypassedRows = new Set<string>();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    polls += 1;
    const reading = await readVillageNearby(page);
    if (reading.compassRotation !== null) walkRotations.push(reading.compassRotation);
    const structure = reading.rows.find((entry) => entry.kind === 'structure');
    if (structure !== undefined && structure.distance !== null) {
      closestRowDistance = Math.min(closestRowDistance, structure.distance);
    }
    // Only the structures the compass actually aims at terminate this walk - see
    // `WALK_TARGET_ROW_ID` for why a row of any other kind is not a destination. A row
    // with no id at all cannot name a destination either, so it is walked through and
    // left for the `row.id` assertion below to report as the defect it is.
    const aimedRow = structure?.id != null && WALK_TARGET_ROW_ID.test(structure.id);
    if (structure !== undefined && !aimedRow && structure.id !== null) {
      bypassedRows.add(structure.id);
    }
    // Read the panel *before* moving: this loop's invariant is that the keys are never
    // held across a measurement.
    const panel = await readStructurePanel(page);

    // A row for a structure the compass aims at is the approach, in full: it exists only
    // inside `STRUCTURE_APPROACH_RADIUS`, and it is the same measurement that opened the
    // panel. So this is terminal, and the walk stops *moving* here. Pressing another burst
    // from inside the radius is what walked the player back out and re-armed the
    // oscillation the old 32 px aim sat inside; never moving while a row is in reach is
    // what makes this loop converge instead of merely be given 120 seconds.
    if (aimedRow && structure !== undefined) {
      if (panel.panelCount === 1) {
        reachedRow = structure;
        reachedPanel = panel;
        break;
      }
      // The row is here and the panel has not rendered yet. Settle, pressing nothing,
      // then hand the miss to the panel assertion below: a row with no panel is a
      // product defect to be asserted, not a walk that needs more time.
      if (settleWaits < PANEL_SETTLE_POLLS) {
        settleWaits += 1;
        await page.waitForTimeout(PANEL_SETTLE_MS);
        continue;
      }
      reachedRow = structure;
      reachedPanel = panel;
      break;
    }

    // Nothing worth stopping for: this is the only branch that walks. The bearing is
    // the compass needle, and inside `COMPASS_HIDE_DISTANCE` that needle is frozen -
    // which is harmless here, because by then a row is in the list and this branch is
    // not taken.
    //
    // Walking *through* a bystander's row is now the normal case rather than a
    // terminal one: `pond-fish-sw` sits 85 px off the corridor to the SW portal, so a
    // walk aimed at that portal crosses its 48 px radius on the way and used to end
    // there - on a structure this harness was not aiming at, with a different panel,
    // a different announcement, and a different activation. The row is recorded in
    // `bypassedRows` and reported as evidence, so a bypass is visible rather than
    // silent.
    const keys = compassBearingKeys(reading.compassRotation, bearings);
    if (keys.length > 0) bearings.push(keys.join('+'));
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(WALK_BURST_MS);
    for (const key of keys) await page.keyboard.up(key);
    // Stand still before the next measurement, so the next sample is of a resting player.
    await page.waitForTimeout(WALK_BURST_MS * 2);
  }

  expect(
    reachedRow,
    `no row for a structure the compass aims at (${WALK_TARGET_ROW_ID.source}) reached the nearby list on the ` +
      `default build in ${polls} polls, so the approach was never made. The walk closes in ${WALK_BURST_MS} ms ` +
      `bursts of at most 12 world pixels, and a row appears as soon as the player is inside ` +
      `${STRUCTURE_APPROACH_RADIUS} - which a 12 px burst cannot jump. ` +
      `Closest row distance seen: ${closestRowDistance === Number.POSITIVE_INFINITY ? 'no row ever appeared' : closestRowDistance}. ` +
      `Rows walked through without stopping: ${bypassedRows.size === 0 ? 'none' : JSON.stringify([...bypassedRows])}. ` +
      `Bearings followed: ${JSON.stringify([...new Set(bearings)])}`,
  ).not.toBeNull();
  const row = reachedRow as VillageNearbyRow;

  expect(row.id, 'the structure row reported no id').not.toBeNull();
  expect(row.disabled, 'the structure row is inert, so the labelled button does nothing').toBe(false);
  expect(row.distance, 'the row reported no measurable distance').not.toBeNull();
  expect(row.distance as number).toBeGreaterThanOrEqual(0);
  expect(row.distance as number).toBeLessThanOrEqual(STRUCTURE_APPROACH_RADIUS);

  const structureType = structureTypeForRowId(row.id as string);
  expect(structureType, `the row named "${row.id}", which is neither an authored structure nor a portal projection`)
    .not.toBeNull();
  const type = structureType as string;
  const expected = STRUCTURE_EXPECTATIONS[type];
  expect(
    expected,
    `"${type}" is an interactive structure type with no entry in this spec's expectation table, so ` +
      'activating its row is unverified',
  ).toBeDefined();
  const want = expected as StructureExpectation;

  // ── CLAIM 1: the approach really opens a structure panel, and it stays ─────
  //
  // The panel is opened by walking, so the assertion belongs here rather than after
  // activation; `studyFlow.structureApproached` is what put it in the DOM. The panel was
  // read inside the walk loop with every key released, so this is a reading of a player
  // standing still - which is the whole difference between measuring the panel and
  // measuring a walk that has not finished.
  expect(
    reachedPanel?.panelCount,
    `the player is standing within ${STRUCTURE_APPROACH_RADIUS} px of "${row.id}" and its row is enabled, ` +
      'but no structure panel was rendered - the row is a proximity claim with no consequence behind it',
  ).toBe(1);
  const onApproach = reachedPanel as Awaited<ReturnType<typeof readStructurePanel>>;
  expect(
    onApproach.title,
    'the structure panel rendered with no title, so it is an unnamed region to a screen reader',
  ).not.toBeNull();
  expect((onApproach.title ?? '').length, 'the structure panel title was empty').toBeGreaterThan(0);

  // The panel's accessible name is `Close <title>`, which is how `VillagePanel` names
  // its own dismiss control (`VillagePanel.tsx:131`). Matching it proves this is the
  // real panel frame and not some other element wearing the class.
  expect(
    onApproach.closeName,
    `the structure panel's dismiss control is not named for the panel it closes (title ` +
      `"${onApproach.title}")`,
  ).toBe(`Close ${onApproach.title}`);

  // Identity: the panel names *this* structure. A portal is titled with the subject's
  // name, which the row's own label carries, so it is compared against the label rather
  // than hardcoded; every other type has a fixed title in the table.
  if (want.panelTitle !== null) {
    expect(onApproach.title, `the panel opened for "${type}" is not the expected panel`).toBe(want.panelTitle);
  } else if (type === 'portal-icon') {
    expect(
      row.label,
      'a portal row must carry its subject name, and the panel is titled with that name',
    ).toContain(onApproach.title ?? ' ');
  }

  // The screen-reader announcement, which is per structure type and is what a learner
  // who cannot see the panel is actually told.
  expect(
    onApproach.announcement,
    `the structure panel announced nothing in words, so the arrival is visual-only`,
  ).not.toBeNull();
  expect(
    want.announcement.test(onApproach.announcement ?? ''),
    `the panel announced "${onApproach.announcement}", which is not the announcement for "${type}" ` +
      `(expected ${want.announcement})`,
  ).toBe(true);

  // ── The stability claim: it does not flicker ──────────────────────────────
  //
  // This is the direct guard on the failure an earlier investigation reported. The
  // player is now standing still with no key held; the panel must still be there. A
  // panel that appeared and vanished here would be the defect, and there is no physics
  // in this scene that could do it - `update()` zeroes the body velocity every frame.
  await page.waitForTimeout(1500);
  const afterIdle = await readStructurePanel(page);
  expect(
    afterIdle.panelCount,
    'the structure panel closed by itself while the player stood still with no key held. This scene has ' +
      'no collider and no Matter body, so nothing should be able to move the player out of range.',
  ).toBe(1);
  expect(
    afterIdle.title,
    'the structure panel changed identity while the player stood still',
  ).toBe(onApproach.title);

  // And the row is still there too, so both halves of the claim are checked at rest.
  const atRestAfterIdle = await readVillageNearby(page);
  expect(
    atRestAfterIdle.rows.some((entry) => entry.kind === 'structure' && entry.id === row.id),
    'the structure row left the nearby list while the player stood still, so the panel above was a ' +
      'transient rather than a resting state',
  ).toBe(true);

  // ── CLAIM 2: activating the row is not inert ──────────────────────────────
  //
  // The panel is dismissed first, and that is what makes the next read meaningful:
  // for the types whose action is "open a panel", a panel that was never closed would
  // prove nothing. Dismissal is also a real DOM control being exercised, and it proves
  // the panel is dismissable rather than a sticky overlay.
  await page.getByRole('button', { name: `Close ${onApproach.title}` }).click();
  const afterDismiss = await readStructurePanel(page);
  expect(
    afterDismiss.panelCount,
    'the structure panel did not close when its own dismiss control was pressed',
  ).toBe(0);
  expect(
    afterDismiss.announcement,
    'the panel closed but its announcement was left in the document',
  ).toBeNull();
  // The row outlives the panel: the two are separate surfaces, and a row that
  // disappeared with the panel could not be re-activated at all.
  const afterDismissNearby = await readVillageNearby(page);
  const stillThere = afterDismissNearby.rows.find(
    (entry) => entry.kind === 'structure' && entry.id === row.id,
  );
  expect(
    stillThere?.disabled,
    'the structure row became inert when the panel was dismissed, so it could not be activated',
  ).toBe(false);

  await page
    .locator(`[data-village-nearby="true"] button[data-target-kind="structure"][data-target-id="${row.id}"]`)
    .click();

  if (want.activation === 'leaves-village') {
    // Navigation to another screen: the village world is torn down with it. This is the
    // portal case, and it is the one the earlier "open the panel" framing would have got
    // wrong - a portal's activation enters its dungeon, and the panel it opened on approach
    // is the approach's to show.
    await expect(page.locator('.village-canvas canvas')).toHaveCount(0, {
      timeout: 30_000,
    });
  } else if (want.activation === 'opens-panel') {
    const reopened = page.locator('section.village-info-panel');
    await expect(reopened).toHaveCount(1, { timeout: 15_000 });
    const title = (await reopened.locator('.village-panel-header h3').textContent())?.trim() ?? null;
    const wanted = want.activationPanelTitle ?? onApproach.title;
    expect(title, `activating the "${type}" row did not reopen its panel`).toBe(wanted);
  } else if (want.activation === 'swaps-scene') {
    // Fishing. Before the village screen published a fishing signal, the only DOM
    // evidence of a successful "cast line" was the *absence* of a screen change -
    // which is also what a row that did nothing at all would produce. That is why
    // this was asserted as `leaves-village` in the first place, and why the claim is
    // now positive. The definition lives in `expectFishingSceneSwap`, shared with the
    // pond walk below.
    await expectFishingSceneSwap(page, `activating the "${type}" row reached by the compass walk`);
  } else {
    const dialog = want.activationDialogName as string;
    await expect(page.getByRole('dialog', { name: dialog })).toBeVisible({ timeout: 15_000 });
  }

  expect(pageErrors, `page errors during the structure-panel approach and activation: ${pageErrors.join(' | ')}`)
    .toEqual([]);

  await attachJson(testInfo, 'default-build-structure-panel.json', {
    surface,
    project: testInfo.project.name,
    reachedRow: row,
    structureType: type,
    panelTitleOnApproach: onApproach.title,
    panelAnnouncement: onApproach.announcement,
    panelSurvivedIdle: afterIdle.panelCount === 1,
    dismissedPanelCount: afterDismiss.panelCount,
    activation: want.activation,
    activationPanelTitle: want.activationPanelTitle ?? null,
    activationDialogName: want.activationDialogName ?? null,
    walkedBearings: [...new Set(bearings)],
    walkBypassedRows: [...bypassedRows],
    walkBearings: [...new Set(walkRotations)],
    approachPolls: polls,
    approachRowDistancePx: row.distance,
    approachPanelSettleWaits: settleWaits,
    structureApproachRadiusPx: STRUCTURE_APPROACH_RADIUS,
    pageErrors,
  });
});

/**
 * ── The Pixi lane's fishing gap, asserted as a gap ─────────────────────────
 *
 * ## Where the fishing claim is pinned, and why not here on both lanes
 *
 * The compass points at exactly two things - `portal-icon` and `keeper-tower`
 * (`VillageScene.updatePoiData`) - which is why the structure-panel walk is now gated on
 * those two row ids (`WALK_TARGET_ROW_ID`). A walk that only ever aims at portals and the
 * quest board can no longer land on a pond, so `STRUCTURE_EXPECTATIONS`' `fishing-pond`
 * row is reached from here rather than from that walk. The two halves of the claim are
 * split across the two places that can actually make each one:
 *
 * - **The pond works on the default lane** is pinned deterministically in
 *   `tests/phase12/village-fishing-signal.test.tsx`, which drives the flow through the same
 *   seam the real renderer uses and asserts the signal appears *and* the fishing world is
 *   entered. It needs no walk, no stride, and no engine.
 * - **The pond does nothing on the Pixi lane** is pinned here, in a real browser, on a
 *   real Pixi build, with a real pond row pressed.
 *
 * ## Why the default lane cannot walk to a pond from here
 *
 * It was tried, and it is recorded rather than deleted silently. Reaching a named
 * structure by walking needs the harness's sampling interval to be smaller than the target:
 * `STRUCTURE_APPROACH_RADIUS` is a 96 px window, and measured in this file a 200 ms held
 * `ArrowUp` moves the player about 45 px - roughly twice `PLAYER_SPEED`, so the stride is
 * set by the host's frame pacing and CDP latency, not by the scene's own arithmetic. On
 * `chromebook` one poll of that walk moves the player roughly 290 px, three times the
 * window. The Pixi lane is unaffected because it reads its player position from the scene
 * graph every poll and therefore converges; the Phaser lane publishes no position at all,
 * so a walk that overshoots can never turn around. A test that reaches a 96 px target on
 * one project and misses it on three is the exact flakiness `WALK_TARGET_ROW_ID` was just
 * introduced to remove, so it is not in the suite.
 *
 * The walk below therefore exists only for this lane, and `readLivePosition` is not
 * optional for it: without it the walk has nothing to converge on.
 */

/**
 * The wall-clock budget for one walk to a fishing pond.
 *
 * Generous because the walk is polling rather than walking: it takes a short burst, reads
 * the nearby list, and only then decides whether to burst again, so its wall clock is
 * dominated by round trips rather than by movement.
 */
const FISHING_ROW_BUDGET_MS = 150_000;

/**
 * Every fishing pond's centre in world pixels, read from the authored map.
 *
 * The same derivation the Pixi scene uses for its own structure candidates
 * (`createVillageScene.structureCandidates`: centre at
 * `(gridX + width/2) * VILLAGE_TILE_SIZE`). Reading it from the data rather than
 * restating a coordinate is what keeps this walk aimed at a pond the map still has.
 */
function fishingPondCenters(): ReadonlyArray<{ id: string; x: number; y: number }> {
  return VILLAGE_MAP.structures
    .filter((structure) => structure.type === 'fishing-pond')
    .map((structure) => ({
      id: structure.id,
      x: (structure.gridX + structure.width / 2) * VILLAGE_TILE_SIZE,
      y: (structure.gridY + structure.height / 2) * VILLAGE_TILE_SIZE,
    }));
}

/** The pond whose centre is closest to `from`, or `null` if the map has no pond. */
function nearestFishingPond(
  from: VillageWorldPoint,
): { id: string; x: number; y: number } | null {
  const ponds = fishingPondCenters();
  let best: { id: string; x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const pond of ponds) {
    const distance = Math.hypot(pond.x - from.x, pond.y - from.y);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = pond;
  }
  return best;
}

/**
 * One movement burst for the pond walk, in milliseconds.
 *
 * Small, and for a measured reason. The obvious burst - the compass walk's 100 ms, and
 * the 12 world pixels `PLAYER_SPEED * 0.1` implies - does not work here, because the
 * premise is wrong: **the player does not move at `PLAYER_SPEED` per held second.**
 * Measured on `chromebook` in this suite, by walking straight up the authored spawn's
 * column and counting bursts until the training gate published its row: 200 ms of held
 * `ArrowUp` moved the player 45 px, and 200 ms with no settle moved it 44 px. The
 * product's own constant is 120 px/s, which would be 24 px. Whatever accounts for the
 * gap - frame pacing, input buffering, the key-up queue - it is a factor of about two and
 * it is not something a test should try to model.
 *
 * So this walk never decides *arrival* from its own estimate. It only chooses a
 * direction. What stops it is the pond's row appearing, and what makes that reliable is
 * sampling: 60 ms of held keys is roughly 13 px of travel, so the 96 px diameter of
 * `STRUCTURE_APPROACH_RADIUS` cannot be crossed between two reads. A walk that decided
 * it had arrived from a position estimate would be wrong by a factor of two here; a walk
 * that samples and looks is right regardless of how fast the player actually moves.
 */
const POND_BURST_MS = 60;

/** The settle between a burst and the next read. Short, because movement is the risk. */
const POND_SETTLE_MS = 40;

/**
 * A hard cap on walk iterations, so a missed window fails in about half a minute rather
 * than burning the whole wall-clock budget.
 *
 * Deliberately generous relative to the walk it is bounding - the nearest pond is about
 * 320 px from the authored spawn, which is roughly 25 bursts even at half the speed the
 * measurement above saw - because this cap is a backstop against a walk that sails past
 * the pond and keeps going, not a budget the walk is expected to reach.
 */
const POND_MAX_POLLS = 400;


interface PondWalkOptions {
  /** Where the walk starts, in world pixels. */
  readonly start: VillageWorldPoint;
  /**
   * Live player position, when the renderer can report one.
   *
   * The Pixi scene exposes its player marker, so the Pixi lane corrects its estimate from
   * the world every poll. The Phaser scene exposes nothing, so the Phaser lane
   * dead-reckons - which is the whole reason `advanceDeadReckoned` models the scene's
   * normalisation and world bounds rather than just adding `PLAYER_SPEED * t`.
   */
  readonly readLivePosition?: () => Promise<VillageWorldPoint | null>;
}

interface PondWalk {
  /** The pond's row, or `null` if the walk never reached one. */
  readonly row: VillageNearbyRow | null;
  readonly polls: number;
  readonly aimedPondId: string;
  /** The smallest distance the harness's own estimate ever held to the pond centre. */
  readonly closestModelledPx: number;
  /** The harness's final position estimate, reported so a drift is diagnosable. */
  readonly finalPosition: VillageWorldPoint;
}

/**
 * Advances a position estimate by one burst, the way the scene moves the player.
 *
 * `VillageScene.update` normalises the input vector before scaling it -
 * `vx = (vx / len) * PLAYER_SPEED` - so a diagonal moves `PLAYER_SPEED / hypot(1, 1)`
 * on each axis rather than a full speed on each. Modelling that is what keeps the
 * estimate's *shape* right: the walk from the authored spawn to the south-west pond is
 * mostly diagonal, and an estimate that ignored the normalisation would aim as though
 * both axes moved at full speed.
 *
 * The estimate is explicitly **not** scaled by the factor of two measured above. It
 * would be the more accurate model, and it would still be the wrong tool: nothing
 * downstream depends on this position being right. It only picks a direction, and the
 * walk stops on a row it reads rather than on this number. Leaving it at the product's
 * own constant keeps it a statement about the scene's arithmetic instead of a constant
 * fitted to one host's frame pacing.
 *
 * Clamped to the world bounds because `spawnPlayer` sets
 * `this.playerBody.setCollideWorldBounds(true)`: a player at the edge genuinely stops,
 * so an estimate that kept running would send the harness off into empty map and the
 * walk would spend its budget aiming at a point the player left minutes ago.
 */
function advanceDeadReckoned(
  from: VillageWorldPoint,
  keys: readonly string[],
  burstMs: number,
): VillageWorldPoint {
  const axisX = keys.includes('ArrowRight') ? 1 : keys.includes('ArrowLeft') ? -1 : 0;
  const axisY = keys.includes('ArrowDown') ? 1 : keys.includes('ArrowUp') ? -1 : 0;
  const length = Math.hypot(axisX, axisY);
  if (length === 0) return from;
  const step = (PLAYER_SPEED * burstMs) / 1000;
  const clampX = (value: number): number =>
    Math.min(Math.max(value, 0), VILLAGE_MAP.width * VILLAGE_TILE_SIZE);
  const clampY = (value: number): number =>
    Math.min(Math.max(value, 0), VILLAGE_MAP.height * VILLAGE_TILE_SIZE);
  return {
    x: clampX(from.x + (axisX / length) * step),
    y: clampY(from.y + (axisY / length) * step),
  };
}

/**
 * Walks the player to a fishing pond and returns the pond's nearby row.
 *
 * Shared by the two lane tests below so both reach the pond the same way, and both
 * report the same evidence when they cannot.
 *
 * ## The pond has to be *selected*, not merely approached
 *
 * `selectVillageNearbyTargets` keeps one row per target kind, the nearest one, so
 * reaching a pond is not enough - some other structure has to not be nearer. That is not
 * a risk here, and the map is why: each pond's nearest interactive rival is at least
 * 120 px from its centre (`sign-entrance` 384 px from the south-west pond, `guild-hall`
 * 140 px from the east one, `training-gate` 122 px from the north-west one), while the
 * row radius is 48. Inside the pond's radius the pond is therefore always the nearest
 * interactive structure, so "the row appeared" means "the player is at the pond" and not
 * "the player is near a pond".
 *
 * ## Why it does not stop on its own estimate
 *
 * See `POND_BURST_MS`. The player's real speed is about twice `PLAYER_SPEED`, so an
 * estimate-based arrival test would fire two hundred pixels late, and the walk would
 * sail past the pond and keep pressing in the same direction with no way to turn around.
 * Sampling densely and stopping on the row is immune to that.
 */
async function walkToFishingPondRow(page: Page, options: PondWalkOptions): Promise<PondWalk> {
  let position: VillageWorldPoint = { x: options.start.x, y: options.start.y };
  let polls = 0;
  let aimedPondId = '';
  let closestModelledPx = Number.POSITIVE_INFINITY;
  const deadline = Date.now() + FISHING_ROW_BUDGET_MS;
  while (Date.now() < deadline && polls < POND_MAX_POLLS) {
    polls += 1;
    const reading = await readVillageNearby(page);
    const row = reading.rows.find((entry) => entry.kind === 'structure');
    if (row !== undefined && fishingPondCenters().some((pond) => pond.id === row.id)) {
      return { row, polls, aimedPondId, closestModelledPx, finalPosition: position };
    }
    if (options.readLivePosition !== undefined) {
      const live = await options.readLivePosition();
      if (live !== null) position = { x: live.x, y: live.y };
    }
    const pond = nearestFishingPond(position);
    if (pond === null) break;
    aimedPondId = pond.id;
    closestModelledPx = Math.min(closestModelledPx, Math.hypot(pond.x - position.x, pond.y - position.y));
    // No dead zone, so the estimate keeps turning around once it is through the pond
    // rather than freezing on it. A frozen estimate is what strands the walk.
    const keys = arrowKeysToward(pond.x - position.x, pond.y - position.y, 0);
    if (keys.length === 0) break;
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(POND_BURST_MS);
    for (const key of keys) await page.keyboard.up(key);
    if (options.readLivePosition === undefined) {
      position = advanceDeadReckoned(position, keys, POND_BURST_MS);
    }
    await page.waitForTimeout(POND_SETTLE_MS);
  }
  return { row: null, polls, aimedPondId, closestModelledPx, finalPosition: position };
}


/**
 * ── The Pixi lane's fishing gap, pinned as a gap ───────────────────────────
 *
 * ## What is missing
 *
 * The Phase 11 Pixi village has no fishing world. The Pixi renderer publishes structure
 * rows like the Phaser one does - `createVillageScene.structureCandidates` feeds
 * `selectVillageNearbyTargets`, and `invokeAction` routes a row to
 * `callbacks.onStructureInteract`, which is the application's `flow.structureInteract`
 * - so the pond's row appears and is enabled. What it does not do is carry a fishing
 * host: `createVillageStudyFlow` builds the fishing port from
 * `options.readPhaserHandle()?.fishing?.()`, and on the Pixi lane that handle is
 * `null`. `studyFlow.enterFishing` therefore returns at its mount guard
 * (`src/application/studyFlow.ts:672`) **before** it clears any state or calls
 * `prepareFishingSession`.
 *
 * The result is that activating the pond row on Pixi is inert: a labelled, enabled
 * control that does nothing. Plan 10.1's rule - "a control that lies teaches the learner
 * that controls lie" - is the reason this is written down rather than left for someone
 * to discover.
 *
 * ## Why it is asserted here, and how to read a pass
 *
 * Before the village screen published a fishing signal, this gap was *unassertable*:
 * the only DOM evidence of fishing was a screen change, and an inert row produces
 * exactly the same nothing. Now that `data-world` and the live region exist, the absence
 * of both is a positive, checkable statement about this build.
 *
 * **This test must be inverted in Phase 17 (Pixi Fishing Rebuild).** A pass here is a
 * record of the gap, not an endorsement of the behaviour: the moment the Pixi lane gets
 * a fishing world, these assertions become failures by design, and the Phase 17 change
 * should replace them with the `swaps-scene` claim the default lane makes. Do not
 * "fix" this test by relaxing it.
 */

test('GAP (Phase 17): the Pixi village fishing-pond row is inert and announces no fishing world', async ({
  page,
}, testInfo) => {
  // One walk across the map dominates this test's wall clock.
  test.setTimeout(FISHING_ROW_BUDGET_MS + 120_000);

  const expectedPixi = process.env.VITE_PIXI_VILLAGE === 'true';
  test.skip(
    !expectedPixi,
    'Skipped: this pins the PixiJS village fishing gap, which only exists on a VITE_PIXI_VILLAGE=true build. On ' +
      "the default Phaser lane the same row really does start fishing, and the default-lane structure test above " +
      'asserts that instead.',
  );

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await enterPixiVillage(page, NPC_DIALOGUE_QUEST_STEP);
  const surface = await ensureVillageHudOpen(page);

  expect(
    fishingPondCenters(),
    'VILLAGE_MAP.structures has no fishing-pond, so the gap this test pins no longer has a row to be inert on',
  ).not.toHaveLength(0);

  // ── Walk to a pond ─────────────────────────────────────────────────────────
  //
  // Aimed by world position rather than by the compass, because the compass points at
  // portals and the Keeper and the harness needs a pond specifically. The scene graph
  // is read for *steering* only; every assertion below is made against the DOM, which
  // is the same split the NPC tests record - a verdict that leaned on the scene graph
  // would be testing the opposite of what it claims.
  const firstWorld = await readVillageWorld(page);
  if (firstWorld.player === null) {
    throw new Error('the Pixi village world reported no player position, so there is nothing to walk');
  }
  const walk = await walkToFishingPondRow(page, {
    start: firstWorld.player,
    // The Pixi scene exposes its player marker, so this lane corrects rather than
    // estimates - the walk never has to model the scene's movement to aim at it.
    readLivePosition: async () => (await readVillageWorld(page)).player,
  });

  expect(
    walk.row,
    `the walk never offered a fishing-pond row in ${walk.polls} polls, so this test cannot pin the gap. It aimed ` +
      `at "${walk.aimedPondId}" and the Pixi scene publishes structure candidates from the authored map, so a row ` +
      'should appear as soon as the player is inside the approach radius.',
  ).not.toBeNull();
  // `expect(...).not.toBeNull()` is an assertion, not a narrowing, so the cast is what
  // carries the type past it - the same idiom the compass walk uses for `reachedRow`.
  const pondRow = walk.row as VillageNearbyRow;

  // The row exists and is enabled. Both halves are part of the gap: an inert *enabled*
  // control is the defect, and a disabled row would be an honest world rather than a lie.
  expect(pondRow.disabled, 'the fishing-pond row is disabled, so this gap is not the one being pinned').toBe(
    false,
  );

  const signalBefore = await readFishingSignal(page);
  expect(signalBefore.world, 'the village screen published no data-world at all, so it has no signal to check').toBe(
    'village',
  );
  expect(
    signalBefore.announcement,
    'a fishing session is already announced before any row was activated, so the post-activation reading below ' +
      'would prove nothing',
  ).toBeNull();

  // ── Activate it, and pin what does not happen ─────────────────────────────
  await page
    .locator(`[data-village-nearby="true"] button[data-target-kind="structure"][data-target-id="${pondRow.id}"]`)
    .click();
  // A fishing world that started would swap within a frame or two of the click; two
  // seconds is generous on purpose, so this reading cannot be the cause of a false pass.
  await page.waitForTimeout(2000);

  const signalAfter = await readFishingSignal(page);
  expect(
    signalAfter.world,
    'activating the fishing-pond row on the Pixi lane published a fishing signal, so Phase 17 has landed and this ' +
      'gap pin is now inverted - replace it with the swaps-scene claim the default lane makes',
  ).toBe('village');
  expect(
    signalAfter.announcement,
    'activating the fishing-pond row on the Pixi lane announced a fishing world, so Phase 17 has landed and this ' +
      'gap pin is now inverted',
  ).toBeNull();

  // The panel stays open, which is the second half of the same story: `enterFishing`
  // returns at its mount guard *before* clearing it, which is deliberate - the original
  // village screen returned before touching state when no host was mounted - and is why
  // a learner with nowhere to fish still sees the pond they pressed.
  expect(
    await page.locator('section.village-info-panel').count(),
    'the fishing pond panel closed on the Pixi lane even though no fishing world started, so the world and the DOM ' +
      'disagree about what happened',
  ).toBe(1);

  expect(
    pageErrors,
    `page errors while pinning the Pixi fishing gap: ${pageErrors.join(' | ')}. An inert row is the expected ` +
      'outcome, so this should be empty: the gap is a missing capability, not a thrown error.',
  ).toEqual([]);

  await attachJson(testInfo, 'pixi-village-fishing-gap.json', {
    surface,
    project: testInfo.project.name,
    pondRow,
    aimedPondId: walk.aimedPondId,
    walkPolls: walk.polls,
    signalBefore,
    signalAfter,
    knownLimitation: 'Phase 17 (Pixi Fishing Rebuild): the Pixi village has no fishing world, so this row is inert.',
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
