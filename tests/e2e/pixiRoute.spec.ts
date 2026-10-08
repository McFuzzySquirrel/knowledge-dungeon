import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type JSHandle, type Page, type TestInfo } from '@playwright/test';

import { evidenceRelativePath, sanitizeRunnerImageLabel, sanitizeToolchainText } from './compat-evidence';
import {
  FISH_STAND_SW_POND_GRID,
  VILLAGE_SPAWN_GRID,
  WALK_SPAWN_TO_SW_POND,
  walkToStructureAndPress,
} from './fishing-harness';
import {
  PIXI_ROUTE_LANE,
  PIXI_ROUTE_MANIFEST_PATH,
} from './pixi-route-lane';
import {
  evaluateRouteMemoryRun,
  type PixiMemoryFinding,
  type RendererContextKind,
  type RouteMemorySample,
  type RouteWorldRelease,
} from './pixi-memory-series';

/**
 * The Phase 22 route-change renderer teardown lane.
 *
 * ## What it drives
 *
 * A real learner's route: Welcome -> Start Tutorial -> the PixiJS dungeon -> Home ->
 * the (Phaser) village -> on foot to the fishing pond -> the PixiJS pond overlay ->
 * Return to the village. At each transition the document is read: how many canvases
 * it holds, how many PixiJS `Application` objects are alive, and - for the world the
 * route just left - whether its canvas is still attached and its WebGL context is
 * still live.
 *
 * ## Why the reading is a release-side fact
 *
 * No API in a headless browser reports a live-WebGL-context count or a GPU memory
 * figure. What the lane *can* read is the state a correct teardown leaves behind:
 * the left world's `<canvas>` is detached and `isContextLost()` is `true` on its
 * context, because `Application.destroy({ removeView: true })` detaches the view and
 * the renderer releases its context. A defect that kept either is exactly the defect
 * the twenty-cycle lane cannot see, because there the previous world's canvas is
 * measured across a remount in the same route.
 *
 * ## Non-vacuity
 *
 * Two proofs, one per level. `tests/e2e/pixi-route-lane.test.ts` feeds the verdict a
 * synthetic retained sample and asserts it raises the two retention codes. The second
 * test in this file does the same in a real engine: it hands `evaluateRouteMemoryRun`
 * a sample built from the dungeon's *own live canvas*, read while it is still mounted,
 * and asserts the same codes - so a verdict that stopped checking attachment or the
 * context cannot pass both.
 *
 * Privacy: synthetic fixtures only. No learner data, no request body, no query
 * string, and no external host; every non-loopback request is aborted before the
 * application runs, exactly as `pixiMemory.spec.ts` does. The only storage this lane
 * writes is the set of dismissed UI tooltip ids and the touch/fishing hint flags, so
 * a first-run overlay cannot intercept a press.
 */

const REPO_ROOT = process.cwd();
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? 'local';
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');

const DUNGEON_SURFACE = '.pixi-dungeon-world';
const VILLAGE_SCREEN = '.village-screen';
const FISHING_WORLD = '.pixi-fishing-world';
const FISHING_HUD = '.fishing-hud';
const READY_SENTENCE = 'Dungeon presented';
const START_TUTORIAL = 'Start Tutorial';
const START_EXPLORING = 'Start exploring';
const RETURN_HOME = 'Return to subject selection';
const RETURN_TO_VILLAGE = 'Return to the village';

/* -------------------------------------------------------------------------- */
/* Probes and reads                                                            */
/* -------------------------------------------------------------------------- */

interface ProbeApplication {
  readonly renderer: unknown;
  readonly stage: unknown;
}

/** Install the app probe and dismiss the first-run tooltips before app code runs. */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      // The tooltip and hint "seen" flags. Static UI identifiers, no learner data.
      localStorage.setItem(
        'knowledge-dungeon:ui:tooltips:v1',
        JSON.stringify(['hud-info', 'hud-map', 'hud-teleport', 'fishing']),
      );
      localStorage.setItem('knowledge-dungeon:ui:touch-hint:v1', '1');
      localStorage.setItem('knowledge-dungeon:ui:fishing-hint:v1', '1');
    } catch {
      /* a realm with no storage is a realm this probe does not need */
    }
    const scope = globalThis as unknown as Record<string, unknown>;
    const applications: unknown[] = [];
    scope['__KD_PIXI_ROUTE_PROBE__'] = { applications };
    const previous = scope['__PIXI_APP_INIT__'];
    scope['__PIXI_APP_INIT__'] = (application: unknown) => {
      applications.push(application);
      if (typeof previous === 'function') (previous as (value: unknown) => void)(application);
    };
  });
}

async function blockExternalOrigins(page: Page): Promise<void> {
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
}

interface RouteReading {
  readonly liveCanvasCount: number;
  readonly applicationsCreated: number;
  readonly applicationsReleased: number;
  readonly applicationsRetained: number;
  readonly liveCanvasIsNew: boolean | null;
  readonly previous: RouteWorldRelease | null;
  /** The context kind of the currently mounted Pixi surface, or `none`. */
  readonly liveContextKind: RendererContextKind;
}

type PreviousReleaseReading = Omit<RouteWorldRelease, 'world'>;

async function readRoute(
  page: Page,
  previousCanvas: JSHandle<HTMLCanvasElement> | null,
  previousWorld: string,
): Promise<{ readonly reading: RouteReading; readonly liveCanvas: JSHandle<HTMLCanvasElement> }> {
  const liveCanvas = (await page.evaluateHandle(() =>
    document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas'),
  )) as JSHandle<HTMLCanvasElement>;

  const counts = (await page.evaluate(() => {
    const kindOf = (canvas: HTMLCanvasElement | null): string => {
      if (canvas === null) return 'none';
      if (canvas.getContext('webgl2') !== null) return 'webgl2';
      if (canvas.getContext('webgl') !== null) return 'webgl';
      if (canvas.getContext('2d') !== null) return 'canvas2d';
      return 'none';
    };
    const probe = (globalThis as unknown as Record<string, unknown>)['__KD_PIXI_ROUTE_PROBE__'] as
      | { applications: ProbeApplication[] }
      | undefined;
    const applications = probe?.applications ?? [];
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const live = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
    const released = applications.filter(
      (application) => application.renderer === null && application.stage === null,
    ).length;
    return {
      liveCanvasCount: canvases.length,
      applicationsCreated: applications.length,
      applicationsReleased: released,
      applicationsRetained: applications.length - released,
      liveContextKind: kindOf(live),
    };
  })) as unknown as Omit<RouteReading, 'previous' | 'liveCanvasIsNew'>;

  // Read the world the route left through the *handle*, not by passing it back into
  // `page.evaluate`: once a canvas is detached, passing it as an evaluate argument
  // resolves to `null` in some engines, and a null here would silently skip the
  // release assertion the lane exists for. `JSHandle.evaluate` addresses the node
  // directly, so a detached canvas is still readable.
  let previous: RouteWorldRelease | null = null;
  let liveCanvasIsNew: boolean | null = null;
  if (previousCanvas !== null) {
    const release = (await previousCanvas.evaluate((element) => {
      if (element === null) return null;
      const kindOf = (canvas: HTMLCanvasElement | null): string => {
        if (canvas === null) return 'none';
        if (canvas.getContext('webgl2') !== null) return 'webgl2';
        if (canvas.getContext('webgl') !== null) return 'webgl';
        if (canvas.getContext('2d') !== null) return 'canvas2d';
        return 'none';
      };
      const kind = kindOf(element);
      const context =
        kind === 'webgl2' || kind === 'webgl'
          ? (element.getContext('webgl2') ?? element.getContext('webgl'))
          : null;
      const live = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
      return {
        canvasConnected: element.isConnected,
        contextKind: kind,
        contextLost: context === null ? null : context.isContextLost(),
        liveCanvasIsNew: live !== element,
      };
    })) as (PreviousReleaseReading & { readonly liveCanvasIsNew: boolean }) | null;
    if (release === null) {
      throw new Error(
        'The world the route was supposed to have left was never captured: its canvas handle resolved to null. ' +
          'This is a harness defect - the release assertion would otherwise be skipped silently.',
      );
    }
    previous = { ...release, world: previousWorld };
    liveCanvasIsNew = release.liveCanvasIsNew;
  }

  const reading: RouteReading = { ...counts, previous, liveCanvasIsNew };
  return { reading, liveCanvas };
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

async function dismissOnboarding(page: Page): Promise<void> {
  const start = page.getByRole('button', { name: START_EXPLORING });
  if ((await start.count()) > 0) await start.first().click();
}

async function enterDungeon(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await page.getByRole('button', { name: START_TUTORIAL }).click();
  await expect(page.locator(DUNGEON_SURFACE)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(`${DUNGEON_SURFACE} [role="status"]`).filter({ hasText: READY_SENTENCE }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await dismissOnboarding(page);
}

async function leaveDungeon(page: Page): Promise<void> {
  await page.getByRole('button', { name: RETURN_HOME }).click();
  await expect(page.locator(VILLAGE_SCREEN)).toBeVisible({ timeout: 30_000 });
}

async function enterPond(page: Page): Promise<void> {
  const outcome = await walkToStructureAndPress(page, WALK_SPAWN_TO_SW_POND, async () => {
    const hud = page.locator(FISHING_HUD);
    return (await hud.count()) > 0 && (await hud.first().isVisible());
  });
  if (!outcome.arrived) {
    throw new Error(
      `The walk to the fishing pond did not arrive (${outcome.reason}); the closest approach was ` +
        `${outcome.closestTiles ?? 'unmeasured'} tile(s) and the last published tile was ` +
        `${JSON.stringify(outcome.lastPlayer)}. The pond centre is ${JSON.stringify(FISH_STAND_SW_POND_GRID)} ` +
        `and the spawn is ${JSON.stringify(VILLAGE_SPAWN_GRID)}.`,
    );
  }
  await expect(page.locator(FISHING_HUD)).toBeVisible({ timeout: 30_000 });
  // The HUD renders outside the Suspense boundary, so it is visible before the lazy
  // pond chunk commits its canvas. Wait for the surface itself, or the read that
  // follows would be a handle to `null`.
  await expect(page.locator('[data-pixi-surface] canvas')).toHaveCount(1, { timeout: 30_000 });
}

/** Wait for animation frames, bounded by wall time. */
async function settleFrames(page: Page, frames: number, maxWaitMs = 2_000): Promise<void> {
  await page.evaluate(
    ({ count, budget }) =>
      new Promise<void>((resolve) => {
        const deadline = performance.now() + budget;
        let seen = 0;
        const step = (): void => {
          seen += 1;
          if (seen < count && performance.now() < deadline) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    { count: frames, budget: maxWaitMs },
  );
}

/**
 * The number of display objects under the most recently created application's stage.
 *
 * A real-engine read for item 5: a scene that created its cosmetic effects *per frame*
 * would grow this number for as long as the pond is open, and pooling would be one
 * remedy. A scene that creates them only on discrete machine events (a landing, a bite)
 * keeps it bounded, and pooling would buy nothing measurable.
 */
async function countStageNodes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const probe = (globalThis as unknown as Record<string, unknown>)['__KD_PIXI_ROUTE_PROBE__'] as
      | { applications: Array<{ stage?: { children?: unknown[] } }> }
      | undefined;
    const applications = probe?.applications ?? [];
    const stage = applications[applications.length - 1]?.stage;
    if (stage === undefined) return null;
    let count = 0;
    const walk = (node: { children?: unknown[] }): void => {
      count += 1;
      for (const child of node.children ?? []) walk(child as { children?: unknown[] });
    };
    walk(stage);
    return count;
  });
}

async function leavePond(page: Page): Promise<void> {
  await page.getByRole('button', { name: RETURN_TO_VILLAGE }).click();
  await expect(page.locator(FISHING_WORLD)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(VILLAGE_SCREEN)).toBeVisible({ timeout: 30_000 });
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

interface ManifestVerification {
  readonly status: string;
  readonly code: string;
  readonly message: string;
  readonly identity?: { readonly treeSha256: string; readonly fileCount: number; readonly totalBytes: number };
}

function verifyRecordedArtifact(): ManifestVerification {
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [MANIFEST_SCRIPT, 'verify', `--manifest=${path.join(REPO_ROOT, PIXI_ROUTE_MANIFEST_PATH)}`, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? '';
    if (stdout.trim().length === 0) {
      throw new Error(
        `The web-artifact verification command produced no structured result (${sanitizeToolchainText(error)}).`,
      );
    }
  }
  const verification = JSON.parse(stdout) as ManifestVerification;
  expect(
    verification.status,
    `The previewed build is not the recorded Pixi route artifact (${verification.code}: ${verification.message}). ` +
      `Build it with "npm run ${PIXI_ROUTE_LANE.buildScript}" and record it to ${PIXI_ROUTE_MANIFEST_PATH}.`,
  ).toBe('match');
  return verification;
}

interface LaneEvidence {
  readonly schemaVersion: number;
  readonly project: string;
  readonly suite: string;
  readonly test: string;
  readonly worldRenderer: string;
  readonly flags: readonly string[];
  readonly host: {
    readonly operatingSystem: string;
    readonly browserVersion: string;
    readonly playwrightVersion: string;
    readonly runnerImage: string | null;
    readonly viewport: { readonly width: number; readonly height: number };
  };
  readonly artifact: {
    readonly verificationStatus: string;
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly manifestPath: string;
  };
  readonly samples: readonly RouteMemorySample[];
  /**
   * The item-5 measurement: the display objects under the pond's stage while it is
   * left idle. Flat means effects are created on discrete events, not per frame.
   */
  readonly stageNodeDwell: {
    readonly before: number | null;
    readonly after: number | null;
    readonly dwellFrames: number;
  } | null;
  readonly findings: readonly PixiMemoryFinding[];
  readonly doesNotProve: readonly string[];
  readonly failure: { readonly name: string; readonly message: string } | null;
}

function writeEvidenceFile(testInfo: TestInfo, evidence: LaneEvidence): void {
  const relativePath = evidenceRelativePath({
    runId: RUN_ID,
    project: evidence.project,
    testTitle: testInfo.title,
  });
  mkdirSync(path.dirname(path.join(REPO_ROOT, relativePath)), { recursive: true });
  writeFileSync(path.join(REPO_ROOT, relativePath), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[pixi-route-evidence-file] ${relativePath}`);
}

function makeEvidence(input: {
  readonly testInfo: TestInfo;
  readonly browserVersion: string;
  readonly verification: ManifestVerification;
  readonly samples: readonly RouteMemorySample[];
  readonly findings: readonly PixiMemoryFinding[];
  readonly stageNodeDwell?: { readonly before: number | null; readonly after: number | null; readonly dwellFrames: number } | null;
  readonly failure: Error | null;
}): LaneEvidence {
  const devDependencies = (
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    }
  ).devDependencies;
  return {
    schemaVersion: 1,
    project: PIXI_ROUTE_LANE.project,
    suite: PIXI_ROUTE_LANE.suite,
    test: input.testInfo.title,
    worldRenderer: PIXI_ROUTE_LANE.worldRenderer,
    flags: [...PIXI_ROUTE_LANE.flags],
    host: {
      operatingSystem: `${os.platform()}/${os.arch()}`,
      browserVersion: input.browserVersion,
      playwrightVersion: sanitizeToolchainText(devDependencies?.['@playwright/test'] ?? 'unknown'),
      runnerImage: sanitizeRunnerImageLabel(
        `${process.env.ImageOS ?? 'unknown'}${process.env.ImageVersion ? ` ${process.env.ImageVersion}` : ''}`,
      ),
      viewport: { ...PIXI_ROUTE_LANE.viewport },
    },
    artifact: {
      verificationStatus: input.verification.status,
      treeSha256: input.verification.identity?.treeSha256 ?? 'unknown',
      fileCount: input.verification.identity?.fileCount ?? 0,
      totalBytes: input.verification.identity?.totalBytes ?? 0,
      manifestPath: PIXI_ROUTE_MANIFEST_PATH,
    },
    samples: input.samples,
    stageNodeDwell: input.stageNodeDwell ?? null,
    findings: input.findings,
    doesNotProve: [...PIXI_ROUTE_LANE.doesNotProve],
    failure:
      input.failure === null
        ? null
        : { name: sanitizeToolchainText(input.failure.name) || 'Error', message: sanitizeToolchainText(input.failure.message.split('\n')[0] ?? '') },
  };
}

const describeFindings = (findings: readonly PixiMemoryFinding[]): string =>
  findings.map((entry) => `[${entry.code}] ${entry.message}`).join('\n');

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

test.beforeAll(() => {
  console.log(
    `[pixi-route-lane] ${PIXI_ROUTE_LANE.project} on ${os.platform()}/${os.arch()} ` +
      `flags=${PIXI_ROUTE_LANE.flags.join(',')}`,
  );
});

test.beforeEach(async ({ page }) => {
  await blockExternalOrigins(page);
  await installProbe(page);
});

test('a route change away from each Pixi world detaches its canvas and loses its context', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  const samples: RouteMemorySample[] = [];
  let failure: Error | null = null;
  let findings: PixiMemoryFinding[] = [];
  let stageNodeDwell: { readonly before: number | null; readonly after: number | null; readonly dwellFrames: number } | null = null;

  try {
    // 1. The PixiJS dungeon.
    await enterDungeon(page);
    const dungeon = await readRoute(page, null, 'dungeon');
    samples.push({
      step: 0,
      world: 'dungeon',
      worldPresented: true,
      liveCanvasCount: dungeon.reading.liveCanvasCount,
      expectedLiveCanvasCount: 1,
      applicationsCreated: dungeon.reading.applicationsCreated,
      applicationsReleased: dungeon.reading.applicationsReleased,
      applicationsRetained: dungeon.reading.applicationsRetained,
      expectsPixiApplication: true,
      liveCanvasIsNew: true,
      previous: null,
    });

    // 2. Home -> the village. The dungeon's canvas must be detached and its context lost.
    await leaveDungeon(page);
    const village = await readRoute(page, dungeon.liveCanvas, 'dungeon');
    samples.push({
      step: 1,
      world: 'village',
      worldPresented: true,
      liveCanvasCount: village.reading.liveCanvasCount,
      expectedLiveCanvasCount: 1,
      applicationsCreated: village.reading.applicationsCreated,
      applicationsReleased: village.reading.applicationsReleased,
      applicationsRetained: village.reading.applicationsRetained,
      expectsPixiApplication: false,
      liveCanvasIsNew: village.reading.liveCanvasIsNew,
      previous: village.reading.previous,
    });
    await dungeon.liveCanvas.dispose();

    // 3. Walk to the pond and open the PixiJS overlay.
    await enterPond(page);
    const pond = await readRoute(page, null, 'pond');
    samples.push({
      step: 2,
      world: 'fishing-pond',
      worldPresented: true,
      liveCanvasCount: pond.reading.liveCanvasCount,
      expectedLiveCanvasCount: 2,
      applicationsCreated: pond.reading.applicationsCreated,
      applicationsReleased: pond.reading.applicationsReleased,
      applicationsRetained: pond.reading.applicationsRetained,
      expectsPixiApplication: true,
      liveCanvasIsNew: true,
      previous: null,
    });

    // Item 5's measurement, taken while the pond is open: if the scene created its
    // cosmetic effects per frame, the stage would grow for as long as the pond is left
    // alone. A flat count is the measurement that says pooling buys nothing measurable.
    const stageBefore = await countStageNodes(page);
    await settleFrames(page, 30);
    const stageAfter = await countStageNodes(page);
    stageNodeDwell = { before: stageBefore, after: stageAfter, dwellFrames: 30 };
    console.log(`[pixi-route-stage] pond stage nodes ${stageBefore} -> ${stageAfter} over 30 idle frames`);

    // 4. Return to the village. The pond's canvas must be detached and its context lost.
    await leavePond(page);
    const villageAgain = await readRoute(page, pond.liveCanvas, 'fishing-pond');
    samples.push({
      step: 3,
      world: 'village',
      worldPresented: true,
      liveCanvasCount: villageAgain.reading.liveCanvasCount,
      expectedLiveCanvasCount: 1,
      applicationsCreated: villageAgain.reading.applicationsCreated,
      applicationsReleased: villageAgain.reading.applicationsReleased,
      applicationsRetained: villageAgain.reading.applicationsRetained,
      expectsPixiApplication: false,
      liveCanvasIsNew: villageAgain.reading.liveCanvasIsNew,
      previous: villageAgain.reading.previous,
    });
    await pond.liveCanvas.dispose();
    await villageAgain.liveCanvas.dispose();

    findings = evaluateRouteMemoryRun(samples);

    // The measurement's own assertion, and it is a *measurement* rather than a pass:
    // an idle pond that keeps adding display objects is the "frequently created effect"
    // case pooling would address, so a growth here must be a visible red, not a note.
    expect(
      stageNodeDwell.after,
      `The pond's stage grew from ${stageNodeDwell.before} to ${stageNodeDwell.after} display ` +
        'object(s) over 30 idle frames, so the scene creates or retains effects while nothing ' +
        'happens. That is the measurement that would justify pooling.',
    ).toBeLessThanOrEqual(stageNodeDwell.before ?? Number.POSITIVE_INFINITY);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    makeEvidence({ testInfo, browserVersion: browser.version(), verification, samples, findings, stageNodeDwell, failure }),
  );
  if (failure) throw failure;
  expect(findings, `\n${describeFindings(findings)}`).toEqual([]);
});

test('a world left mounted is reported as retained, so this verdict is not vacuous', async ({
  page,
  browser,
}, testInfo) => {
  // The same red proof the twenty-cycle lane uses, one level down: a sample built from
  // the dungeon's *own live canvas*, read while it is still mounted, handed the verdict
  // as the world "the route left". A verdict that stopped checking attachment or the
  // context cannot produce these two codes, and a real leak of either would.
  const verification = verifyRecordedArtifact();
  const samples: RouteMemorySample[] = [];
  let findings: PixiMemoryFinding[] = [];
  let failure: Error | null = null;

  try {
    await enterDungeon(page);
    const dungeon = await readRoute(page, null, 'dungeon');
    // The previous world is the live one, deliberately: it is the state a route that
    // failed to tear the dungeon down would leave.
    const stillMounted = (await readRoute(page, dungeon.liveCanvas, 'dungeon')).reading;
    samples.push({
      step: 1,
      world: 'dungeon',
      worldPresented: true,
      liveCanvasCount: 1,
      expectedLiveCanvasCount: 1,
      applicationsCreated: dungeon.reading.applicationsCreated,
      applicationsReleased: dungeon.reading.applicationsReleased,
      applicationsRetained: dungeon.reading.applicationsRetained,
      expectsPixiApplication: true,
      liveCanvasIsNew: true,
      previous: stillMounted.previous,
    });
    await dungeon.liveCanvas.dispose();

    findings = evaluateRouteMemoryRun(samples);
    const codes = findings.map((entry) => entry.code);
    for (const code of ['retained-canvas', 'retained-webgl-context']) {
      expect(codes, code).toContain(code);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    makeEvidence({ testInfo, browserVersion: browser.version(), verification, samples, findings, failure }),
  );
  if (failure) throw failure;
});
