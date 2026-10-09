import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { expect, test, type CDPSession, type JSHandle, type Page, type TestInfo } from '@playwright/test';

import {
  evidenceRelativePath,
  sanitizeRunnerImageLabel,
  sanitizeToolchainText,
  type HostExecution,
} from './compat-evidence';
import { PIXI_MEMORY_CI_JOB, PIXI_MEMORY_CI_STEP_NAME, PIXI_MEMORY_LANE, PIXI_MEMORY_MANIFEST_PATH } from './pixi-memory-lane';
import {
  changedRegion,
  decodePng,
  evaluateMotion,
  setPngInflater,
  type MotionMeasurement,
  type MotionVerdictFinding,
} from './pixi-memory-pixels';
import {
  PIXI_MEMORY_CYCLES,
  evaluateIdleGrowth,
  evaluatePixiMemoryRun,
  type IdleGrowthInput,
  type PixiMemoryFinding,
  type PixiMemorySample,
  type PreviousCanvasReading,
  type RendererContextKind,
} from './pixi-memory-series';

/**
 * The browser-backed half of plan section 10.2's renderer memory gate.
 *
 * ## What this suite is for
 *
 * Plan section 10.2 asks for "no material canvas or GPU memory growth over 20 world
 * mount and unmount cycles", and Phase 9's exit criteria restate it as "repeated
 * mount and unmount does not leak canvases or GPU resources". The gate that exists
 * for that pair - `scripts/check-memory.mjs` - reads a directory of files and says
 * in its own output that it measures none of it. This suite is the runtime half, and
 * its scope is written out in `PIXI_MEMORY_LANE.doesNotProve` rather than left to a
 * reader's imagination; the boundaries that matter are repeated in the comments at
 * the assertions they govern.
 *
 * ## How a cycle is driven, and why it is a real one
 *
 * The flagged build has no product control that leaves the world, so a cycle is
 * driven by toggling `prefers-reduced-motion`, which is one of the host effect's
 * declared dependencies. Every toggle therefore runs the product's own cleanup -
 * `host.unmount()`, which tears down the scene, calls
 * `Application.destroy({ removeView: true, releaseGlobalResources: true })`, and
 * removes the canvas - and then mounts a new host with a new `Application`, a new
 * WebGL context, a new ticker, a new scene, and a new canvas.
 *
 * That the cycles are real is asserted, not assumed: every sample checks that the
 * mounted canvas is a *different element* from the previous sample's, that PixiJS
 * reports one more created application, and that the mounted application's ticker
 * clock has advanced. A toggle that stopped remounting the world fails on the first
 * of those rather than producing twenty quiet passes.
 *
 * ## What is gated, and what is only recorded
 *
 * Gated with exact thresholds, because the correct value is a known constant: the
 * live `<canvas>` count, whether the previous cycle's canvas is still attached,
 * whether the previous cycle's WebGL context is still live, and how many PixiJS
 * `Application` objects are still alive. The one counter with a legitimate mount
 * transient - the live canvas's backing-store bytes - is judged on its tail, and only
 * when every sample's surface actually settled.
 *
 * Recorded and deliberately not gated: the JavaScript heap, and Chromium's own
 * `Nodes` and `JSEventListeners` estimates. Those are Chromium approximations and
 * they move by tens between consecutive samples, so a trend gate on them would be a
 * coin flip and a threshold on them would be arbitrary. They are in the evidence file
 * so a reader can see the shape, and out of the pass/fail set on purpose.
 *
 * ## How the renderers are observed
 *
 * Through PixiJS's own documented init hooks, `__PIXI_APP_INIT__` and
 * `__PIXI_RENDERER_INIT__`. They are the points at which the library hands a caller
 * the real objects; the probe stores them and reads their state. It replaces no
 * function, no method and no prototype, and it fails loudly if a hook is already
 * installed rather than silently overwriting something another tool put there. The
 * retained reference to each application is a deliberate, bounded retention: it is
 * what makes the post-teardown state readable at all, and the release being asserted
 * is the renderer's own `destroy`, not the garbage collector's behaviour.
 *
 * Privacy: synthetic tutorial fixtures only, no learner data, no request bodies, no
 * query strings, and no external host. Every external request is blocked before the
 * application runs, exactly as `currentBuild.spec.ts` does.
 */

const REPO_ROOT = process.cwd();
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? 'local';
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');

/** Animation frames a cycle is left to settle before it is measured. */
const SETTLE_FRAMES = 8;

/** Animation frames a single mounted world is left idle before its surface is re-read. */
const IDLE_DWELL_FRAMES = 30;

/**
 * How long one cycle is given, once the document is already telling the story.
 *
 * A healthy mount creates its application and presents a frame in a few hundred
 * milliseconds - the whole 21-sample run takes about ten seconds - so these are an
 * order of magnitude above the observed cost and exist to bound a *failing* run, not
 * to tune a passing one. A host that leaks a renderer per cycle eventually cannot
 * start a renderer at all, and every one of these is a place where an unbounded wait
 * would have turned that into a 120-second timeout instead of a finding.
 */
const MOUNT_PRESENT_TIMEOUT_MS = 8_000;
const APPLICATION_WAIT_MS = 4_000;
const LEAKING_DOCUMENT_APPLICATION_WAIT_MS = 2_500;
/** A document that is already holding too many canvases gets a shorter presentation wait. */
const LEAKING_DOCUMENT_PRESENT_TIMEOUT_MS = 1_500;

const WORLD_HEADING = 'PixiJS runtime host';
const READY_SENTENCE = 'World presented';
const REDUCED_MOTION_SENTENCE = 'Reduced motion: no travel';
const MOTION_SENTENCE = 'Motion enabled';
const START_TUTORIAL = 'Start Tutorial';
const LIGHT_CONTROL = 'Light the lantern (key L)';
const RING_CONTROL = 'Ring the bell (key B)';
const LANTERN_STATE = /Lantern lit with \d+ ember/;

/** Plan section 10.1's minimum touch target, in CSS pixels. */
const MINIMUM_TOUCH_TARGET_PX = 44;

/* -------------------------------------------------------------------------- */
/* Page helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Installs the probe before any application code runs, in every context.
 *
 * `ResizeObserver` presence is recorded at the moment the application is
 * initialised rather than at the end of the run, because PixiJS's `CanvasObserver`
 * reads it once, while the renderer is being constructed, and branches on it. That
 * single read decides whether PixiJS 8.21.0 leaves an unremovable `Ticker.shared`
 * listener behind per application, so a runtime without the global leaks silently
 * and the lane treats its presence as a production precondition.
 */
async function installProbe(page: Page, options: { dropResizeObserver: boolean }): Promise<void> {
  await page.addInitScript((drop) => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const hadAppHook = typeof scope['__PIXI_APP_INIT__'] === 'function';
    const hadRendererHook = typeof scope['__PIXI_RENDERER_INIT__'] === 'function';
    if (drop) Reflect.deleteProperty(globalThis, 'ResizeObserver');
    const state = {
      applications: [] as unknown[],
      renderers: [] as unknown[],
      pixiVersion: null as string | null,
      resizeObserverAtApplicationInit: typeof scope['ResizeObserver'],
      hooksWereAbsent: !hadAppHook && !hadRendererHook,
    };
    scope['__KD_PIXI_MEMORY_PROBE__'] = state;
    scope['__PIXI_APP_INIT__'] = (application: unknown, version: string) => {
      state.pixiVersion = version;
      state.applications.push(application);
    };
    scope['__PIXI_RENDERER_INIT__'] = (renderer: unknown, version: string) => {
      state.pixiVersion = version;
      state.renderers.push(renderer);
    };
  }, options.dropResizeObserver);
}

/** Blocks every non-loopback origin, so a privacy regression is observed, not made. */
async function blockExternalOrigins(page: Page): Promise<void> {
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
}

/**
 * Waits for animation frames, bounded by wall time as well as by frame count.
 *
 * The wall-clock bound is not defensive padding. A page holding fifteen live WebGL
 * contexts is a page whose compositor is starved, and an unbounded
 * `requestAnimationFrame` loop on it never completes - so a leak turns the settle
 * into the hang that a leak should be reported as. A settle that gives up after two
 * seconds and returns is a measurement of fewer frames than asked for, and the
 * sample records that; the alternative is a test that times out and says nothing.
 */
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

interface PageReading {
  readonly liveCanvasCount: number;
  readonly liveCanvasBackingBytes: number;
  readonly liveCanvasCssHeight: number;
  readonly liveRendererContext: RendererContextKind;
  readonly applicationsCreated: number;
  readonly applicationsReleased: number;
  readonly applicationsRetained: number;
  /** `Ticker.lastTime`: the ticker's clock, which advances only while it ticks. */
  readonly liveTickerClock: number | null;
  readonly pixiVersion: string | null;
  readonly hooksWereAbsent: boolean;
  readonly resizeObserverAtApplicationInit: string;
  readonly previous: {
    readonly connected: boolean;
    readonly contextKind: RendererContextKind;
    readonly contextLost: boolean | null;
  } | null;
  readonly liveCanvasIsNew: boolean | null;
}

interface ProbeApplication {
  readonly renderer: unknown;
  readonly stage: unknown;
  readonly ticker: { readonly lastTime: number } | null;
}

/**
 * One measurement, taken in the page.
 *
 * Everything is read from the live document and from the PixiJS objects the library
 * handed to its own init hooks. No value here comes from a Playwright-side
 * approximation, and nothing is inferred from an absence.
 */
async function readPage(
  page: Page,
  previousCanvas: JSHandle<HTMLCanvasElement> | null,
): Promise<{ reading: PageReading; liveCanvas: JSHandle<HTMLCanvasElement> }> {
  const liveCanvas = (await page.evaluateHandle(() =>
    document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas'),
  )) as JSHandle<HTMLCanvasElement>;

  const reading = (await page.evaluate((previous) => {
    const contextKindOf = (canvas: HTMLCanvasElement | null): string => {
      if (canvas === null) return 'none';
      if (canvas.getContext('webgl2') !== null) return 'webgl2';
      if (canvas.getContext('webgl') !== null) return 'webgl';
      if (canvas.getContext('2d') !== null) return 'canvas2d';
      return 'none';
    };
    const probe = (globalThis as unknown as Record<string, unknown>)['__KD_PIXI_MEMORY_PROBE__'] as
      | {
          applications: ProbeApplication[];
          pixiVersion: string | null;
          resizeObserverAtApplicationInit: string;
          hooksWereAbsent: boolean;
        }
      | undefined;
    const applications = probe?.applications ?? [];
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const live = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
    const previousElement = previous as HTMLCanvasElement | null;
    const released = applications.filter(
      (application) => application.renderer === null && application.stage === null,
    ).length;
    const liveApplication = applications[applications.length - 1];
    const previousContextKind = contextKindOf(previousElement);
    const previousContext =
      previousElement === null
        ? null
        : (previousElement.getContext('webgl2') ?? previousElement.getContext('webgl'));
    return {
      liveCanvasCount: canvases.length,
      liveCanvasBackingBytes: canvases.reduce(
        (total, canvas) => total + canvas.width * canvas.height * 4,
        0,
      ),
      liveCanvasCssHeight: Math.round(live?.getBoundingClientRect().height ?? 0),
      liveRendererContext: contextKindOf(live),
      applicationsCreated: applications.length,
      applicationsReleased: released,
      applicationsRetained: applications.length - released,
      liveTickerClock:
        liveApplication?.ticker === null || liveApplication?.ticker === undefined
          ? null
          : Number(liveApplication.ticker.lastTime),
      pixiVersion: probe?.pixiVersion ?? null,
      hooksWereAbsent: probe?.hooksWereAbsent ?? false,
      resizeObserverAtApplicationInit: probe?.resizeObserverAtApplicationInit ?? 'missing',
      previous:
        previousElement === null
          ? null
          : {
              connected: previousElement.isConnected,
              contextKind: previousContextKind,
              contextLost:
                previousContextKind === 'webgl2' || previousContextKind === 'webgl'
                  ? (previousContext?.isContextLost() ?? null)
                  : null,
            },
      liveCanvasIsNew: previousElement === null ? null : live !== previousElement,
    };
  }, previousCanvas)) as unknown as PageReading;

  return { reading, liveCanvas };
}

/** The live `<canvas>` count in the document, read in one call. */
async function countLiveCanvases(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('canvas').length);
}

/**
 * Flips the motion preference and waits for the new application to exist.
 *
 * The flip is the cycle: it changes one of the host effect's declared dependencies,
 * so React runs the previous host's cleanup and mounts a new one. Waiting for the
 * application rather than for the screen is deliberate - the application's arrival is
 * what proves the mount started, and it is a fact about the renderer rather than
 * about a sentence the product renders. It never throws: on a host that leaks a
 * renderer per cycle the applications stop arriving, and a wait that insists on them
 * converts the leak into a timeout.
 */
async function flipAndAwaitApplication(
  page: Page,
  expectedApplications: number,
  reducedMotion: 'reduce' | 'no-preference',
  timeoutMs: number,
): Promise<boolean> {
  await page.emulateMedia({ reducedMotion });
  return page
    .waitForFunction(
      (expected) => {
        const probe = (globalThis as unknown as Record<string, unknown>)[
          '__KD_PIXI_MEMORY_PROBE__'
        ] as { applications: unknown[] } | undefined;
        return (probe?.applications.length ?? 0) >= expected;
      },
      expectedApplications,
      { timeout: timeoutMs },
    )
    .then(
      () => true,
      () => false,
    );
}

/**
 * Wait until the probe reports at least `expected` applications, without changing any
 * media state.
 *
 * `flipAndAwaitApplication` also drives reduced motion, which is what a cycle wants;
 * a test that rebuilds the world by changing the core count or the device ratio needs
 * only the wait. Boolean and never thrown, matching its sibling, so a caller reports a
 * finding rather than a timeout.
 */
async function waitForApplications(
  page: Page,
  expected: number,
  timeoutMs: number = APPLICATION_WAIT_MS,
): Promise<boolean> {
  return page
    .waitForFunction(
      (count) => {
        const probe = (globalThis as unknown as Record<string, unknown>)['__KD_PIXI_MEMORY_PROBE__'] as
          | { applications: unknown[] }
          | undefined;
        return (probe?.applications.length ?? 0) >= count;
      },
      expected,
      { timeout: timeoutMs },
    )
    .then(
      () => true,
      () => false,
    );
}

/**
 * Whether the world that just mounted reached the presented state.
 *
 * Two frames are allowed to pass first, so a "World presented" sentence left on the
 * screen by the *previous* world cannot be read as this one's. A leaking host stops
 * presenting once the browser runs out of contexts, and this is where that shows up -
 * as a reported finding, not as a hang.
 */
async function waitForPresented(page: Page, timeoutMs: number): Promise<boolean> {
  await settleFrames(page, 2);
  return page
    .waitForFunction(
      (sentence) => document.querySelector('.pixi-world-host [aria-live]')?.textContent?.includes(sentence) === true,
      READY_SENTENCE,
      { timeout: timeoutMs },
    )
    .then(
      () => true,
      () => false,
    );
}

async function openWelcome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
}

async function enterWorld(page: Page): Promise<void> {
  await openWelcome(page);
  await page.getByRole('button', { name: START_TUTORIAL }).click();
  await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({
    timeout: 30_000,
  });
  await flipAndAwaitApplication(page, 1, 'no-preference', APPLICATION_WAIT_MS);
  await waitForPresented(page, MOUNT_PRESENT_TIMEOUT_MS);
  // Neither helper throws, and neither return value is asserted here: `enterWorld`
  // is the route in, and every test that calls it has a verdict of its own to reach.
}

/** Presses Tab until the named control holds focus, or gives up and fails. */
async function tabUntilFocused(page: Page, label: string): Promise<void> {
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    if (focused === label) return;
  }
  throw new Error(`Tabbing never reached the control labelled "${label}".`);
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

interface LaneMeasurement {
  readonly cycle: number;
  readonly liveCanvasCount: number;
  readonly liveCanvasBackingBytes: number;
  readonly liveCanvasCssHeight: number;
  readonly applicationsCreated: number;
  readonly applicationsReleased: number;
  readonly applicationsRetained: number;
  readonly liveTickerClock: number | null;
  readonly previousCanvas: PreviousCanvasReading | null;
  readonly liveCanvasIsNew: boolean | null;
  readonly surfaceSettledAtSample: boolean;
  /** The same reading taken `SETTLE_FRAMES` frames later, for the record. */
  readonly surfaceBytesOnRecheck: number;
  readonly heapUsedBytes: number | null;
  readonly domNodes: number | null;
  readonly jsEventListeners: number | null;
}

interface LaneRenderer {
  readonly contextKind: RendererContextKind;
  readonly unmaskedRenderer: string | null;
  readonly pixiVersion: string | null;
  readonly resizeObserverAtApplicationInit: string;
}

interface LaneEvidence {
  readonly schemaVersion: number;
  readonly project: string;
  readonly suite: string;
  readonly lane: string;
  readonly test: string;
  readonly worldRenderer: string;
  readonly storageRepository: string;
  readonly cycles: number;
  readonly host: {
    readonly operatingSystem: string;
    readonly architecture: string;
    readonly execution: HostExecution;
    readonly browserName: string;
    readonly browserVersion: string;
    readonly playwrightVersion: string;
    readonly runnerImage: string | null;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly deviceScaleFactor: number;
    readonly inputMode: string;
  };
  readonly artifact: {
    readonly verificationStatus: string;
    readonly verificationCode: string;
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly manifestPath: string;
  };
  readonly renderer: LaneRenderer;
  readonly measurements: readonly LaneMeasurement[];
  readonly recordedOnly: {
    readonly note: string;
    readonly heapUsedBytes: readonly (number | null)[];
    readonly domNodes: readonly (number | null)[];
    readonly jsEventListeners: readonly (number | null)[];
  };
  readonly idle: IdleGrowthInput | null;
  readonly motion: readonly MotionMeasurement[];
  readonly findings: readonly PixiMemoryFinding[];
  readonly doesNotProve: readonly string[];
  readonly failure: { readonly name: string; readonly message: string } | null;
}

const UNMEASURED_RENDERER: LaneRenderer = {
  contextKind: 'none',
  unmaskedRenderer: null,
  pixiVersion: null,
  resizeObserverAtApplicationInit: 'not measured',
};

interface ManifestVerification {
  readonly status: string;
  readonly code: string;
  readonly message: string;
  readonly identity?: {
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  };
}

function verifyRecordedArtifact(): ManifestVerification {
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [
        MANIFEST_SCRIPT,
        'verify',
        `--manifest=${path.join(REPO_ROOT, PIXI_MEMORY_MANIFEST_PATH)}`,
        '--json',
      ],
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
  // A missing or stale recorded identity is a failure, not a skip, and the same
  // stance `scripts/check-welcome-budget.mjs` takes: a gate that reports success
  // because it measured nothing is the failure the gate exists to prevent.
  expect(
    verification.status,
    `The previewed build is not the recorded Pixi-flagged artifact (${verification.code}: ${verification.message}). ` +
      `Build it with "npm run ${PIXI_MEMORY_LANE.buildScript}" and record it to ` +
      `${PIXI_MEMORY_MANIFEST_PATH} before running this lane.`,
  ).toBe('match');
  return verification;
}

/**
 * The findings, as a failure message, bounded.
 *
 * A leaking host produces one finding per cycle, so the full list is a few hundred
 * lines of the same sentence with different cycle numbers. The evidence file keeps
 * every one of them; the message keeps enough to identify the leak and says how many
 * more there are, because a truncated message that does not say it was truncated is
 * worse than a short one.
 */
function describeFindings(findings: readonly PixiMemoryFinding[]): string {
  const shown = findings.slice(0, 12);
  const rest = findings.length - shown.length;
  const lines = shown.map((entry) => `[${entry.code}] ${entry.message}`);
  if (rest > 0) lines.push(`... and ${rest} further finding(s) of the same kinds; the evidence file has all of them.`);
  return lines.join('\n');
}

function writeEvidenceFile(testInfo: TestInfo, evidence: LaneEvidence): void {
  const relativePath = evidenceRelativePath({
    runId: RUN_ID,
    project: evidence.project,
    testTitle: testInfo.title,
  });
  mkdirSync(path.dirname(path.join(REPO_ROOT, relativePath)), { recursive: true });
  writeFileSync(
    path.join(REPO_ROOT, relativePath),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
  console.log(`[pixi-memory-evidence-file] ${relativePath}`);
}

function baseEvidence(
  testInfo: TestInfo,
  browserVersion: string,
  verification: ManifestVerification,
  renderer: LaneRenderer,
  measurements: readonly LaneMeasurement[],
  findings: readonly PixiMemoryFinding[],
  failure: Error | null,
  extras: { readonly idle?: IdleGrowthInput | null; readonly motion?: readonly MotionMeasurement[] } = {},
): LaneEvidence {
  const devDependencies = (
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    }
  ).devDependencies;
  return {
    schemaVersion: 1,
    project: PIXI_MEMORY_LANE.project,
    suite: PIXI_MEMORY_LANE.suite,
    lane: `ci job ${PIXI_MEMORY_CI_JOB}, step "${PIXI_MEMORY_CI_STEP_NAME}"`,
    test: testInfo.title,
    worldRenderer: PIXI_MEMORY_LANE.worldRenderer,
    storageRepository: PIXI_MEMORY_LANE.storageRepository,
    cycles: PIXI_MEMORY_LANE.cycles,
    host: {
      operatingSystem: `${os.platform()}/${os.arch()}`,
      architecture: os.arch(),
      execution: process.env.CI ? 'ci' : 'local-host',
      browserName: 'chromium',
      browserVersion,
      playwrightVersion: sanitizeToolchainText(devDependencies?.['@playwright/test'] ?? 'unknown'),
      runnerImage: sanitizeRunnerImageLabel(
        `${process.env.ImageOS ?? 'unknown'}${process.env.ImageVersion ? ` ${process.env.ImageVersion}` : ''}`,
      ),
      viewport: { ...PIXI_MEMORY_LANE.viewport },
      deviceScaleFactor: PIXI_MEMORY_LANE.deviceScaleFactor,
      inputMode: PIXI_MEMORY_LANE.inputMode,
    },
    artifact: {
      verificationStatus: verification.status,
      verificationCode: verification.code,
      treeSha256: verification.identity?.treeSha256 ?? 'unknown',
      fileCount: verification.identity?.fileCount ?? 0,
      totalBytes: verification.identity?.totalBytes ?? 0,
      manifestPath: PIXI_MEMORY_MANIFEST_PATH,
    },
    renderer,
    measurements,
    recordedOnly: {
      note:
        'Recorded, not gated: Chromium estimates these and they move by tens between consecutive samples, so a ' +
        'trend gate on them would be a coin flip and a threshold on them would be arbitrary.',
      heapUsedBytes: measurements.map((entry) => entry.heapUsedBytes),
      domNodes: measurements.map((entry) => entry.domNodes),
      jsEventListeners: measurements.map((entry) => entry.jsEventListeners),
    },
    idle: extras.idle ?? null,
    motion: extras.motion ?? [],
    findings,
    doesNotProve: [...PIXI_MEMORY_LANE.doesNotProve],
    failure:
      failure === null
        ? null
        : {
            name: sanitizeToolchainText(failure.name) || 'Error',
            message: sanitizeToolchainText(failure.message.split('\n')[0] ?? ''),
          },
  };
}

/** Chromium's own counters, for the record only. */
async function readCdpCounters(cdp: CDPSession): Promise<{
  domNodes: number;
  jsEventListeners: number;
}> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as {
    metrics: ReadonlyArray<{ name: string; value: number }>;
  };
  const find = (name: string): number => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { domNodes: find('Nodes'), jsEventListeners: find('JSEventListeners') };
}

async function readHeap(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
  });
}

/** The unmasked WebGL renderer string, recorded once so a reader knows what drew. */
async function readUnmaskedRenderer(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
    if (canvas === null) return null;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl === null) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const value =
      info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    return typeof value === 'string' ? value.slice(0, 120) : null;
  });
}

function unmeasuredMeasurement(cycle: number): LaneMeasurement {
  return {
    cycle,
    liveCanvasCount: 0,
    liveCanvasBackingBytes: 0,
    liveCanvasCssHeight: 0,
    applicationsCreated: 0,
    applicationsReleased: 0,
    applicationsRetained: 0,
    liveTickerClock: null,
    previousCanvas: null,
    liveCanvasIsNew: null,
    surfaceSettledAtSample: false,
    surfaceBytesOnRecheck: 0,
    heapUsedBytes: null,
    domNodes: null,
    jsEventListeners: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Suite setup                                                                */
/* -------------------------------------------------------------------------- */

// The PNG decoder is given Node's inflate here, at the boundary, rather than
// importing it: `tests/e2e/pixi-memory-pixels.ts` stays dependency-free and pure,
// and this file is the one place that knows it is running on Node.
setPngInflater((data) => new Uint8Array(inflateSync(data)));

test.beforeAll(() => {
  console.log(
    `[pixi-memory-lane] ${PIXI_MEMORY_LANE.project} on ${os.platform()}/${os.arch()} ` +
      `flag ${PIXI_MEMORY_LANE.flag}=${PIXI_MEMORY_LANE.flagValue} cycles=${PIXI_MEMORY_LANE.cycles}`,
  );
});

test.beforeEach(async ({ page }) => {
  await blockExternalOrigins(page);
  await installProbe(page, { dropResizeObserver: false });
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

test('the Pixi-flagged artifact serves the world host, and the world actually mounts', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  const scriptRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') {
      scriptRequests.push(new URL(request.url()).pathname);
    }
  });

  let failure: Error | null = null;
  let baselineCanvasCount = -1;
  let renderer = UNMEASURED_RENDERER;
  const measurements: LaneMeasurement[] = [];
  const findings: PixiMemoryFinding[] = [];

  try {
    await openWelcome(page);
    await page.waitForLoadState('networkidle');
    baselineCanvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);

    // The structural half of "no eager Pixi load on Welcome" is
    // `scripts/check-memory.mjs`'s `eager-pixi` finding, which reads the entry
    // document. This is the runtime half, and it is a different claim: the entry
    // document not *naming* a chunk does not stop a preload helper from *requesting*
    // one, so the request list is what settles it. It is recorded for the flagged
    // build, which the current-build suite never previews - and it is not a
    // duplicate of that suite's own assertion, which covers the production build's
    // Welcome and would never see this artifact.
    expect(
      scriptRequests.filter((pathname) => /pixi/i.test(pathname)),
      'The Welcome route requested a Pixi chunk. Plan section 10.2 forbids an eager renderer load on Welcome.',
    ).toEqual([]);
    expect(
      baselineCanvasCount,
      'The Welcome route already holds a canvas, so there is no clean baseline to compare a retained canvas against.',
    ).toBe(0);

    await page.getByRole('button', { name: START_TUTORIAL }).click();
    await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({
      timeout: 30_000,
    });
    await flipAndAwaitApplication(page, 1, 'no-preference', APPLICATION_WAIT_MS);
    await waitForPresented(page, MOUNT_PRESENT_TIMEOUT_MS);
    await settleFrames(page, SETTLE_FRAMES);

    // A mount that failed leaves a sentence on the screen and never presents.
    // Asserted as a sentence rather than as a timeout, because a timeout would
    // report "the world is slow" when the truth is that the world is broken.
    const failureNotice = await page
      .locator('.pixi-world-host [role="alert"]')
      .textContent()
      .catch(() => null);
    expect(
      failureNotice,
      'The world host reported a failure instead of presenting a world, so no mount or unmount cycle was exercised ' +
        'and this lane has measured nothing.',
    ).toBeNull();

    const { reading } = await readPage(page, null);
    renderer = {
      contextKind: reading.liveRendererContext,
      unmaskedRenderer: await readUnmaskedRenderer(page),
      pixiVersion: reading.pixiVersion,
      resizeObserverAtApplicationInit: reading.resizeObserverAtApplicationInit,
    };
    measurements.push({
      ...unmeasuredMeasurement(0),
      liveCanvasCount: reading.liveCanvasCount,
      liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
      liveCanvasCssHeight: reading.liveCanvasCssHeight,
      applicationsCreated: reading.applicationsCreated,
      applicationsRetained: reading.applicationsRetained,
      liveTickerClock: reading.liveTickerClock,
      heapUsedBytes: await readHeap(page),
    });

    expect(
      reading.pixiVersion,
      'PixiJS did not report a version through its own init hook, so the probe never saw a renderer.',
    ).toMatch(/^\d+\.\d+\.\d+/);
    expect(
      reading.hooksWereAbsent,
      'PixiJS already had a global init hook installed, so the probe would have replaced something else.',
    ).toBe(true);
    expect(
      reading.liveRendererContext,
      'The world obtained no drawing context, so this lane would be measuring a renderer that never started.',
    ).not.toBe('none');
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, renderer, measurements, findings, failure),
  );
  if (failure) throw failure;
});

test('the production runtime provides ResizeObserver when the renderer is created', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  let failure: Error | null = null;
  let observed = 'not measured';
  let presented = false;
  const measurements: LaneMeasurement[] = [];

  try {
    await openWelcome(page);
    await page.getByRole('button', { name: START_TUTORIAL }).click();
    await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({
      timeout: 30_000,
    });
    // The cycle is a media flip, exactly as the twenty-cycle test drives it, so the
    // reading below is taken after the product's own teardown and its own second
    // mount rather than after a world that was never rebuilt.
    presented = await flipAndAwaitApplication(page, 1, 'no-preference', APPLICATION_WAIT_MS);
    presented = (await waitForPresented(page, MOUNT_PRESENT_TIMEOUT_MS)) && presented;
    const { reading, liveCanvas } = await readPage(page, null);
    observed = reading.resizeObserverAtApplicationInit;
    measurements.push({
      ...unmeasuredMeasurement(0),
      liveCanvasCount: reading.liveCanvasCount,
      liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
      liveCanvasCssHeight: reading.liveCanvasCssHeight,
      applicationsCreated: reading.applicationsCreated,
      applicationsReleased: reading.applicationsReleased,
      applicationsRetained: reading.applicationsRetained,
      liveTickerClock: reading.liveTickerClock,
      liveCanvasIsNew: reading.liveCanvasIsNew,
      surfaceSettledAtSample: false,
      surfaceBytesOnRecheck: reading.liveCanvasBackingBytes,
    });
    await liveCanvas.dispose();
    // PixiJS 8.21.0's `CanvasObserver._attachObserver` registers a `Ticker.shared`
    // listener when `ResizeObserver` is absent and never sets the `_tickerAttached`
    // flag its own `destroy` tests, so the listener is unremovable and every
    // application leaks one closure holding a destroyed renderer: +1 per
    // application, linear, and +0 with the global present. Every browser in the
    // plan's support matrix has had `ResizeObserver` since 2018, so the shipped
    // matrix is unaffected and jsdom is not - which is why this is a precondition
    // rather than something a leak would discover.
    //
    // The non-vacuity control comes *first* in the ordering of the assertions below
    // and not in the middle of them, because of what this test was: without it, this
    // test passed on a build whose world never mounted at all, since the global is
    // present whether or not a renderer is ever created from it. A precondition
    // observed on a world that did not mount is a precondition of nothing.
    expect(
      presented,
      'The world never presented, so this reading says the global exists and nothing about whether a renderer ' +
        'was ever created from it. The precondition has to be observed on a world that actually mounted.',
    ).toBe(true);
    expect(
      observed,
      'The runtime had no ResizeObserver when PixiJS created its renderer, so every mount leaks one ' +
        'Ticker.shared listener and the matrix assumption behind this phase\'s memory criterion does not hold.',
    ).toBe('function');
    expect(
      await page.evaluate(() => typeof ResizeObserver),
      'ResizeObserver vanished during the run.',
    ).toBe('function');
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(
      testInfo,
      browser.version(),
      verification,
      { ...UNMEASURED_RENDERER, resizeObserverAtApplicationInit: observed },
      measurements,
      [],
      failure,
    ),
  );
  if (failure) throw failure;
});

test('20 world mount and unmount cycles retain no canvas, no WebGL context, and no application', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const samples: PixiMemorySample[] = [];
  const measurements: LaneMeasurement[] = [];
  let baselineCanvasCount = -1;
  let unmaskedRenderer: string | null = null;
  let pixiVersion: string | null = null;
  let resizeObserverAtApplicationInit = 'not measured';
  let failure: Error | null = null;
  let findings: PixiMemoryFinding[] = [];
  let previousCanvas: JSHandle<HTMLCanvasElement> | null = null;
  let worldNeverMounted = false;

  try {
    await openWelcome(page);
    baselineCanvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
    await page.getByRole('button', { name: START_TUTORIAL }).click();
    await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({
      timeout: 30_000,
    });

    for (let cycle = 0; cycle <= PIXI_MEMORY_CYCLES; cycle += 1) {
      // The precondition, checked before the wait rather than after it. A document
      // already holding more canvases than one mounted world needs is a leak, and
      // waiting for a clean presentation would be waiting for that leak to exhaust
      // the browser's contexts: a hang in place of a finding. The flip still happens
      // on every cycle - the cycles have to be real for the series to mean anything -
      // and only the wait for a frame is shortened.
      const canvasesBefore = await countLiveCanvases(page);
      const documentIsClean = canvasesBefore === baselineCanvasCount + 1;
      const applicationArrived = await flipAndAwaitApplication(
        page,
        cycle + 1,
        cycle % 2 === 1 ? 'reduce' : 'no-preference',
        documentIsClean ? APPLICATION_WAIT_MS : LEAKING_DOCUMENT_APPLICATION_WAIT_MS,
      );
      const worldPresented =
        applicationArrived &&
        (await waitForPresented(
          page,
          documentIsClean ? MOUNT_PRESENT_TIMEOUT_MS : LEAKING_DOCUMENT_PRESENT_TIMEOUT_MS,
        ));

      const { reading, liveCanvas } = await readPage(page, previousCanvas);
      // A second reading of the same surface, `SETTLE_FRAMES` later. This is what
      // makes the byte count a measurement rather than a snapshot: a surface still
      // resizing has not reached a size, and the byte count sampled on it is a
      // snapshot of a transient whose extent depends on how many observer
      // deliveries the browser happened to make in a fixed dwell. The verdict for a
      // surface that never settles is `surface-not-settled`, which is the real
      // finding; the trend is not applied on top of it.
      const bytesOnFirstRead = reading.liveCanvasBackingBytes;
      const heightOnFirstRead = reading.liveCanvasCssHeight;
      const tickBefore = reading.liveTickerClock;
      // The re-read only means something when the world actually came up. Skipping
      // it otherwise keeps a leaking run short enough to finish and report, rather
      // than stalling on a compositor that is out of contexts.
      if (worldPresented) {
        await settleFrames(page, SETTLE_FRAMES);
      }
      const second = worldPresented ? (await readPage(page, liveCanvas)).reading : reading;
      const surfaceSettledAtSample =
        worldPresented &&
        second.liveCanvasBackingBytes === bytesOnFirstRead &&
        second.liveCanvasCssHeight === heightOnFirstRead;
      const counters = await readCdpCounters(cdp);
      const heapUsedBytes = await readHeap(page);

      if (cycle === 0) {
        unmaskedRenderer = await readUnmaskedRenderer(page);
        resizeObserverAtApplicationInit = reading.resizeObserverAtApplicationInit;
      }
      pixiVersion = reading.pixiVersion;

      samples.push({
        cycle,
        liveCanvasCount: reading.liveCanvasCount,
        liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
        applicationsCreated: reading.applicationsCreated,
        applicationsReleased: reading.applicationsReleased,
        applicationsRetained: reading.applicationsRetained,
        liveRendererContext: reading.liveRendererContext,
        worldPresented,
        liveTickerElapsedMs:
          tickBefore === null || second.liveTickerClock === null
            ? null
            : Math.max(0, Math.round(second.liveTickerClock - tickBefore)),
        previousCanvas: reading.previous,
        liveCanvasIsNew: reading.liveCanvasIsNew,
        surfaceSettledAtSample,
        pixiVersion: reading.pixiVersion,
        unmaskedRenderer,
        heapUsedBytes,
        domNodes: counters.domNodes,
        jsEventListeners: counters.jsEventListeners,
      });
      measurements.push({
        cycle,
        liveCanvasCount: reading.liveCanvasCount,
        liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
        liveCanvasCssHeight: reading.liveCanvasCssHeight,
        applicationsCreated: reading.applicationsCreated,
        applicationsReleased: reading.applicationsReleased,
        applicationsRetained: reading.applicationsRetained,
        liveTickerClock: second.liveTickerClock,
        previousCanvas: reading.previous,
        liveCanvasIsNew: reading.liveCanvasIsNew,
        surfaceSettledAtSample,
        surfaceBytesOnRecheck: second.liveCanvasBackingBytes,
        heapUsedBytes,
        domNodes: counters.domNodes,
        jsEventListeners: counters.jsEventListeners,
      });

      await previousCanvas?.dispose();
      previousCanvas = liveCanvas;

      // A world that never mounted makes twenty cycles meaningless, and twenty
      // copies of the same derived finding is a worse report than one that says
      // what happened. The run stops here, and the single finding names the cause.
      if (cycle === 0 && !worldPresented) {
        worldNeverMounted = true;
        break;
      }
    }

    findings = worldNeverMounted
      ? [
          {
            code: 'world-never-mounted',
            cycle: 0,
            message:
              'The Pixi-flagged build entered the world screen and no world was ever presented, so no mount or ' +
              'unmount cycle ran and this criterion is unmeasured rather than met. The first test in this lane ' +
              'reports the host\'s own failure sentence.',
          },
        ]
      : evaluatePixiMemoryRun({ baselineCanvasCount, cycles: PIXI_MEMORY_CYCLES, samples });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await previousCanvas?.dispose();
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(
      testInfo,
      browser.version(),
      verification,
      {
        contextKind: samples[0]?.liveRendererContext ?? 'none',
        unmaskedRenderer,
        pixiVersion,
        resizeObserverAtApplicationInit,
      },
      measurements,
      findings,
      failure,
    ),
  );
  if (failure) throw failure;
  expect(findings, `\n${describeFindings(findings)}`).toEqual([]);
});

test('a cycle that never remounts the world is reported as retained, so this gate is not vacuous', async ({
  page,
  browser,
}, testInfo) => {
  // A gate nobody has seen fail is a gate nobody should trust, and a browser cannot
  // be asked to produce a leaking series on demand. So one is produced here, on
  // purpose, in a real engine, and the verdict is read off the *same*
  // `evaluatePixiMemoryRun` the twenty-cycle test uses.
  //
  // The defect is a mount path that does not tear down: the world is mounted, and
  // then measured again with no media flip, no cleanup, and no second application.
  // The second sample is taken with the *first sample's own canvas handle* as the
  // previous canvas, which is exactly the argument the twenty-cycle test passes, so
  // the page reading is produced by the production path and the finding is produced
  // by the production verdict. Nothing here fabricates a counter, and nothing here
  // is a claim about the product: this world tears down correctly, as the test above
  // shows, and this test is what the gate would say if it did not.
  const verification = verifyRecordedArtifact();
  const measurements: LaneMeasurement[] = [];
  let findings: PixiMemoryFinding[] = [];
  let failure: Error | null = null;
  let codes: string[] = [];

  try {
    await enterWorld(page);
    const first = await readPage(page, null);
    const canvas = first.liveCanvas;
    // Left alone, so the surface reading below is a settled one and the only
    // findings this produces are the retention ones it is looking for.
    await settleFrames(page, SETTLE_FRAMES);
    const second = (await readPage(page, canvas)).reading;
    await canvas.dispose();

    const settled =
      second.liveCanvasBackingBytes === first.reading.liveCanvasBackingBytes &&
      second.liveCanvasCssHeight === first.reading.liveCanvasCssHeight;
    const toSample = (
      cycle: number,
      reading: typeof first.reading,
      previousCanvas: PreviousCanvasReading | null,
    ): PixiMemorySample => ({
      cycle,
      liveCanvasCount: reading.liveCanvasCount,
      liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
      applicationsCreated: reading.applicationsCreated,
      applicationsReleased: reading.applicationsReleased,
      applicationsRetained: reading.applicationsRetained,
      liveRendererContext: reading.liveRendererContext,
      worldPresented: true,
      liveTickerElapsedMs: reading.liveTickerClock,
      previousCanvas,
      liveCanvasIsNew: reading.liveCanvasIsNew,
      surfaceSettledAtSample: settled,
      pixiVersion: reading.pixiVersion,
      unmaskedRenderer: null,
      heapUsedBytes: null,
      domNodes: null,
      jsEventListeners: null,
    });

    // `cycles: 1` and two samples: one "first mount" and one that never happened.
    findings = evaluatePixiMemoryRun({
      baselineCanvasCount: 0,
      cycles: 1,
      // The previous-canvas argument for the *second* sample is the reading the
      // second `readPage` took of the first cycle's canvas, which is `second.previous`.
      // It is deliberately not the `previous` field of the *first* reading: `first` is
      // the one call made with a null previous canvas, so that field is null by
      // construction and the verdict function would skip both retention findings,
      // reporting `previous-canvas-unread` instead of the two this test exists to prove.
      samples: [toSample(0, first.reading, null), toSample(1, second, second.previous)],
    });
    codes = findings.map((entry) => entry.code);
    for (const [cycle, reading] of [
      [0, first.reading],
      [1, second],
    ] as const) {
      measurements.push({
        ...unmeasuredMeasurement(cycle),
        liveCanvasCount: reading.liveCanvasCount,
        liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
        liveCanvasCssHeight: reading.liveCanvasCssHeight,
        applicationsCreated: reading.applicationsCreated,
        applicationsReleased: reading.applicationsReleased,
        applicationsRetained: reading.applicationsRetained,
        liveTickerClock: reading.liveTickerClock,
        // Same reasoning as the samples above: cycle 1's previous canvas is
        // `second.previous`, the first cycle's canvas as seen by the second read.
        previousCanvas: cycle === 0 ? null : second.previous,
        liveCanvasIsNew: reading.liveCanvasIsNew,
        surfaceSettledAtSample: settled,
        surfaceBytesOnRecheck: reading.liveCanvasBackingBytes,
      });
    }

    expect(
      codes,
      'A mount path that never tore down was reported as clean, so the twenty-cycle verdict would pass a world ' +
        'that keeps every canvas, context and application it ever made.',
    ).not.toEqual([]);
    // The specific finding that matters: the sample reported a second measurement of
    // a world that was never remounted. The two retention findings follow from it -
    // the "previous" canvas is still attached and its context is still live - and are
    // the same codes a real leak of canvases or contexts would raise.
    for (const code of ['cycle-did-not-remount', 'retained-canvas', 'retained-webgl-context']) {
      expect(codes, code).toContain(code);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, UNMEASURED_RENDERER, measurements, findings, failure),
  );
  if (failure) throw failure;
});

test('a presented world does not grow its drawing surface while it is left idle', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  const measurements: LaneMeasurement[] = [];
  let idle: IdleGrowthInput | null = null;
  let findings: PixiMemoryFinding[] = [];
  let failure: Error | null = null;

  try {
    await enterWorld(page);
    const before = (await readPage(page, null)).reading;
    const tickBefore = before.liveTickerClock;
    await settleFrames(page, IDLE_DWELL_FRAMES);
    const afterHandle = await readPage(page, null);
    const after = afterHandle.reading;
    await afterHandle.liveCanvas.dispose();
    const tickAfter = after.liveTickerClock;

    idle = {
      bytesBefore: before.liveCanvasBackingBytes,
      bytesAfter: after.liveCanvasBackingBytes,
      dwellFrames: IDLE_DWELL_FRAMES,
      tickerTimeAdvancedMs:
        tickBefore === null || tickAfter === null ? null : Math.max(0, Math.round(tickAfter - tickBefore)),
      cssHeightBefore: before.liveCanvasCssHeight,
      cssHeightAfter: after.liveCanvasCssHeight,
    };
    measurements.push({
      ...unmeasuredMeasurement(0),
      liveCanvasCount: after.liveCanvasCount,
      liveCanvasBackingBytes: after.liveCanvasBackingBytes,
      liveCanvasCssHeight: after.liveCanvasCssHeight,
      applicationsCreated: after.applicationsCreated,
      applicationsReleased: after.applicationsReleased,
      applicationsRetained: after.applicationsRetained,
      liveTickerClock: tickAfter,
      surfaceSettledAtSample: idle.bytesAfter === idle.bytesBefore,
      surfaceBytesOnRecheck: after.liveCanvasBackingBytes,
    });
    findings = evaluateIdleGrowth(idle);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, UNMEASURED_RENDERER, measurements, findings, failure, {
      idle,
    }),
  );
  if (failure) throw failure;
  expect(findings, `\n${describeFindings(findings)}`).toEqual([]);
});

test('every world action is reachable from a 44 CSS-pixel labelled control, by keyboard', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  const measurements: LaneMeasurement[] = [];
  let failure: Error | null = null;

  try {
    await enterWorld(page);

    // The controls must be measurable, and a control being moved by a growing
    // surface is not measurable by anything, including a learner trying to press
    // it. Playwright's own actionability check reports that as a click timeout,
    // which is the least useful description of the cause, so the surface is
    // required to be still first and the message names the reason.
    const geometry = await page.evaluate(() => {
      const read = (): Array<{ label: string; width: number; height: number; top: number; tabIndex: number }> =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('.pixi-world-host button')).map(
          (button) => {
            const rect = button.getBoundingClientRect();
            return {
              label: button.getAttribute('aria-label') ?? '',
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              tabIndex: button.tabIndex,
            };
          },
        );
      const first = read();
      return new Promise<{ stable: boolean; controls: typeof first }>((resolve) => {
        requestAnimationFrame(() => {
          const second = read();
          resolve({
            stable:
              first.length === second.length &&
              first.every(
                (control, index) =>
                  control.top === second[index]?.top &&
                  control.width === second[index]?.width &&
                  control.height === second[index]?.height,
              ),
            controls: second,
          });
        });
      });
    });
    expect(
      geometry.stable,
      "The world host's controls moved between two consecutive frames, so the surface under the canvas is being " +
        'resized by something and no control can be aimed at. That is a real finding, not a test flake.',
    ).toBe(true);
    expect(geometry.controls.length, 'The DOM mirror published no controls at all.').toBeGreaterThan(0);
    for (const control of geometry.controls) {
      expect(control.label, 'A mirror control has no accessible name.').not.toBe('');
      expect(
        Math.min(control.width, control.height),
        `Mirror control "${control.label}" is ${control.width}x${control.height} CSS pixels, under the plan's ` +
          `${MINIMUM_TOUCH_TARGET_PX}x${MINIMUM_TOUCH_TARGET_PX} minimum touch target.`,
      ).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX);
      expect(control.tabIndex, `Mirror control "${control.label}" is not in the tab order.`).toBeGreaterThanOrEqual(0);
    }
    expect(geometry.controls.map((control) => control.label)).toEqual([LIGHT_CONTROL, RING_CONTROL]);

    // Keyboard operation, through the real tab order, with no pointer involved.
    // jsdom cannot decide this: it has no layout, so `getBoundingClientRect` there is
    // a stub and "44 CSS pixels" is a claim about a stylesheet rather than about a
    // box a learner aims at.
    const focusOrder: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return { inside: false, label: '' };
        const host = document.querySelector('.pixi-world-host');
        return {
          inside: host !== null && host.contains(active),
          label: active.getAttribute('aria-label') ?? (active.className || active.tagName),
        };
      });
      // Stop when focus leaves the world host again: the browser wraps round to the
      // body and the skip link, and collecting that would make the assertion about
      // the page's whole tab ring rather than about the world's own order.
      if (!stop.inside && focusOrder.length > 0) break;
      if (stop.inside) focusOrder.push(stop.label);
    }
    expect(
      focusOrder,
      "Tabbing through the world host did not reach exactly the two mirror controls, in the scene's own order.",
    ).toEqual([LIGHT_CONTROL, RING_CONTROL]);

    await tabUntilFocused(page, LIGHT_CONTROL);
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Lantern lit with 1 ember/)).toHaveCount(1);

    await tabUntilFocused(page, RING_CONTROL);
    await page.keyboard.press('Space');
    await expect(page.getByText(/Bell rung 1 time/)).toHaveCount(1);

    // The world's own keyboard shortcut, with focus off the mirror so the
    // keystroke is a world shortcut rather than a control's own activation.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('b');
    await expect(page.getByText(/Bell rung 2 times/)).toHaveCount(1);

    const canvasState = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
      return {
        ariaHidden: canvas?.getAttribute('aria-hidden') ?? null,
        tabIndex: canvas?.tabIndex ?? -1,
      };
    });
    expect(canvasState.ariaHidden, 'The canvas is exposed to assistive technology.').toBe('true');
    expect(canvasState.tabIndex, 'The canvas is a focus stop.').toBe(-1);

    measurements.push({
      ...unmeasuredMeasurement(0),
      liveCanvasCount: 1,
      liveTickerClock: null,
      surfaceSettledAtSample: geometry.stable,
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, UNMEASURED_RENDERER, measurements, [], failure),
  );
  if (failure) throw failure;
});

/**
 * Whether the document is hidden, as the product's own visibility policy reads it.
 *
 * This is not a visibility *simulation* bolted beside the product. `document.hidden`
 * and `document.visibilityState` are the two properties the host's
 * `observeVisibility` listener reads, and this writes them and dispatches the real
 * `visibilitychange` event the browser dispatches. What is stubbed is only the fact
 * of which tab is in front; the event, the listener, the `stopTicker`/`startTicker`
 * call, and the ticker itself are all the product's.
 */
async function setDocumentHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

interface LiveRendererQuality {
  readonly resolution: number | null;
  /** The real WebGL context's own `antialias` creation attribute. `null` with no context. */
  readonly contextAntialias: boolean | null;
  readonly hasRenderer: boolean;
}

/**
 * The quality knobs the *live* renderer is actually running with.
 *
 * `resolution` is read from PixiJS's own `renderer.resolution`, and `contextAntialias`
 * from the real WebGL context's `getContextAttributes()`. Both are the renderer's own
 * values rather than the profile a test hoped was handed over: a profile that was
 * computed but never reached `app.init` reads as `2`/`true` here rather than as the
 * number `resolveWorldQuality` would have returned.
 */
async function readLiveRendererQuality(page: Page): Promise<LiveRendererQuality> {
  return page.evaluate(() => {
    const probe = (globalThis as unknown as Record<string, unknown>)['__KD_PIXI_MEMORY_PROBE__'] as
      | { applications: Array<{ renderer?: { resolution?: unknown } | null }> }
      | undefined;
    const applications = probe?.applications ?? [];
    const renderer = applications[applications.length - 1]?.renderer ?? null;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
    const gl = canvas === null ? null : (canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    const attributes = gl?.getContextAttributes() ?? null;
    return {
      resolution: typeof renderer?.resolution === 'number' ? renderer.resolution : null,
      contextAntialias: attributes === null ? null : (attributes.antialias ?? null),
      hasRenderer: renderer !== null,
    };
  });
}

test('the ticker pauses while the document is hidden, and resumes when it is shown', async ({
  page,
  browser,
}, testInfo) => {
  // Plan section 10.2: "Ticker pause while the document is hidden." Two unit-level
  // tests already assert the host's visibility policy against a fake environment;
  // this is the browser-level half, and it is a different claim: that the real
  // PixiJS ticker on the real `Application` stops advancing and then advances again.
  // A policy that stopped calling `stopTicker` would leave both unit tests green and
  // this one red, which is the whole reason it exists.
  const verification = verifyRecordedArtifact();
  const measurements: LaneMeasurement[] = [];
  let failure: Error | null = null;
  let advanceWhileVisible = -1;
  let advanceWhileHidden = -1;
  let advanceAfterShown = -1;
  let clockAfterShown: number | null = null;

  try {
    await enterWorld(page);

    const visibleStart = (await readPage(page, null)).reading.liveTickerClock;
    await settleFrames(page, IDLE_DWELL_FRAMES);
    const visibleEnd = (await readPage(page, null)).reading.liveTickerClock;
    advanceWhileVisible =
      visibleStart === null || visibleEnd === null ? -1 : Math.round(visibleEnd - visibleStart);

    await setDocumentHidden(page, true);
    // Two frames, so the stop has certainly been applied by the product's own listener
    // before the hidden reading is taken and no in-flight update can be read as a tick.
    await settleFrames(page, 2);
    const hiddenStart = (await readPage(page, null)).reading.liveTickerClock;
    await settleFrames(page, IDLE_DWELL_FRAMES);
    const hiddenEnd = (await readPage(page, null)).reading.liveTickerClock;
    advanceWhileHidden =
      hiddenStart === null || hiddenEnd === null ? -1 : Math.round(hiddenEnd - hiddenStart);

    await setDocumentHidden(page, false);
    await settleFrames(page, 2);
    const shownStart = (await readPage(page, null)).reading.liveTickerClock;
    await settleFrames(page, IDLE_DWELL_FRAMES);
    const shownEnd = (await readPage(page, null)).reading.liveTickerClock;
    advanceAfterShown =
      shownStart === null || shownEnd === null ? -1 : Math.round(shownEnd - shownStart);
    clockAfterShown = shownEnd;

    measurements.push({
      ...unmeasuredMeasurement(0),
      liveCanvasCount: (await readPage(page, null)).reading.liveCanvasCount,
      liveTickerClock: clockAfterShown,
      surfaceSettledAtSample: true,
    });

    expect(
      advanceWhileVisible,
      'The mounted world did not advance its ticker while the document was visible, so this run ' +
        'could not have observed a pause in the first place.',
    ).toBeGreaterThanOrEqual(1);
    expect(
      advanceWhileHidden,
      'The ticker kept advancing while the document was hidden: the host did not pause it, so a ' +
        'backgrounded tab keeps presenting frames.',
    ).toBe(0);
    expect(
      advanceAfterShown,
      'The ticker did not resume after the document was shown again, so the pause was a stop.',
    ).toBeGreaterThanOrEqual(1);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, UNMEASURED_RENDERER, measurements, [], failure),
  );
  if (failure) throw failure;
});

test('the profile resolution reaches the live renderer as a cap on the device ratio', async ({
  page,
  browser,
}, testInfo) => {
  // Plan section 10.2: "Lower resolution and antialiasing profiles for constrained
  // devices", and plan section 12: "cap renderer resolution and antialiasing on
  // constrained devices". The unit suite proves `resolveWorldQuality` *computes*
  // `constrained` from two cores; this proves the computed profile reaches the real
  // `Application` and that its `resolution` is a *cap*, not an absolute multiplier.
  //
  // Three live readings, each after the world rebuilt into a new `Application`:
  //   1. constrained at the lane's DPR 1: resolution 1, antialias false.
  //   2. balanced at DPR 1 (raise the core count): resolution 1, antialias true. The
  //      profile's own cap is 2, and a DPR-1 display must not render at 2 - that is
  //      4x the raster pixels, downscaled, which is the regression QA measured on
  //      the built artifact.
  //   3. high at DPR 3 (raise the device ratio while the core count stays high):
  //      resolution 2, not 3, so the cap holds as density rises.
  const verification = verifyRecordedArtifact();
  const measurements: LaneMeasurement[] = [];
  let failure: Error | null = null;
  let constrained: LiveRendererQuality | null = null;
  let balanced: LiveRendererQuality | null = null;
  let dense: LiveRendererQuality | null = null;

  try {
    // Two logical cores, set on the real navigator before any application code runs.
    // That is the exact signal `readWorldQualitySignals` reads; the store, the hook,
    // and the `pixiInitOptions` binding are all untouched.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => 2 });
    });
    await enterWorld(page);
    constrained = await readLiveRendererQuality(page);

    // A live observation, not only a mount-time one: raise the core count and fire the
    // resize event `useWorldQuality` listens on, and the world must rebuild.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => 8 });
      window.dispatchEvent(new Event('resize'));
    });
    const rebuilt = await waitForApplications(page, 2);
    await settleFrames(page, SETTLE_FRAMES);
    balanced = await readLiveRendererQuality(page);

    // A second live rebuild, this time raising the *device ratio* while the core count
    // stays high. `resolveWorldQuality` then selects `high`, whose cap is also 2, and
    // the question is whether the renderer takes the raw ratio (3) or the cap (2).
    await page.evaluate(() => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 3 });
      window.dispatchEvent(new Event('resize'));
    });
    const denseRebuilt = await waitForApplications(page, 3);
    await settleFrames(page, SETTLE_FRAMES);
    dense = await readLiveRendererQuality(page);

    measurements.push({
      ...unmeasuredMeasurement(0),
      liveCanvasCount: (await readPage(page, null)).reading.liveCanvasCount,
      surfaceSettledAtSample: true,
    });

    expect(
      constrained.hasRenderer,
      'No live renderer existed under the constrained profile, so nothing was measured.',
    ).toBe(true);
    expect(
      constrained.resolution,
      'The constrained profile did not reach the live renderer: expected resolution 1.',
    ).toBe(1);
    expect(
      constrained.contextAntialias,
      'The constrained profile did not reach the live WebGL context: expected antialias false.',
    ).toBe(false);
    expect(
      rebuilt,
      'Raising the core count did not rebuild the world, so this run measured only one profile.',
    ).toBe(true);
    expect(balanced?.hasRenderer, 'No live renderer existed under the balanced profile.').toBe(true);
    expect(
      balanced?.resolution,
      'A DPR-1 display rendered the balanced profile above resolution 1: the profile resolution ' +
        'was applied as an absolute multiplier instead of capped at the device ratio.',
    ).toBe(1);
    expect(
      balanced?.contextAntialias,
      'The balanced profile did not reach the live WebGL context: expected antialias true.',
    ).toBe(true);
    expect(denseRebuilt, 'Raising the device ratio did not rebuild the world.').toBe(true);
    expect(dense?.hasRenderer, 'No live renderer existed under the high profile.').toBe(true);
    expect(
      dense?.resolution,
      'A DPR-3 display rendered above the profile cap: expected resolution 2, not the raw ratio.',
    ).toBe(2);
    expect(
      dense?.contextAntialias,
      'The high profile did not reach the live WebGL context: expected antialias true.',
    ).toBe(true);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, UNMEASURED_RENDERER, measurements, [], failure),
  );
  if (failure) throw failure;
});

test('reduced motion removes the movement and keeps the state change, in a real engine', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  const measurements: LaneMeasurement[] = [];
  const motion: MotionMeasurement[] = [];
  let findings: MotionVerdictFinding[] = [];
  let failure: Error | null = null;

  try {
    const withMotion = await measureMotion(page, 'no-preference');
    const withReducedMotion = await measureMotion(page, 'reduce');
    motion.push(withMotion, withReducedMotion);
    measurements.push(motionEvidence(0, withMotion), motionEvidence(1, withReducedMotion));

    findings = evaluateMotion({
      withMotion,
      withReducedMotion,
      control: withMotion.idleIsPixelStable ? 'idle-world-is-pixel-stable' : 'idle-world-is-not-pixel-stable',
    });

    // The state change is not motion and has to survive: the world says so in words,
    // and that sentence is the only part of the state a screen reader gets.
    expect(
      withMotion.statusSentence,
      'The host did not report motion as enabled in words.',
    ).toContain(MOTION_SENTENCE);
    expect(
      withReducedMotion.statusSentence,
      'The host did not report the reduced-motion state in words.',
    ).toContain(REDUCED_MOTION_SENTENCE);
    expect(
      withReducedMotion.stateAfterAction,
      'Under reduced motion the action stopped working as an action, rather than only stopping its movement.',
    ).toContain('Lantern lit with 1 ember');
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(testInfo, browser.version(), verification, UNMEASURED_RENDERER, measurements, [], failure, {
      motion,
    }),
  );
  if (failure) throw failure;
  expect(
    findings,
    `\n${findings.map((entry) => `[${entry.code}] ${entry.message}`).join('\n')}`,
  ).toEqual([]);
});

test('removing ResizeObserver changes no counter this lane can read', async ({
  browser,
}, testInfo) => {
  // The diagnostic that makes one of the lane's `doesNotProve` entries executable
  // rather than a claim. PixiJS 8.21.0's CanvasObserver leaks one `Ticker.shared`
  // listener per application when there is no `ResizeObserver`, and the counter that
  // moves is `Ticker.shared.count`, which the built bundle does not export. This test
  // records exactly that: with the global removed the world still mounts, still tears
  // down, and every counter the lane *can* read is identical. It is a statement about
  // the lane's reach, not a statement that the leak does not happen.
  const verification = verifyRecordedArtifact();
  const context = await browser.newContext({ viewport: { ...PIXI_MEMORY_LANE.viewport } });
  const page = await context.newPage();
  const measurements: LaneMeasurement[] = [];
  let failure: Error | null = null;
  let observed = 'not measured';
  let everyCyclePresented = true;

  try {
    await blockExternalOrigins(page);
    await installProbe(page, { dropResizeObserver: true });
    await openWelcome(page);
    await page.getByRole('button', { name: START_TUTORIAL }).click();
    await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({
      timeout: 30_000,
    });

    for (let cycle = 0; cycle <= 2; cycle += 1) {
      await flipAndAwaitApplication(
        page,
        cycle + 1,
        cycle % 2 === 1 ? 'reduce' : 'no-preference',
        APPLICATION_WAIT_MS,
      );
      if (!(await waitForPresented(page, MOUNT_PRESENT_TIMEOUT_MS))) everyCyclePresented = false;
      await settleFrames(page, SETTLE_FRAMES);
      const { reading, liveCanvas } = await readPage(page, null);
      observed = reading.resizeObserverAtApplicationInit;
      measurements.push({
        ...unmeasuredMeasurement(cycle),
        liveCanvasCount: reading.liveCanvasCount,
        liveCanvasBackingBytes: reading.liveCanvasBackingBytes,
        liveCanvasCssHeight: reading.liveCanvasCssHeight,
        applicationsCreated: reading.applicationsCreated,
        applicationsReleased: reading.applicationsReleased,
        applicationsRetained: reading.applicationsRetained,
        liveTickerClock: reading.liveTickerClock,
        liveCanvasIsNew: reading.liveCanvasIsNew,
        surfaceSettledAtSample: false,
        surfaceBytesOnRecheck: reading.liveCanvasBackingBytes,
      });
      await liveCanvas.dispose();
    }

    expect(observed, 'The runtime still had a ResizeObserver, so this diagnostic measured nothing.').toBe(
      'undefined',
    );
    // A diagnostic about which counters a lane can read is only worth anything on a
    // world that actually ran, so this cannot pass on a build whose world never
    // mounts. It failed that way once, which is why the check exists.
    expect(
      everyCyclePresented,
      'The world never presented, so this diagnostic says nothing about the counters and must not be read as ' +
        'saying the PixiJS defect is absent.',
    ).toBe(true);
    for (const measurement of measurements) {
      expect(measurement.liveCanvasCount, `cycle ${measurement.cycle} retained a canvas`).toBe(1);
      expect(
        measurement.applicationsRetained,
        `cycle ${measurement.cycle} retained an application`,
      ).toBe(1);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await context.close();
  }

  writeEvidenceFile(
    testInfo,
    baseEvidence(
      testInfo,
      browser.version(),
      verification,
      { ...UNMEASURED_RENDERER, resizeObserverAtApplicationInit: observed },
      measurements,
      [],
      failure,
    ),
  );
  if (failure) throw failure;
});

/* -------------------------------------------------------------------------- */
/* Reduced motion, measured in pixels                                          */
/* -------------------------------------------------------------------------- */

interface MotionReading extends MotionMeasurement {
  readonly stateAfterAction: string;
  readonly statusSentence: string;
  readonly idleIsPixelStable: boolean;
  readonly clip: { readonly width: number; readonly height: number };
}

/**
 * Whether lighting the lantern *moves* anything, measured from the compositor.
 *
 * The subtlety this exists for: lighting the lantern also *tints* it, and a tint is a
 * state change rather than movement, so the two runs are compared by the **area** the
 * change covers, not by byte equality. With motion enabled the lantern is scaled up
 * by `motion.travelPx('large')` before it is tinted, so the changed region is a
 * strictly larger disc; under reduced motion the travel is zero and the change stays
 * inside the lantern's base size. A byte-equality test would have called the correct
 * world broken, and the first run of this lane proved it.
 *
 * `page.screenshot({ clip })` is used rather than a locator screenshot because a
 * locator screenshot requires the element to be still, and "is this element still" is
 * a different question from the one being asked.
 */
async function measureMotion(
  page: Page,
  reducedMotion: 'reduce' | 'no-preference',
): Promise<MotionReading> {
  await page.emulateMedia({ reducedMotion });
  await openWelcome(page);
  await page.getByRole('button', { name: START_TUTORIAL }).click();
  await expect(page.getByRole('heading', { level: 1, name: WORLD_HEADING })).toBeVisible({ timeout: 30_000 });
  await page
    .locator('.pixi-world-host [aria-live]')
    .filter({ hasText: READY_SENTENCE })
    .waitFor({ timeout: 30_000 });
  await settleFrames(page, SETTLE_FRAMES);

  const box = await page.locator('[data-pixi-surface]').boundingBox();
  expect(box, 'The world surface has no box, so no pixel of it can be measured.').not.toBeNull();
  const clip = {
    x: Math.round(box?.x ?? 0),
    y: Math.round(box?.y ?? 0),
    width: Math.round(box?.width ?? 0),
    height: Math.round(box?.height ?? 0),
  };
  expect(clip.width).toBeGreaterThan(0);
  expect(clip.height).toBeGreaterThan(0);

  const before = await page.screenshot({ clip });
  const idleAgain = await page.screenshot({ clip });
  const idleIsPixelStable = before.equals(idleAgain);

  await page.getByRole('button', { name: LIGHT_CONTROL }).click();
  await expect(page.getByText(LANTERN_STATE)).toHaveCount(1);
  await settleFrames(page, SETTLE_FRAMES);
  const after = await page.screenshot({ clip });

  const beforeImage = decodePng(before);
  const afterImage = decodePng(after);
  let changedPixels = 0;
  let boundingBoxArea = 0;
  let decoded = false;
  if (beforeImage.ok && afterImage.ok) {
    const region = changedRegion(beforeImage.image, afterImage.image);
    changedPixels = region.changedPixels;
    boundingBoxArea = region.boundingBoxArea;
    decoded = true;
  }

  return {
    reducedMotion: reducedMotion === 'reduce',
    identical: before.equals(after),
    changedPixels,
    boundingBoxArea,
    decoded,
    idleIsPixelStable,
    clip: { width: clip.width, height: clip.height },
    stateAfterAction: (await page.getByText(LANTERN_STATE).innerText()).trim(),
    statusSentence: (await page.locator('.pixi-world-host [aria-live]').first().innerText()).trim(),
  };
}

function motionEvidence(cycle: number, reading: MotionReading): LaneMeasurement {
  return {
    ...unmeasuredMeasurement(cycle),
    liveCanvasCount: 1,
    liveCanvasCssHeight: reading.clip.height,
    surfaceSettledAtSample: reading.idleIsPixelStable,
  };
}
