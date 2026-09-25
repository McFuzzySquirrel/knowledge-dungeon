import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chromium,
  expect,
  firefox,
  test,
  webkit,
  type APIRequestContext,
  type Browser,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test';
import {
  COMPAT_EVIDENCE_SCHEMA_VERSION,
  buildLocalRunId,
  buildNetworkPolicyReport,
  classifyRequestLike,
  classifyWebSocketLike,
  decideLaneOutcome,
  describeNetworkFailures,
  evidenceRelativePath,
  normalizeHost,
  sanitizeRunId,
  sanitizeRunnerImageLabel,
  sanitizeToolchainText,
  type DeviceEvidence,
  type HostExecution,
  type HostOperatingSystemId,
  type LaneOutcome,
  type NetworkPolicyReport,
  type SanitizedRequest,
  type WebSocketCategory,
} from './compat-evidence';
import {
  PHYSICAL_DEVICE_GATES,
  SUPPORT_CLAIM_BOUNDARY,
  SUPPORT_MATRIX_SCHEMA_VERSION,
  supportEntryForProject,
  validateSupportMatrix,
  type SupportMatrixEntry,
} from './support-matrix';

/**
 * Phase 1A cross-engine compatibility suite.
 *
 * Scope: prove that one recorded production web artifact loads and runs the
 * synthetic core flow in each named compatibility project, and record sanitized
 * evidence for the staged support matrix. This suite deliberately does not
 * replace `currentBuild.spec.ts`, which remains the Phase 1 current-build
 * Phaser/axe/privacy suite for the four Chromium viewport projects.
 *
 * Privacy contract: every test uses only the built-in synthetic tutorial subject
 * and never reads or writes learner data. Network input is reduced to bounded
 * categories and counts by `compat-evidence.ts`; request headers, query strings,
 * fragments, request bodies, credentials, hostnames, ports, and private URLs are
 * never captured, and non-loopback HTTP(S) traffic is blocked before it can leave
 * the test browser. Evidence is written as one sanitized JSON file per run and
 * project, including on failure. These projects are configured with
 * `trace: 'off'`, no failure screenshot, and no video, so a failing lane cannot
 * leave a raw DOM, network, or video artifact behind.
 */

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(REPO_ROOT, 'artifacts', 'web-artifact-manifest.json');
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');
const FALLBACK_PREVIEW_ORIGIN = 'http://127.0.0.1:43173';
const IS_CI = Boolean(process.env.CI);
const EXPECTED_HOST = process.env.KD_COMPAT_EXPECT_HOST?.trim() || null;
/**
 * One identifier per Playwright run. `playwright.config.ts` generates it and
 * exports it through the environment so every worker of a run shares it and
 * reruns never overwrite each other's records.
 */
const RUN_ID = sanitizeRunId(
  process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid),
);
const RUN_STARTED_AT = new Date().toISOString();
const HOST_EXECUTION: HostExecution = IS_CI ? 'ci' : 'local-host';
const RUNNER_IMAGE = {
  os: sanitizeRunnerImageLabel(process.env.ImageOS),
  version: sanitizeRunnerImageLabel(process.env.ImageVersion),
};

interface RecordedManifest {
  readonly schemaVersion?: number;
  readonly generatedAt?: string;
  readonly identity?: {
    readonly algorithm?: string;
    readonly treeSha256?: string;
    readonly fileCount?: number;
    readonly totalBytes?: number;
  };
  readonly entrypoint?: { readonly path?: string; readonly sha256?: string; readonly bytes?: number };
  readonly build?: {
    readonly expectedBuildCommand?: string;
    readonly node?: string;
    readonly platform?: string;
    readonly arch?: string;
    readonly tools?: Record<string, string | null>;
    readonly git?: { readonly revision?: string | null };
  };
  readonly files?: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
}

interface ManifestVerification {
  readonly status: string;
  readonly code: string;
  readonly message: string;
  readonly problemCodes?: readonly string[];
  readonly identity?: {
    readonly algorithm: string;
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  } | null;
  readonly recordedIdentity?: {
    readonly algorithm: string;
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  } | null;
  readonly entrypoint?: { readonly path: string; readonly sha256: string; readonly bytes: number } | null;
  readonly recordedEntrypoint?: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  } | null;
  readonly differences?: readonly { readonly path: string; readonly kind: string }[];
}

interface ArtifactEvidence {
  readonly verificationStatus: string;
  readonly verificationCode: string;
  readonly verificationProblemCodes: readonly string[];
  readonly differenceCount: number;
  readonly algorithm: string;
  readonly distTreeSha256: string;
  readonly recordedTreeSha256: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Hash recorded in the manifest, never a value recomputed inside the test. */
  readonly recordedEntrypointSha256: string;
  readonly servedEntrypointSha256: string;
  readonly servedEntrypointMatchesRecorded: boolean;
  readonly servedStatus: number;
  readonly distIncludesRendererChunkMatchingPixi: boolean;
  readonly manifestGeneratedAt: string | null;
  readonly buildHost: { readonly platform: string; readonly arch: string; readonly node: string | null };
  readonly buildTools: Readonly<Record<string, string | null>>;
  readonly gitRevision: string | null;
  readonly expectedBuildCommand: string | null;
}

interface RendererEvidence {
  readonly mode: string;
  readonly expectedMode: string;
  readonly graphicsContext: string;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly clientWidth: number;
    readonly clientHeight: number;
  };
  readonly phaserChunkRequested: boolean;
}

interface CompatibilityEvidence {
  readonly schemaVersion: number;
  readonly phase: '1A';
  readonly suite: 'cross-engine-compatibility';
  readonly supportMatrixSchema: number;
  readonly runId: string;
  readonly runStartedAt: string;
  readonly hostExecution: HostExecution;
  readonly project: string;
  readonly testTitle: string;
  readonly laneOutcome: LaneOutcome;
  readonly suiteEntry: {
    readonly hostOperatingSystems: readonly string[];
    readonly engine: string;
    readonly channel: string;
    readonly channelOption: string | null;
    readonly formFactor: string;
    readonly inputMode: string;
    readonly evidenceClass: string;
    readonly ciLanes: readonly string[];
    readonly expectedRendererMode: string;
    readonly claim: string;
    readonly doesNotProve: readonly string[];
  };
  readonly host: {
    readonly platform: NodeJS.Platform;
    readonly hostOperatingSystem: HostOperatingSystemId | null;
    readonly type: string;
    readonly release: string;
    readonly arch: string;
    readonly runnerImage: { readonly os: string | null; readonly version: string | null };
    readonly ci: boolean;
    readonly expectedHost: string | null;
    readonly hostMatchesApprovedLane: boolean;
    readonly approvedHosts: readonly string[];
  };
  readonly device: {
    readonly deviceEvidence: DeviceEvidence;
    readonly physicalDevice: false;
    readonly formFactor: string;
    readonly declaredViewport: { readonly width: number; readonly height: number };
    readonly observedViewport: { readonly innerWidth: number; readonly innerHeight: number };
    readonly deviceScaleFactor: number;
    readonly observedDevicePixelRatio: number;
    readonly orientation: string;
    readonly matchesMatrix: boolean;
  };
  readonly input: {
    readonly mode: string;
    readonly declaredHasTouch: boolean;
    readonly observedMaxTouchPoints: number;
    readonly ontouchstartInWindow: boolean;
    readonly isMobileEmulation: boolean;
  };
  readonly browser: {
    readonly engine: string;
    readonly channel: string;
    readonly channelOption: string | null;
    readonly bundled: boolean;
    readonly version: string;
    readonly userAgent: string;
    readonly brandToken: string | null;
    readonly brandedBrowserClaim: string | null;
  };
  readonly renderer: RendererEvidence;
  readonly artifact: ArtifactEvidence;
  readonly network: NetworkPolicyReport;
  readonly failure: { readonly name: string; readonly message: string } | null;
  readonly claimBoundary: readonly string[];
  readonly pendingPhysicalDeviceGates: readonly string[];
}

const NOT_OBSERVED_RENDERER: RendererEvidence = {
  mode: 'not-observed',
  expectedMode: 'phaser',
  graphicsContext: 'not-observed',
  canvas: { width: 0, height: 0, clientWidth: 0, clientHeight: 0 },
  phaserChunkRequested: false,
};

const UNVERIFIED_ARTIFACT: ArtifactEvidence = {
  verificationStatus: 'not-verified',
  verificationCode: 'verification-did-not-complete',
  verificationProblemCodes: [],
  differenceCount: 0,
  algorithm: 'unknown',
  distTreeSha256: 'unknown',
  recordedTreeSha256: null,
  fileCount: 0,
  totalBytes: 0,
  recordedEntrypointSha256: '',
  servedEntrypointSha256: '',
  servedEntrypointMatchesRecorded: false,
  servedStatus: 0,
  distIncludesRendererChunkMatchingPixi: false,
  manifestGeneratedAt: null,
  buildHost: { platform: 'unknown', arch: 'unknown', node: null },
  buildTools: {},
  gitRevision: null,
  expectedBuildCommand: null,
};

let entry: SupportMatrixEntry;
let actualHost: HostOperatingSystemId | null = null;
let hostApproved = false;

function readRecordedManifest(): RecordedManifest {
  let contents: string;
  try {
    contents = readFileSync(MANIFEST_PATH, 'utf8');
  } catch {
    throw new Error(
      'No recorded web-artifact identity is available. Run "npm run build:web && npm run record:web-artifact" ' +
        'or "npm run test:e2e:compat" locally, or download the shared CI artifact.',
    );
  }
  return JSON.parse(contents) as RecordedManifest;
}

function recordedEntrypointSha256(manifest: RecordedManifest): string {
  const sha256 = manifest.entrypoint?.sha256;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('The recorded web-artifact manifest has no valid recorded index.html entrypoint hash.');
  }
  return sha256;
}

/**
 * Verifies that the `dist` tree on disk is byte-identical to the recorded
 * artifact. Hashing and integrity rules live in the manifest script so the
 * Playwright suite, local commands, and CI share one implementation, and
 * integrity failures arrive as sanitized structured output instead of a raw
 * exception.
 */
function verifyRecordedArtifact(): ManifestVerification {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [MANIFEST_SCRIPT, 'verify', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (error) {
    const failure = error as { stdout?: string };
    stdout = failure.stdout ?? '';
    if (stdout.trim().length === 0) {
      throw new Error(
        `The web-artifact verification command produced no structured result (${sanitizeToolchainText(error)}).`,
      );
    }
  }

  const verification = JSON.parse(stdout) as ManifestVerification;
  expect(
    verification.status,
    `The web build is not the recorded production artifact (${verification.code}: ${verification.message}). ` +
      'Compatibility lanes must run the recorded artifact instead of rebuilding a different one.',
  ).toBe('match');
  return verification;
}

function sha256Hex(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function servedEntrypointSha256(request: APIRequestContext): Promise<{
  readonly status: number;
  readonly sha256: string;
}> {
  const response = await request.get('/');
  expect(response.status(), 'The production preview must serve the recorded entrypoint.').toBe(200);
  return { status: response.status(), sha256: sha256Hex(await response.body()) };
}

function buildArtifactEvidence(
  verification: ManifestVerification,
  manifest: RecordedManifest,
  served: { readonly status: number; readonly sha256: string },
): ArtifactEvidence {
  const identity = verification.identity;
  if (!identity) {
    throw new Error('The web-artifact verification result did not include an identity.');
  }
  const recordedSha256 = recordedEntrypointSha256(manifest);

  return {
    verificationStatus: verification.status,
    verificationCode: verification.code,
    verificationProblemCodes: verification.problemCodes ?? [],
    differenceCount: verification.differences?.length ?? 0,
    algorithm: identity.algorithm,
    distTreeSha256: identity.treeSha256,
    recordedTreeSha256: verification.recordedIdentity?.treeSha256 ?? null,
    fileCount: identity.fileCount,
    totalBytes: identity.totalBytes,
    recordedEntrypointSha256: recordedSha256,
    servedEntrypointSha256: served.sha256,
    // The served entrypoint is compared with the recorded manifest hash, not with
    // a value recomputed during the test.
    servedEntrypointMatchesRecorded: served.sha256 === recordedSha256,
    servedStatus: served.status,
    distIncludesRendererChunkMatchingPixi: (manifest.files ?? []).some((file) => /pixi/i.test(file.path)),
    manifestGeneratedAt: manifest.generatedAt ?? null,
    buildHost: {
      platform: manifest.build?.platform ?? 'unknown',
      arch: manifest.build?.arch ?? 'unknown',
      node: manifest.build?.node ?? null,
    },
    buildTools: manifest.build?.tools ?? {},
    gitRevision: manifest.build?.git?.revision ?? null,
    expectedBuildCommand: manifest.build?.expectedBuildCommand ?? null,
  };
}

function browserTypeFor(matrixEntry: SupportMatrixEntry) {
  switch (matrixEntry.engine) {
    case 'chromium':
      return chromium;
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
  }
}

async function collectEnvironmentEvidence(input: {
  page: Page;
  browser: Browser;
  testInfo: TestInfo;
  artifact: ArtifactEvidence;
  network: NetworkPolicyReport;
  renderer: RendererEvidence;
  failure: Error | null;
}): Promise<CompatibilityEvidence> {
  const observed = await input.page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    ontouchstartInWindow: 'ontouchstart' in window,
    userAgent: navigator.userAgent,
  }));

  const brandToken = observed.userAgent.includes('Edg/') ? 'Edg/' : null;

  return {
    schemaVersion: COMPAT_EVIDENCE_SCHEMA_VERSION,
    phase: '1A',
    suite: 'cross-engine-compatibility',
    supportMatrixSchema: SUPPORT_MATRIX_SCHEMA_VERSION,
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    hostExecution: HOST_EXECUTION,
    project: entry.project,
    testTitle: input.testInfo.title,
    laneOutcome: 'run',
    suiteEntry: {
      hostOperatingSystems: entry.hostOperatingSystems,
      engine: entry.engine,
      channel: entry.channel,
      channelOption: entry.channelOption ?? null,
      formFactor: entry.formFactor,
      inputMode: entry.inputMode,
      evidenceClass: entry.evidenceClass,
      ciLanes: entry.ciLanes,
      expectedRendererMode: entry.expectedRendererMode,
      claim: entry.claim,
      doesNotProve: entry.doesNotProve,
    },
    host: {
      platform: os.platform(),
      hostOperatingSystem: actualHost,
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      runnerImage: RUNNER_IMAGE,
      ci: IS_CI,
      expectedHost: EXPECTED_HOST,
      hostMatchesApprovedLane: hostApproved,
      approvedHosts: entry.hostOperatingSystems,
    },
    device: {
      deviceEvidence: 'emulated',
      physicalDevice: false,
      formFactor: entry.formFactor,
      declaredViewport: { width: entry.viewport.width, height: entry.viewport.height },
      observedViewport: { innerWidth: observed.innerWidth, innerHeight: observed.innerHeight },
      deviceScaleFactor: entry.deviceScaleFactor,
      observedDevicePixelRatio: observed.devicePixelRatio,
      orientation: observed.innerWidth >= observed.innerHeight ? 'landscape' : 'portrait',
      matchesMatrix:
        observed.innerWidth === entry.viewport.width &&
        observed.innerHeight === entry.viewport.height &&
        observed.devicePixelRatio === entry.deviceScaleFactor,
    },
    input: {
      mode: entry.inputMode,
      declaredHasTouch: entry.hasTouch,
      observedMaxTouchPoints: observed.maxTouchPoints,
      ontouchstartInWindow: observed.ontouchstartInWindow,
      isMobileEmulation: entry.isMobileEmulation,
    },
    browser: {
      engine: input.browser.browserType().name(),
      channel: entry.channel,
      channelOption: entry.channelOption ?? null,
      bundled: entry.channel === 'playwright-bundled',
      version: input.browser.version(),
      userAgent: observed.userAgent,
      brandToken,
      brandedBrowserClaim: brandToken === 'Edg/' ? 'Microsoft Edge channel' : null,
    },
    renderer: input.renderer,
    artifact: input.artifact,
    network: input.network,
    failure: input.failure
      ? {
          name: sanitizeToolchainText(input.failure.name) || 'Error',
          message: sanitizeToolchainText(input.failure.message.split('\n')[0] ?? ''),
        }
      : null,
    claimBoundary: SUPPORT_CLAIM_BOUNDARY,
    pendingPhysicalDeviceGates: PHYSICAL_DEVICE_GATES.map((gate) => gate.id),
  };
}

function writeEvidenceFile(testInfo: TestInfo, evidence: CompatibilityEvidence): void {
  const relativePath = evidenceRelativePath({
    runId: RUN_ID,
    project: evidence.project,
    testTitle: testInfo.title,
  });
  const absolutePath = path.join(REPO_ROOT, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[compat-evidence-file] ${relativePath}`);
}

function logEvidenceSummary(evidence: CompatibilityEvidence): void {
  console.log(
    `[compat-evidence] ${JSON.stringify({
      runId: evidence.runId,
      hostExecution: evidence.hostExecution,
      project: evidence.project,
      host: `${evidence.host.platform}/${evidence.host.arch}`,
      approvedHost: evidence.host.hostMatchesApprovedLane,
      runnerImage: `${evidence.host.runnerImage.os ?? 'unknown'}/${evidence.host.runnerImage.version ?? 'unknown'}`,
      browser: `${evidence.browser.engine}${
        evidence.browser.channelOption ? `:${evidence.browser.channelOption}` : ''
      } ${evidence.browser.version}`,
      deviceEvidence: evidence.device.deviceEvidence,
      viewport: `${evidence.device.declaredViewport.width}x${evidence.device.declaredViewport.height}@${evidence.device.deviceScaleFactor}`,
      input: evidence.input.mode,
      maxTouchPoints: evidence.input.observedMaxTouchPoints,
      renderer: evidence.renderer.mode,
      evidenceClass: evidence.suiteEntry.evidenceClass,
      artifact: `${evidence.artifact.algorithm}:${evidence.artifact.distTreeSha256.slice(0, 12)}`,
      servedEntrypointMatchesRecorded: evidence.artifact.servedEntrypointMatchesRecorded,
      networkViolations: evidence.network.violations.length,
      failed: evidence.failure !== null,
    })}`,
  );
}

/**
 * Runs a lane body and always writes the sanitized per-run evidence file,
 * including on failure, so a failing lane still leaves an allowlisted JSON record
 * with no raw DOM, trace, screenshot, or network capture.
 */
async function runCompatLane(
  context: { testInfo: TestInfo; page: Page; browser: Browser; request: APIRequestContext; localOrigin: string },
  body: (lane: {
    readonly artifact: ArtifactEvidence;
    readonly requests: SanitizedRequest[];
    readonly webSockets: WebSocketCategory[];
    readonly setRenderer: (renderer: RendererEvidence) => void;
  }) => Promise<void>,
): Promise<void> {
  const requests: SanitizedRequest[] = [];
  const webSockets: WebSocketCategory[] = [];
  let renderer: RendererEvidence = NOT_OBSERVED_RENDERER;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  let failure: Error | null = null;

  try {
    const verification = verifyRecordedArtifact();
    const manifest = readRecordedManifest();
    const served = await servedEntrypointSha256(context.request);
    artifact = buildArtifactEvidence(verification, manifest, served);
    expect(
      artifact.servedEntrypointMatchesRecorded,
      'The preview server must serve the recorded manifest entrypoint byte-for-byte.',
    ).toBe(true);
    expect(artifact.distIncludesRendererChunkMatchingPixi).toBe(false);

    await body({ artifact, requests, webSockets, setRenderer: (next) => (renderer = next) });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const evidence = await collectEnvironmentEvidence({
    page: context.page,
    browser: context.browser,
    testInfo: context.testInfo,
    artifact,
    network: buildNetworkPolicyReport(requests, webSockets),
    renderer,
    failure,
  });

  writeEvidenceFile(context.testInfo, evidence);
  logEvidenceSummary(evidence);

  if (failure) throw failure;
  expect(evidence.network.violations, describeNetworkFailures(evidence.network)).toEqual([]);
  expect(evidence.network.webSockets.total).toBe(0);
}

test.beforeAll(async () => {
  const matrixProblems = validateSupportMatrix();
  expect(matrixProblems, `Support matrix is inconsistent:\n${matrixProblems.join('\n')}`).toEqual([]);

  entry = supportEntryForProject(test.info().project.name);
  actualHost = normalizeHost(os.platform());
  hostApproved = actualHost !== null && entry.hostOperatingSystems.includes(actualHost);

  if (EXPECTED_HOST) {
    expect(
      actualHost,
      `This lane is declared for host "${EXPECTED_HOST}" (KD_COMPAT_EXPECT_HOST) but ran on Node platform "${os.platform()}".`,
    ).toBe(EXPECTED_HOST);
  }

  // A lane never emits passing evidence on a host it is not approved for. The
  // host decision is made before any browser probe so the reason is unambiguous:
  // a locally inapplicable lane is skipped as "not selected" evidence, and the
  // same mismatch fails the lane on a runner.
  if (!hostApproved) {
    const decision = decideLaneOutcome({
      hostApproved,
      isCi: IS_CI,
      browserAvailable: false,
      project: entry.project,
      approvedHosts: entry.hostOperatingSystems,
      actualHost: actualHost ?? os.platform(),
      engine: entry.engine,
      channelOption: entry.channelOption,
      installTargets: entry.installTargets,
    });
    console.log(`[compat-lane] ${entry.project} not selected: ${decision.reason}`);
    if (decision.outcome === 'fail-host') {
      throw new Error(`Compatibility lane ${entry.project} ran on an unapproved host. ${decision.reason}`);
    }
    test.skip(true, decision.reason);
    return;
  }

  let probe: Browser | null = null;
  let probeFailure: string | null = null;
  try {
    probe = await browserTypeFor(entry).launch(
      entry.channelOption ? { channel: entry.channelOption } : undefined,
    );
  } catch (error) {
    probeFailure = error instanceof Error ? error.message : String(error);
  }
  await probe?.close();

  const decision = decideLaneOutcome({
    hostApproved,
    isCi: IS_CI,
    browserAvailable: probe !== null,
    project: entry.project,
    approvedHosts: entry.hostOperatingSystems,
    actualHost: actualHost ?? os.platform(),
    engine: entry.engine,
    channelOption: entry.channelOption,
    installTargets: entry.installTargets,
    browserFailureText: probeFailure ?? undefined,
  });

  if (decision.outcome !== 'run') {
    console.log(`[compat-lane] ${entry.project} failed: ${decision.reason}`);
    // An unavailable browser build on an approved host is a lane failure, never a
    // green run with silently skipped tests.
    throw new Error(`Compatibility lane ${entry.project} cannot run. ${decision.reason}`);
  }

  console.log(
    `[compat-lane] ${entry.project} selected on ${os.platform()}/${os.arch()} ` +
      `(${os.release() || 'unknown release'}) node ${process.version} ` +
      `runner ${RUNNER_IMAGE.os ?? 'unavailable'}/${RUNNER_IMAGE.version ?? 'unavailable'}`,
  );
});

test.beforeEach(async ({ page }) => {
  // Keep the lane offline: no external request can leave the test browser, and
  // the sanitized network report still records what the application attempted.
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
});

function observeSanitized(request: Request, localOrigin: string | null): SanitizedRequest {
  return classifyRequestLike(
    {
      url: () => request.url(),
      method: () => request.method(),
      resourceType: () => request.resourceType(),
    },
    localOrigin,
  );
}

test('records the approved support-matrix lane and the recorded artifact identity', async ({
  page,
  browser,
  request,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;

  await runCompatLane({ testInfo, page, browser, request, localOrigin }, async ({ artifact }) => {
    expect(artifact.verificationStatus).toBe('match');
    expect(artifact.fileCount).toBeGreaterThan(0);
    expect(artifact.recordedTreeSha256).toBe(artifact.distTreeSha256);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Tutorial' })).toBeVisible();

    const observed = await collectEnvironmentEvidence({
      page,
      browser,
      testInfo,
      artifact,
      network: buildNetworkPolicyReport([], []),
      renderer: NOT_OBSERVED_RENDERER,
      failure: null,
    });

    // The observed run must match the declared lane, otherwise the record would
    // describe a different environment than the approved matrix entry.
    expect(observed.browser.engine).toBe(entry.engine);
    expect(observed.device.matchesMatrix).toBe(true);
    expect(observed.device.deviceEvidence).toBe('emulated');
    expect(observed.device.physicalDevice).toBe(false);
    expect(observed.host.hostMatchesApprovedLane).toBe(true);
    expect(observed.input.observedMaxTouchPoints > 0).toBe(entry.hasTouch);
    if (entry.channelOption) {
      expect(
        observed.browser.brandToken,
        `${entry.channelOption} channel runs must report the branded Edge token.`,
      ).toBe('Edg/');
    } else {
      expect(
        observed.browser.brandToken,
        'A Playwright-bundled engine lane must not report branded-browser evidence.',
      ).toBeNull();
    }
  });
});

test('renders the default Phaser world from the recorded artifact with static-only traffic', async ({
  page,
  browser,
  request,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;

  await runCompatLane(
    { testInfo, page, browser, request, localOrigin },
    async ({ artifact, requests, webSockets, setRenderer }) => {
      page.on('request', (observed) => requests.push(observeSanitized(observed, localOrigin)));
      await page.routeWebSocket(() => true, (webSocket) => {
        webSockets.push(classifyWebSocketLike(webSocket.url(), localOrigin));
      });

      await page.goto('/');
      await page.getByRole('button', { name: 'Start Tutorial' }).click();

      const canvas = page.locator('.game-canvas-host canvas');
      await expect(canvas).toBeVisible({ timeout: 30_000 });

      const canvasState = await canvas.evaluate((element) => {
        const worldCanvas = element as HTMLCanvasElement;
        // getContext never creates a context of a different type, so probing for
        // an existing WebGL context is side-effect free for a canvas Phaser owns.
        const graphicsContext = worldCanvas.getContext('webgl2')
          ? 'webgl2'
          : worldCanvas.getContext('webgl')
            ? 'webgl'
            : 'not-webgl';
        return {
          width: worldCanvas.width,
          height: worldCanvas.height,
          clientWidth: worldCanvas.clientWidth,
          clientHeight: worldCanvas.clientHeight,
          graphicsContext,
        };
      });

      expect(canvasState.width).toBeGreaterThan(0);
      expect(canvasState.height).toBeGreaterThan(0);
      expect(canvasState.clientWidth).toBeGreaterThan(0);
      expect(canvasState.clientHeight).toBeGreaterThan(0);

      await page.waitForLoadState('networkidle');

      const phaserChunkRequested = requests.some((observation) => observation.isPhaserVendorChunk);
      const rendererChunkMatchingPixi = requests.some(
        (observation) => observation.isRendererChunkMatchingPixi,
      );

      setRenderer({
        mode: 'phaser',
        expectedMode: entry.expectedRendererMode,
        graphicsContext: canvasState.graphicsContext,
        canvas: {
          width: canvasState.width,
          height: canvasState.height,
          clientWidth: canvasState.clientWidth,
          clientHeight: canvasState.clientHeight,
        },
        phaserChunkRequested,
      });

      // The default production renderer in Phase 1A is Phaser on every approved
      // engine, and the recorded artifact must not contain a Pixi chunk at all.
      expect(entry.expectedRendererMode).toBe('phaser');
      expect(
        phaserChunkRequested,
        'Expected the recorded production artifact to load its named Phaser vendor chunk.',
      ).toBe(true);
      expect(rendererChunkMatchingPixi).toBe(false);
      expect(artifact.distIncludesRendererChunkMatchingPixi).toBe(false);
    },
  );
});
