/**
 * Phase 22 service-worker-enabled compatibility proof (Chromium).
 *
 * One test, against the offline-shell-flagged artifact, with service workers
 * *enabled* rather than blocked. It answers the second half of the plan's Phase 22
 * scope - "Add service-worker-enabled compatibility projects without globally
 * relaxing the privacy network policy" - and nothing else:
 *
 *   1. the recorded offline-shell artifact is the one on disk, verified against its
 *      own recorded identity before anything is measured;
 *   2. the shell loads and stays interactive with the worker enabled;
 *   3. the worker registers and controls the page, and owns a shell-only cache;
 *   4. every request the journey makes is classified by the Phase 1A network policy
 *      and none is a violation: no off-origin request, no analytics, telemetry, or
 *      remote-config destination, no `/api/` or `/uploads/` upload path, no
 *      non-idempotent method, no external blob, and no non-static local path;
 *   5. the sanitized evidence is written under the allowlisted
 *      `artifacts/compatibility-evidence/` root.
 *
 * The classification is the existing `compat-evidence.ts` one, unchanged and
 * unweakened. The Phase 1 spy in `currentBuild.spec.ts` is untouched. This spec
 * only ever *reads* those; it does not relax them.
 *
 * Privacy: no learner value is created, read, or recorded. The only subject this
 * file names is none - it never leaves the Welcome shell - and every value written
 * to evidence is a count, a category, a cache name, a build asset path, a boolean,
 * or a browser/host label.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type Request, type TestInfo } from '@playwright/test';

import {
  buildLocalRunId,
  buildNetworkPolicyReport,
  classifyRequestLike,
  decideLaneOutcome,
  describeNetworkFailures,
  evidenceRelativePath,
  normalizeHost,
  sanitizeRunId,
  sanitizeRunnerImageLabel,
  sanitizeToolchainText,
  type SanitizedRequest,
} from './compat-evidence';
import {
  OFFLINE_SHELL_CACHE_PREFIX,
  OFFLINE_SHELL_MANIFEST_FILENAME,
} from './offline-lane';
import { SW_SHELL_LANE, SW_SHELL_MANIFEST_PATH } from './sw-shell-lane';

const REPO_ROOT = process.cwd();
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');

const IS_CI = Boolean(process.env.CI);
const RUN_ID = sanitizeRunId(
  process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid),
);
const RUNNER_IMAGE = {
  os: sanitizeRunnerImageLabel(process.env.ImageOS),
  version: sanitizeRunnerImageLabel(process.env.ImageVersion),
};

interface ManifestVerification {
  readonly status: string;
  readonly code: string;
  readonly message: string;
  readonly identity?: { readonly treeSha256?: string; readonly fileCount?: number } | null;
}

interface ShellManifest {
  readonly version: string;
  readonly document: string;
  readonly assets: readonly string[];
}

/** The installed shell manifest, parsed from `dist/` on the Node side. */
function readBuiltShellManifest(): ShellManifest {
  const manifestPath = path.join(REPO_ROOT, 'dist', OFFLINE_SHELL_MANIFEST_FILENAME);
  const source = readFileSync(manifestPath, 'utf8');
  const match = /Object\.freeze\(([\s\S]*)\);\s*$/.exec(source);
  if (match === null) {
    throw new Error(`Could not parse ${OFFLINE_SHELL_MANIFEST_FILENAME}.`);
  }
  return JSON.parse(match[1]) as ShellManifest;
}

/**
 * Verifies that the `dist` on disk is byte-identical to the recorded offline-shell
 * artifact. Hashing lives in the shared manifest script, so this lane, the offline
 * lane, and CI all use one implementation and a mismatch is a hard failure rather
 * than a skipped measurement.
 */
function verifyRecordedArtifact(): ManifestVerification {
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [MANIFEST_SCRIPT, 'verify', `--manifest=${SW_SHELL_MANIFEST_PATH}`, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch (error) {
    const failure = error as { stdout?: string };
    stdout = failure.stdout ?? '';
    if (stdout.trim().length === 0) {
      throw new Error(
        `The offline-shell artifact verification produced no structured result (${sanitizeToolchainText(error)}).`,
      );
    }
  }
  return JSON.parse(stdout) as ManifestVerification;
}

function observeSanitized(request: Request, localOrigin: string): SanitizedRequest {
  return classifyRequestLike(
    {
      url: () => request.url(),
      method: () => request.method(),
      resourceType: () => request.resourceType(),
    },
    localOrigin,
  );
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

test.beforeAll(() => {
  const actualHost = normalizeHost(os.platform());
  const hostApproved =
    actualHost !== null && (SW_SHELL_LANE.hostOperatingSystems as readonly string[]).includes(actualHost);

  // A lane never emits passing evidence on a host it is not approved for. The same
  // shared decision the compatibility suite uses: a locally inapplicable lane is
  // skipped as "not selected" evidence, and the same mismatch fails on a runner.
  if (!hostApproved) {
    const decision = decideLaneOutcome({
      hostApproved,
      isCi: IS_CI,
      browserAvailable: false,
      project: SW_SHELL_LANE.project,
      approvedHosts: SW_SHELL_LANE.hostOperatingSystems,
      actualHost: actualHost ?? os.platform(),
      engine: SW_SHELL_LANE.engine,
      installTargets: SW_SHELL_LANE.installTargets,
    });
    console.log(`[sw-shell-lane] ${SW_SHELL_LANE.project} not selected: ${decision.reason}`);
    if (decision.outcome === 'fail-host') {
      throw new Error(`SW-shell compatibility lane ${SW_SHELL_LANE.project} ran on an unapproved host. ${decision.reason}`);
    }
    test.skip(true, decision.reason);
    return;
  }

  console.log(
    `[sw-shell-lane] ${SW_SHELL_LANE.project} selected on ${os.platform()}/${os.arch()} ` +
      `node ${process.version} runner ${RUNNER_IMAGE.os ?? 'unavailable'}/${RUNNER_IMAGE.version ?? 'unavailable'}`,
  );
});

test.beforeEach(async ({ page }) => {
  // Backstop, exactly as the compatibility suite does: no external request can
  // leave the test browser, and the sanitized report still records what the
  // application attempted. The service worker never serves these - its fetch
  // handler returns early for a cross-origin request - so a regression is still
  // observable rather than being masked by the cache.
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
});

test('the shell stays a same-origin static client with the service worker enabled', async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Playwright baseURL is required for the sw-shell lane.');
  const localOrigin = new URL(baseURL).origin;

  // ── 0. The recorded identity, before anything is measured ────────────────────
  const verification = verifyRecordedArtifact();
  expect(
    verification.status,
    `The offline-shell build is not the recorded artifact (${verification.code}: ${verification.message}). ` +
      'This lane must run the recorded artifact instead of rebuilding a different one.',
  ).toBe('match');
  const builtManifest = readBuiltShellManifest();
  const shellAssetCount = builtManifest.assets.length;
  expect(shellAssetCount, 'the shell manifest named no assets').toBeGreaterThan(0);

  // ── The request stream, classified by the Phase 1A network policy ────────────
  const requests: SanitizedRequest[] = [];
  const observedPaths: string[] = [];
  page.on('request', (request) => {
    requests.push(observeSanitized(request, localOrigin));
    try {
      const url = new URL(request.url());
      // Only http(s) paths are tracked for the static-path check: a `data:` or
      // `blob:` URL has no network destination, and the classifier already reports
      // it as its own category rather than as a local path.
      if (url.protocol === 'http:' || url.protocol === 'https:') observedPaths.push(url.pathname);
    } catch {
      // A request URL Playwright cannot parse is reported by classification as a
      // non-http-protocol destination; no path is recorded for it.
    }
  });

  // ── 1. The shell loads and stays interactive ─────────────────────────────────
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  const startTutorial = page.getByRole('button', { name: 'Start Tutorial' });
  await expect(startTutorial).toBeVisible();
  await expect(startTutorial).toBeEnabled();

  // ── 2. The worker registers and controls the page ────────────────────────────
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 30_000,
  });
  const workerControlled = await page.evaluate(() => navigator.serviceWorker.controller != null);
  expect(workerControlled, 'the service worker did not take control of the page').toBe(true);

  await page.waitForLoadState('networkidle');

  const cacheNames = (await page.evaluate(() => caches.keys())).sort();
  const shellCaches = cacheNames.filter((name) => name.startsWith(OFFLINE_SHELL_CACHE_PREFIX));
  expect(shellCaches, 'expected exactly one versioned shell cache').toHaveLength(1);

  // ── 3. No network-policy violation was introduced by enabling the worker ─────
  const report = buildNetworkPolicyReport(requests, []);
  expect(report.totalRequests, 'the lane observed no requests at all').toBeGreaterThan(0);
  expect(report.violations, describeNetworkFailures(report)).toEqual([]);
  expect(report.blockedExternalCount, 'an off-origin request was attempted').toBe(0);
  expect(report.legacyExternalStaticCount, 'a remote font request was attempted').toBe(0);
  expect(report.requestsByDestination['external-other'] ?? 0, 'an off-origin destination appeared').toBe(0);
  expect(report.requestsByDestination['external-blob-origin'] ?? 0, 'an external blob appeared').toBe(0);
  expect(report.requestsByDestination['local-app-endpoint'] ?? 0, 'a forbidden app endpoint was reached').toBe(0);
  expect(report.requestsByDestination['local-non-static'] ?? 0, 'a non-static local request appeared').toBe(0);
  expect(report.webSockets.total).toBe(0);

  // Every same-origin path the journey touched is the document, the favicon, or a
  // build asset under `/assets/`. This is the concrete form of "no non-static
  // request": the application may lazily fetch additional same-origin asset chunks
  // (they are static and the privacy policy permits them), but it may not reach a
  // document, an API route, an upload path, or any other non-asset path.
  const unexpectedPaths = observedPaths.filter((pathname) => {
    if (pathname === '/' || pathname === '/favicon.ico') return false;
    return !pathname.startsWith('/assets/');
  });
  expect(
    unexpectedPaths,
    `non-static same-origin paths the journey reached: ${unexpectedPaths.join(', ')}`,
  ).toEqual([]);

  // The shell manifest is the *cache* allowlist, and it is evidence about the
  // artifact rather than the request allowlist. It is recorded for the report.
  void shellAssetCount;

  // ── 4. Sanitized evidence under the allowlisted root ─────────────────────────
  const evidence = {
    schemaVersion: 1,
    phase: '22',
    suite: 'service-worker-compatibility',
    runId: RUN_ID,
    hostExecution: IS_CI ? 'ci' : 'local-host',
    project: SW_SHELL_LANE.project,
    testTitle: testInfo.title,
    host: {
      platform: os.platform(),
      arch: os.arch(),
      runnerImage: RUNNER_IMAGE,
      ci: IS_CI,
      approvedHosts: SW_SHELL_LANE.hostOperatingSystems,
    },
    serviceWorker: { controlled: workerControlled, shellCaches },
    artifact: {
      verificationStatus: verification.status,
      verificationCode: verification.code,
      treeSha256: verification.identity?.treeSha256 ?? null,
      fileCount: verification.identity?.fileCount ?? 0,
      shellManifestVersion: builtManifest.version,
      shellAssetCount: builtManifest.assets.length,
    },
    network: {
      totalRequests: report.totalRequests,
      requestsByResourceType: report.requestsByResourceType,
      requestsByDestination: report.requestsByDestination,
      blockedExternalCount: report.blockedExternalCount,
      legacyExternalStaticCount: report.legacyExternalStaticCount,
      violationCount: report.violations.length,
      webSockets: report.webSockets.total,
    },
  };

  const relativePath = evidenceRelativePath({
    runId: RUN_ID,
    project: SW_SHELL_LANE.project,
    testTitle: testInfo.title,
  });
  const absolutePath = path.join(REPO_ROOT, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[sw-shell-evidence] ${relativePath}`);
  console.log(`[sw-shell] ${JSON.stringify(evidence.network)}`);
  await attachJson(testInfo, 'sw-shell-evidence.json', evidence);
});
