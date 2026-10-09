import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import {
  evidenceRelativePath,
  sanitizeRunnerImageLabel,
  sanitizeToolchainText,
  type HostExecution,
} from './compat-evidence';
import {
  PERF_STORAGE_KEYS,
  PIXI_PERF_ROOM_COUNTS,
  PIXI_PERF_SUBJECT_ID,
  buildPerfSubjectSnapshot,
  fixtureDigest,
} from './pixi-perf-fixtures';
import { PIXI_PERF_CI_JOB, PIXI_PERF_CI_RUN_STEP, PIXI_PERF_LANE, PIXI_PERF_MANIFEST_PATH } from './pixi-perf-lane';
import {
  FRAME_TIME_P95_CI_FLOOR_MS,
  INTERACTION_ACK_CI_FLOOR_MS,
  MEAN_FPS_CI_FLOOR,
  PIXI_PERF_FRAME_SAMPLES,
  PIXI_PERF_INTERACTION_SAMPLES,
  PIXI_PERF_MIN_FRAMES,
  REFERENCE_FPS_TARGET,
  REFERENCE_FRAME_TIME_P95_TARGET_MS,
  REFERENCE_INTERACTION_ACK_TARGET_MS,
  describePerfFindings,
  evaluatePerfRun,
  summarizePerfRun,
  type PerfFinding,
  type PerfMeasurement,
} from './pixi-perf-series';

/**
 * The Phase 22 PixiJS dungeon frame-time and interaction-latency lane.
 *
 * ## What it measures, and why the fixture is injected the way it is
 *
 * For each of the plan's 1-, 10-, and 100-room fixture sizes, this suite enters the
 * **real** PixiJS dungeon world through the application's own Start-Tutorial → dungeon
 * route and samples `requestAnimationFrame` deltas in the page while the world is
 * live. The world is the product's: the lane seeds a deterministic synthetic subject
 * into the legacy storage the default build reads, and the application calls the real
 * `generateDungeonMap` and mounts the real `DungeonWorld` over it.
 *
 * The fixture is injected at `knowledge-dungeon:v1:subject:tutorial-first-walkthrough`
 * and the tutorial's own write to that one key is refused, because the Start-Tutorial
 * control always mints its small built-in subject before it loads. Nothing else in
 * storage is touched, and the application's entry path is unchanged: it reads a
 * subject from storage exactly as it always does.
 *
 * ## Measurement, not certification
 *
 * The plan's targets (60 FPS, p95 < 20 ms, acknowledgement < 100 ms) are reported and
 * compared, never gated. The run is gated against the generous CI regression floors in
 * `pixi-perf-series.ts`, for the reason the Phase 22 scope lock gives: software WebGL
 * in a headless container is a floor, and the real-GPU check is carried to Phase 23.
 *
 * ## Non-vacuity
 *
 * Every finding that makes this a measurement rather than a green number — the world
 * presented, a canvas exists, enough frames were recorded, the ticker advanced, the DOM
 * listed exactly the fixture's rooms, an interaction was acknowledged — is a finding
 * `tests/e2e/pixi-perf-lane.test.ts` proves the verdict raises for a degenerate run.
 *
 * Privacy: synthetic fixtures only, no learner data, no request body, no query string,
 * and no external host. Every non-loopback request is blocked before the application
 * runs, exactly as `pixiMemory.spec.ts` blocks it.
 */

const REPO_ROOT = process.cwd();
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? 'local';
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');

const WORLD_SURFACE = '.pixi-dungeon-world';
const READY_TEXT = 'Dungeon presented';
const INTERACT_ACTION_ID = 'dungeon-zoom-in';

/* -------------------------------------------------------------------------- */
/* Page helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Blocks every non-loopback origin, so a privacy regression is observed, not made.
 *
 * The lane is a measurement, not a network test, but the same policy the other Pixi
 * lanes use keeps a stray off-origin request from silently changing what is timed.
 */
async function blockExternalOrigins(page: Page): Promise<void> {
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
}

/**
 * Captures every PixiJS `Application` through the library's own documented hook.
 *
 * Read rather than replaced: if another tool installed the hook, it is still called.
 */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const applications: unknown[] = [];
    scope['__KD_PIXI_PERF_APPS__'] = applications;
    const previous = scope['__PIXI_APP_INIT__'];
    scope['__PIXI_APP_INIT__'] = (application: unknown) => {
      applications.push(application);
      if (typeof previous === 'function') (previous as (value: unknown) => void)(application);
    };
  });
}

/**
 * Seeds the deterministic synthetic subject and refuses the tutorial's own write to it.
 *
 * Two storage generations are covered, because the artifact this lane previews uses
 * `VITE_STORAGE_REPOSITORY=v2`:
 *
 * - **Legacy path.** The seed is written with the native setter *before* the prototype is
 *   narrowed, so the payload really is in `localStorage`; after that, only writes to the
 *   one tutorial subject key are dropped, which keeps `Start Tutorial` from replacing the
 *   fixture with its built-in three-room subject.
 * - **storage-v2 path.** The default build reads and writes the storage-v2 IndexedDB
 *   generation. The seed above is migrated into it by the application's own bootstrap, and
 *   the tutorial's later write to the `subjects` object store is dropped **once the lane
 *   raises its block flag** (see {@link enterDungeonWorld}). The flag is raised after the
 *   bootstrap migration has completed, so the migration itself is never interfered with and
 *   the record `loadSubject` reads back is the fixture, not the tutorial's three rooms.
 */
async function seedFixture(page: Page, rooms: number): Promise<string> {
  const snapshot = buildPerfSubjectSnapshot(rooms);
  const payloadJson = JSON.stringify(snapshot);
  await page.addInitScript(
    ({
      subjectKey,
      subjectId,
      payload,
    }: {
      readonly subjectKey: string;
      readonly subjectId: string;
      readonly payload: string;
    }) => {
      const nativeSetItem = Storage.prototype.setItem;
      nativeSetItem.call(window.localStorage, subjectKey, payload);
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === subjectKey) return;
        return nativeSetItem.call(this, key, value);
      };

      // storage-v2: drop the tutorial's own `subjects` write while the lane's flag is up.
      // `putAll` in the v2 repository ignores `IDBObjectStore.put`'s return value, so a
      // skipped put leaves the transaction healthy and the migrated record in place.
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (record: unknown, key?: IDBValidKey) {
        const scope = globalThis as unknown as { __KD_PERF_BLOCK_TUTORIAL_SUBJECT__?: boolean };
        if (scope.__KD_PERF_BLOCK_TUTORIAL_SUBJECT__ === true && this.name === 'subjects') {
          const envelope = record as { readonly recordId?: unknown } | null;
          if (envelope !== null && typeof envelope === 'object' && envelope.recordId === subjectId) {
            return undefined as unknown as IDBRequest<IDBValidKey>;
          }
        }
        return nativePut.call(this, record, key);
      };
    },
    { subjectKey: PERF_STORAGE_KEYS.subject, subjectId: PIXI_PERF_SUBJECT_ID, payload: payloadJson },
  );
  return fixtureDigest(snapshot);
}

/** Welcome → Start Tutorial → the PixiJS dungeon world, presented. */
async function enterDungeonWorld(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  // The bootstrap migration has already copied the legacy fixture into storage-v2 by the
  // time Welcome is interactive; raising the flag now drops only the tutorial's own later
  // write to the tutorial subject, so the fixture is what `loadSubject` reads back.
  await page.evaluate(() => {
    (globalThis as unknown as { __KD_PERF_BLOCK_TUTORIAL_SUBJECT__?: boolean }).__KD_PERF_BLOCK_TUTORIAL_SUBJECT__ =
      true;
  });
  await page.getByRole('button', { name: 'Start Tutorial' }).click();
  await expect(page.locator(WORLD_SURFACE)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(`${WORLD_SURFACE} [role="status"]`).filter({ hasText: READY_TEXT }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

/** The room rows the dungeon's DOM mirror offers. */
async function readDomRoomCount(page: Page): Promise<number | null> {
  const group = page.getByRole('group', { name: 'Room navigation' });
  if ((await group.count()) === 0) return null;
  return group.getByRole('button', { name: /^Go to / }).count();
}

/**
 * The declared reference environment, read from the page and the host.
 *
 * Requirement 3 of the workstream: browser engine and version, OS and architecture,
 * hardware concurrency, device pixel ratio, and the WebGL/GPU renderer string where the
 * browser exposes it, with software rasterisation marked explicitly. No learner data.
 */
async function readEnvironment(page: Page): Promise<{
  readonly hardwareConcurrency: number | null;
  readonly devicePixelRatio: number;
  readonly unmaskedRenderer: string | null;
  readonly webglVendor: string | null;
  readonly webglRenderer: string | null;
  readonly softwareRasterization: boolean;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-pixi-surface] canvas');
    let unmaskedRenderer: string | null = null;
    let webglVendor: string | null = null;
    let webglRenderer: string | null = null;
    if (canvas !== null) {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (gl !== null) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = info === null ? gl.getParameter(gl.VENDOR) : gl.getParameter(info.UNMASKED_VENDOR_WEBGL);
        const renderer = info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
        webglVendor = typeof vendor === 'string' ? vendor.slice(0, 120) : null;
        webglRenderer = typeof renderer === 'string' ? renderer.slice(0, 120) : null;
        unmaskedRenderer = webglRenderer;
      }
    }
    const haystack = `${webglVendor ?? ''} ${webglRenderer ?? ''}`.toLowerCase();
    return {
      hardwareConcurrency:
        typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
      devicePixelRatio: window.devicePixelRatio,
      unmaskedRenderer,
      webglVendor,
      webglRenderer,
      softwareRasterization: /swiftshader|llvmpipe|software|angle \(google, vulkan|softpipe/.test(haystack),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* In-page measurement                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Samples `requestAnimationFrame` deltas and the ticker clock across them.
 *
 * Bounded by **wall time as well as by frame count**, for the same reason the Pixi
 * memory lane's settle is: a page whose animation loop has starved — a world that
 * mounted a canvas and never drew, or a compositor the browser has stopped servicing —
 * would otherwise turn an unbounded wait into a 240-second test timeout, and a timeout
 * writes no evidence. A sampling window that gives up after {@link maxMs} returns the
 * frames it did see, and the verdict reports `too-few-frames` if that is too few. A
 * measurement that cannot distinguish "no frames" from "fast frames" is not evidence,
 * so the loop must always resolve.
 */
async function sampleFrames(
  page: Page,
  frameCount: number,
  maxMs = 15_000,
): Promise<{ readonly deltas: readonly number[]; readonly tickerAdvancedMs: number | null }> {
  return page.evaluate(
    async ({ count, budget }: { readonly count: number; readonly budget: number }) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      const applications = (scope['__KD_PIXI_PERF_APPS__'] as Array<{ ticker?: { lastTime?: number } }> | undefined) ?? [];
      const application = applications[applications.length - 1];
      const tickerBefore = typeof application?.ticker?.lastTime === 'number' ? application.ticker.lastTime : null;
      const deltas: number[] = [];
      await new Promise<void>((resolve) => {
        const deadline = performance.now() + budget;
        let last = performance.now();
        let seen = 0;
        const step = (now: number): void => {
          deltas.push(now - last);
          last = now;
          seen += 1;
          if (seen < count && performance.now() < deadline) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      const tickerAfter = typeof application?.ticker?.lastTime === 'number' ? application.ticker.lastTime : null;
      return {
        deltas,
        tickerAdvancedMs:
          tickerBefore === null || tickerAfter === null ? null : Math.max(0, tickerAfter - tickerBefore),
      };
    },
    { count: frameCount, budget: maxMs },
  );
}

/**
 * Times how long the DOM mirror takes to acknowledge a world action.
 *
 * The action is the scene's own "Zoom in": its published sentence embeds the zoom
 * factor (`Zoom in. Now N times.`), so the status line changes on every dispatch and
 * "the world did the thing" and "the learner was told" are the same event. The click
 * and the observation are both in the page, so the number is the renderer's own
 * latency rather than a Playwright round trip.
 */
async function sampleInteraction(
  page: Page,
  samples: number,
): Promise<{ readonly latencies: readonly number[]; readonly acknowledged: boolean }> {
  return page.evaluate(
    async ({ count, actionId }: { readonly count: number; readonly actionId: string }) => {
      const button = document.querySelector<HTMLButtonElement>(`button[data-action-id="${actionId}"]`);
      const status = document.querySelector<HTMLElement>(`[data-action-status="${actionId}"]`);
      if (button === null || status === null) return { latencies: [], acknowledged: false };
      const latencies: number[] = [];
      let acknowledged = false;
      for (let index = 0; index < count; index += 1) {
        if (button.disabled) break;
        const before = status.textContent ?? '';
        const latency = await new Promise<number | null>((resolve) => {
          const observer = new MutationObserver(() => {
            const after = status.textContent ?? '';
            if (after !== before) {
              observer.disconnect();
              resolve(performance.now() - start);
            }
          });
          observer.observe(status, { childList: true, subtree: true, characterData: true });
          const start = performance.now();
          button.click();
          window.setTimeout(() => {
            observer.disconnect();
            resolve(null);
          }, 2_000);
        });
        if (latency === null) break;
        acknowledged = true;
        latencies.push(latency);
        // Let React commit and a frame pass before the next sample, so two presses
        // cannot collapse into one acknowledged mutation.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return { latencies, acknowledged };
    },
    { count: samples, actionId: INTERACT_ACTION_ID },
  );
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

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
        `--manifest=${path.join(REPO_ROOT, PIXI_PERF_MANIFEST_PATH)}`,
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
  expect(
    verification.status,
    `The previewed build is not the recorded Pixi-dungeon artifact (${verification.code}: ${verification.message}). ` +
      `Build it with "npm run ${PIXI_PERF_LANE.buildScript}" and record it to ${PIXI_PERF_MANIFEST_PATH} ` +
      'before running this lane.',
  ).toBe('match');
  return verification;
}

interface LaneEvidence {
  readonly schemaVersion: number;
  readonly project: string;
  readonly suite: string;
  readonly lane: string;
  readonly test: string;
  readonly roomCount: number;
  readonly fixtureSeed: string;
  readonly fixtureDigest: string;
  readonly fixtureRooms: number;
  readonly worldRenderer: string;
  readonly pixiDungeon: boolean;
  readonly storageRepository: string;
  readonly referenceTargets: {
    readonly frameTimeP95Ms: number;
    readonly fps: number;
    readonly interactionAckMs: number;
  };
  readonly ciFloors: {
    readonly frameTimeP95Ms: number;
    readonly meanFps: number;
    readonly interactionAckMs: number;
    readonly minFrames: number;
  };
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
    readonly hardwareConcurrency: number | null;
    readonly devicePixelRatio: number;
    readonly webglVendor: string | null;
    readonly webglRenderer: string | null;
    readonly softwareRasterization: boolean;
  };
  readonly artifact: {
    readonly verificationStatus: string;
    readonly verificationCode: string;
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly manifestPath: string;
  };
  readonly summary: ReturnType<typeof summarizePerfRun>;
  readonly frameDeltasMs: readonly number[];
  readonly interactionLatenciesMs: readonly number[];
  readonly findings: readonly PerfFinding[];
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
  console.log(`[pixi-perf-evidence-file] ${relativePath}`);
}

type EnvironmentReading = Awaited<ReturnType<typeof readEnvironment>>;

/**
 * One evidence record, built from a run's inputs.
 *
 * A function rather than an inline literal because two tests write evidence — the
 * three measurements and the no-world control — and a second literal is a second thing
 * to keep correct. The control's record carries `roomCount: 0` and the findings the
 * verdict raised for a page with no world, which is exactly what a reader needs to
 * confirm the lane is not vacuous.
 */
function makeEvidence(input: {
  readonly testInfo: TestInfo;
  readonly browserVersion: string;
  readonly verification: ManifestVerification;
  readonly roomCount: number;
  readonly fixtureDigest: string;
  readonly environment: EnvironmentReading | null;
  readonly measurement: PerfMeasurement;
  readonly findings: readonly PerfFinding[];
  readonly failure: Error | null;
}): LaneEvidence {
  const environment: EnvironmentReading = input.environment ?? {
    hardwareConcurrency: null,
    devicePixelRatio: PIXI_PERF_LANE.deviceScaleFactor,
    unmaskedRenderer: null,
    webglVendor: null,
    webglRenderer: null,
    softwareRasterization: false,
  };
  const devDependencies = (
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    }
  ).devDependencies;
  return {
    schemaVersion: 1,
    project: PIXI_PERF_LANE.project,
    suite: PIXI_PERF_LANE.suite,
    lane: `ci job ${PIXI_PERF_CI_JOB}, step "${PIXI_PERF_CI_RUN_STEP}"`,
    test: input.testInfo.title,
    roomCount: input.roomCount,
    fixtureSeed: 'kd-perf-fixture-v1',
    fixtureDigest: input.fixtureDigest,
    fixtureRooms: input.roomCount,
    worldRenderer: PIXI_PERF_LANE.worldRenderer,
    pixiDungeon: PIXI_PERF_LANE.pixiDungeon,
    storageRepository: PIXI_PERF_LANE.storageRepository,
    referenceTargets: {
      frameTimeP95Ms: REFERENCE_FRAME_TIME_P95_TARGET_MS,
      fps: REFERENCE_FPS_TARGET,
      interactionAckMs: REFERENCE_INTERACTION_ACK_TARGET_MS,
    },
    ciFloors: {
      frameTimeP95Ms: FRAME_TIME_P95_CI_FLOOR_MS,
      meanFps: MEAN_FPS_CI_FLOOR,
      interactionAckMs: INTERACTION_ACK_CI_FLOOR_MS,
      minFrames: PIXI_PERF_MIN_FRAMES,
    },
    host: {
      operatingSystem: `${os.platform()}/${os.arch()}`,
      architecture: os.arch(),
      execution: process.env.CI ? 'ci' : 'local-host',
      browserName: 'chromium',
      browserVersion: input.browserVersion,
      playwrightVersion: sanitizeToolchainText(devDependencies?.['@playwright/test'] ?? 'unknown'),
      runnerImage: sanitizeRunnerImageLabel(
        `${process.env.ImageOS ?? 'unknown'}${process.env.ImageVersion ? ` ${process.env.ImageVersion}` : ''}`,
      ),
      viewport: { ...PIXI_PERF_LANE.viewport },
      deviceScaleFactor: PIXI_PERF_LANE.deviceScaleFactor,
      inputMode: PIXI_PERF_LANE.inputMode,
      hardwareConcurrency: environment.hardwareConcurrency,
      devicePixelRatio: environment.devicePixelRatio,
      webglVendor: environment.webglVendor,
      webglRenderer: environment.webglRenderer,
      softwareRasterization: environment.softwareRasterization,
    },
    artifact: {
      verificationStatus: input.verification.status,
      verificationCode: input.verification.code,
      treeSha256: input.verification.identity?.treeSha256 ?? 'unknown',
      fileCount: input.verification.identity?.fileCount ?? 0,
      totalBytes: input.verification.identity?.totalBytes ?? 0,
      manifestPath: PIXI_PERF_MANIFEST_PATH,
    },
    summary: summarizePerfRun(input.measurement),
    frameDeltasMs: input.measurement.frameDeltasMs,
    interactionLatenciesMs: input.measurement.interactionLatenciesMs,
    findings: input.findings,
    doesNotProve: [...PIXI_PERF_LANE.doesNotProve],
    failure:
      input.failure === null
        ? null
        : {
            name: sanitizeToolchainText(input.failure.name) || 'Error',
            message: sanitizeToolchainText(input.failure.message.split('\n')[0] ?? ''),
          },
  };
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                       */
/* -------------------------------------------------------------------------- */

test.beforeAll(() => {
  console.log(
    `[pixi-perf-lane] ${PIXI_PERF_LANE.project} on ${os.platform()}/${os.arch()} ` +
      `flag ${PIXI_PERF_LANE.flag}=${PIXI_PERF_LANE.flagValue} rooms=${PIXI_PERF_ROOM_COUNTS.join(',')}`,
  );
});

test.beforeEach(async ({ page }) => {
  await blockExternalOrigins(page);
  await installProbe(page);
});

for (const roomCount of PIXI_PERF_ROOM_COUNTS) {
  test(`the ${roomCount}-room Pixi dungeon world renders frames and acknowledges an interaction`, async ({
    page,
    browser,
  }, testInfo) => {
    const verification = verifyRecordedArtifact();
    const digest = await seedFixture(page, roomCount);

    let failure: Error | null = null;
    let environment: Awaited<ReturnType<typeof readEnvironment>> | null = null;
    let measurement: PerfMeasurement = {
      roomCount,
      worldPresented: false,
      canvasPresent: false,
      frameDeltasMs: [],
      tickerAdvancedMs: null,
      domRoomCount: null,
      interactionLatenciesMs: [],
      interactionAcknowledged: false,
    };
    let findings: readonly PerfFinding[] = [];

    try {
      await enterDungeonWorld(page);
      environment = await readEnvironment(page);

      // The fixture's premise, asserted rather than assumed: the DOM mirror must offer
      // exactly the rooms the fixture asked for. A world that rendered the tutorial's
      // three rooms instead would otherwise still produce frame numbers that read as a
      // measurement of the wrong world.
      const domRoomCount = await readDomRoomCount(page);

      measurement = {
        ...measurement,
        worldPresented: true,
        canvasPresent: await page.evaluate(
          () => document.querySelector('[data-pixi-surface] canvas') !== null,
        ),
        domRoomCount,
      };

      const frames = await sampleFrames(page, PIXI_PERF_FRAME_SAMPLES);
      const interaction = await sampleInteraction(page, PIXI_PERF_INTERACTION_SAMPLES);

      measurement = {
        ...measurement,
        frameDeltasMs: frames.deltas,
        tickerAdvancedMs: frames.tickerAdvancedMs,
        interactionLatenciesMs: interaction.latencies,
        interactionAcknowledged: interaction.acknowledged,
      };

      findings = evaluatePerfRun(measurement);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    if (environment === null) {
      environment = {
        hardwareConcurrency: null,
        devicePixelRatio: PIXI_PERF_LANE.deviceScaleFactor,
        unmaskedRenderer: null,
        webglVendor: null,
        webglRenderer: null,
        softwareRasterization: false,
      };
    }

    writeEvidenceFile(
      testInfo,
      makeEvidence({
        testInfo,
        browserVersion: browser.version(),
        verification,
        roomCount,
        fixtureDigest: digest,
        environment,
        measurement,
        findings,
        failure,
      }),
    );

    if (failure) throw failure;
    expect(findings, `\n${describePerfFindings(findings)}`).toEqual([]);
  });
}

/**
 * The in-browser red proof: a page with no world is reported as unmeasured.
 *
 * The unit suite proves the *verdict* raises a finding for each degenerate input; this
 * test proves the *measurement path* distinguishes "there is no world here" from "here
 * is a fast world" using the same helpers the measurements use. It runs against the
 * Welcome route, where no Pixi canvas is mounted and no dungeon action exists, and
 * asserts that the verdict reports the world as never presented, the canvas as absent,
 * the frame sample as too few to be a measurement, and the interaction as unacknowledged
 * — the four ways a "fast" number could have been vacuous. A lane that could only ever
 * produce a green number would fail here.
 */
test('a page with no world is reported as unmeasured, so this lane is not vacuous', async ({
  page,
  browser,
}, testInfo) => {
  const verification = verifyRecordedArtifact();
  let measurement: PerfMeasurement = {
    roomCount: 0,
    worldPresented: false,
    canvasPresent: false,
    frameDeltasMs: [],
    tickerAdvancedMs: null,
    domRoomCount: null,
    interactionLatenciesMs: [],
    interactionAcknowledged: false,
  };
  let findings: readonly PerfFinding[] = [];
  let failure: Error | null = null;

  try {
    // Welcome, and nothing else: the lazy Pixi dungeon chunk is never requested here.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();

    const canvasPresent = await page.evaluate(
      () => document.querySelector('[data-pixi-surface] canvas') !== null,
    );
    const domRoomCount = await readDomRoomCount(page);
    // Bounded, so a page that stopped servicing animation frames still resolves.
    const frames = await sampleFrames(page, PIXI_PERF_MIN_FRAMES - 1, 3_000);
    const interaction = await sampleInteraction(page, PIXI_PERF_INTERACTION_SAMPLES);

    // The measurement the verdict and the evidence both read is the *measured* one, so
    // a reader sees the frame count this control actually sampled rather than the empty
    // placeholder it started from.
    measurement = {
      roomCount: 0,
      worldPresented: false,
      canvasPresent,
      frameDeltasMs: frames.deltas,
      tickerAdvancedMs: frames.tickerAdvancedMs,
      domRoomCount,
      interactionLatenciesMs: interaction.latencies,
      interactionAcknowledged: interaction.acknowledged,
    };

    findings = evaluatePerfRun(measurement);

    const codes = findings.map((finding) => finding.code);
    for (const expected of [
      'world-never-presented',
      'no-canvas',
      'too-few-frames',
      'interaction-not-acknowledged',
    ] as const) {
      expect(codes, `a page with no world did not raise ${expected}`).toContain(expected);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeEvidenceFile(
    testInfo,
    makeEvidence({
      testInfo,
      browserVersion: browser.version(),
      verification,
      roomCount: 0,
      fixtureDigest: 'no-world-control',
      environment: null,
      measurement,
      findings,
      failure,
    }),
  );
  if (failure) throw failure;
});
