import { describe, expect, it } from 'vitest';
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
  sanitizeSlug,
  sanitizeToolchainText,
  type SanitizedRequest,
} from './compat-evidence';

/**
 * Phase 1A failure-path privacy and lane-policy checks.
 *
 * Synthetic sentinel values stand in for anything a failure could otherwise
 * capture: a query string, a fragment, a request header, a request body, a
 * credential, and a private external URL. No helper output, aggregate, or message
 * may contain a sentinel, and the lane policy must never let a lane pass on an
 * unapproved host or on a missing browser build.
 */

const LOCAL_ORIGIN = 'http://127.0.0.1:43173';
const QUERY_SENTINEL = 'QUERY-SENTINEL-9f2a';
const FRAGMENT_SENTINEL = 'FRAGMENT-SENTINEL-7c1b';
const HEADER_SENTINEL = 'HEADER-SENTINEL-4d3e';
const BODY_SENTINEL = 'BODY-SENTINEL-1a5c';
const CREDENTIAL_SENTINEL = 'CREDENTIAL-SENTINEL-8b6d';
const PRIVATE_HOST_SENTINEL = 'private-learner-host.invalid';
const SENTINELS = [
  QUERY_SENTINEL,
  FRAGMENT_SENTINEL,
  HEADER_SENTINEL,
  BODY_SENTINEL,
  CREDENTIAL_SENTINEL,
  PRIVATE_HOST_SENTINEL,
];

function requestLike(overrides: {
  url: string;
  method?: string;
  resourceType?: string;
  headers?: Record<string, string>;
  postData?: string;
}): Parameters<typeof classifyRequestLike>[0] {
  return {
    url: () => overrides.url,
    method: () => overrides.method ?? 'GET',
    resourceType: () => overrides.resourceType ?? 'xhr',
    headers: () => overrides.headers ?? {},
    postData: () => overrides.postData ?? null,
  } as unknown as Parameters<typeof classifyRequestLike>[0];
}

function expectNoSentinel(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    expect(serialized, `sentinel leaked: ${sentinel}`).not.toContain(sentinel);
  }
}

describe('failure-path privacy: request capture boundary', () => {
  it('reduces a local static request to categories and never echoes the URL', () => {
    const observation = classifyRequestLike(
      requestLike({
        url: `${LOCAL_ORIGIN}/assets/vendor-phaser-abc123.js?${QUERY_SENTINEL}#${FRAGMENT_SENTINEL}`,
        resourceType: 'script',
      }),
      LOCAL_ORIGIN,
    );

    expect(observation).toEqual({
      method: 'GET',
      resourceType: 'script',
      destination: 'local-static',
      blockedByRouteGuard: false,
      isPhaserVendorChunk: true,
      isRendererChunkMatchingPixi: false,
    });
    expectNoSentinel(observation);
  });

  it('ignores headers, bodies, and credentials on a request', () => {
    const observation = classifyRequestLike(
      requestLike({
        url: `${LOCAL_ORIGIN}/api/upload?subject=${QUERY_SENTINEL}`,
        method: 'POST',
        headers: { authorization: `Bearer ${CREDENTIAL_SENTINEL}`, cookie: `sid=${HEADER_SENTINEL}` },
        postData: `${BODY_SENTINEL}`,
      }),
      LOCAL_ORIGIN,
    );

    expect(observation.method).toBe('OTHER');
    expect(observation.destination).toBe('local-app-endpoint');
    expect(observation.blockedByRouteGuard).toBe(false);
    expectNoSentinel(observation);
  });

  it('classifies a private external URL without recording its host, port, or path', () => {
    const observation = classifyRequestLike(
      requestLike({
        url: `https://${PRIVATE_HOST_SENTINEL}:8443/learner/notes/${BODY_SENTINEL}?token=${CREDENTIAL_SENTINEL}#${FRAGMENT_SENTINEL}`,
        resourceType: 'xhr',
      }),
      LOCAL_ORIGIN,
    );

    expect(observation.destination).toBe('external-other');
    expect(observation.blockedByRouteGuard).toBe(true);
    expect(Object.keys(observation).sort()).toEqual([
      'blockedByRouteGuard',
      'destination',
      'isPhaserVendorChunk',
      'isRendererChunkMatchingPixi',
      'method',
      'resourceType',
    ]);
    expectNoSentinel(observation);
  });

  it('counts the known legacy font host as a bounded category without naming it', () => {
    const observation = classifyRequestLike(
      requestLike({
        url: 'https://fonts.googleapis.com/css2?family=Inter&family=SENTINEL',
        resourceType: 'stylesheet',
      }),
      LOCAL_ORIGIN,
    );

    expect(observation.destination).toBe('external-legacy-static');
    expectNoSentinel(observation);
    expect(observation).not.toHaveProperty('url');
  });

  it('classifies non-loopback and blob requests without exposing origins', () => {
    const externalBlob = classifyRequestLike(
      requestLike({ url: `blob:https://${PRIVATE_HOST_SENTINEL}/uuid`, resourceType: 'other' }),
      LOCAL_ORIGIN,
    );
    expect(externalBlob.destination).toBe('blob-external');

    const localBlob = classifyRequestLike(
      requestLike({ url: `blob:${LOCAL_ORIGIN}/uuid`, resourceType: 'other' }),
      LOCAL_ORIGIN,
    );
    expect(localBlob.destination).toBe('blob-local');

    const nonHttp = classifyRequestLike(
      requestLike({ url: 'chrome-extension://abcdef/inject.js', resourceType: 'script' }),
      LOCAL_ORIGIN,
    );
    expect(nonHttp.destination).toBe('non-http-protocol');

    const unparsable = classifyRequestLike(requestLike({ url: 'not a url' }), LOCAL_ORIGIN);
    expect(unparsable.destination).toBe('non-http-protocol');

    for (const observation of [externalBlob, localBlob, nonHttp, unparsable]) {
      expectNoSentinel(observation);
    }
  });

  it('sanitizes toolchain text so host paths and newlines cannot escape', () => {
    const sanitized = sanitizeToolchainText(
      `browserType.launch: cannot find /home/learner/private/path/msedge\r\nsecond line ${CREDENTIAL_SENTINEL}`,
    );
    expect(sanitized).toContain('<path>');
    expect(sanitized).not.toContain('/home/learner');
    expect(sanitized).not.toContain('\n');
    expect(sanitized).not.toContain(CREDENTIAL_SENTINEL);
    expect(sanitized.length).toBeLessThanOrEqual(200);
  });

  it('keeps bounded problem codes readable while redacting opaque tokens', () => {
    const sanitized = sanitizeToolchainText(
      'Error: the web build is not the recorded production artifact ' +
        '(dist-does-not-match-recorded-artifact: mismatch) hash ' +
        'd73bc03b73951ac1a4db0a4a50f6b2c6592de2928135683b1ffb4016ee03d1cc',
    );
    expect(sanitized).toContain('dist-does-not-match-recorded-artifact');
    expect(sanitized).toContain('<redacted>');
    expect(sanitized).not.toContain('d73bc03b73951ac1a4db0a4a50f6b2c6592de2928135683b1ffb4016ee03d1cc');
  });
});

describe('failure-path privacy: aggregated network report', () => {
  const failingObservations: SanitizedRequest[] = [
    classifyRequestLike(
      requestLike({
        url: `https://${PRIVATE_HOST_SENTINEL}/collect?subject=${QUERY_SENTINEL}`,
        method: 'POST',
        headers: { 'x-api-key': CREDENTIAL_SENTINEL },
        postData: BODY_SENTINEL,
        resourceType: 'xhr',
      }),
      LOCAL_ORIGIN,
    ),
    classifyRequestLike(
      requestLike({
        url: `${LOCAL_ORIGIN}/api/upload#${FRAGMENT_SENTINEL}`,
        method: 'POST',
        resourceType: 'fetch',
      }),
      LOCAL_ORIGIN,
    ),
    classifyRequestLike(
      requestLike({ url: 'wss://private-stream.invalid/socket', resourceType: 'other' }),
      LOCAL_ORIGIN,
    ),
    classifyRequestLike(
      requestLike({ url: `${LOCAL_ORIGIN}/learner/state?${QUERY_SENTINEL}`, resourceType: 'document' }),
      LOCAL_ORIGIN,
    ),
    classifyRequestLike(
      requestLike({ url: `${LOCAL_ORIGIN}/assets/app.js`, resourceType: 'script' }),
      LOCAL_ORIGIN,
    ),
  ];

  it('produces bounded categories and counts', () => {
    const report = buildNetworkPolicyReport(failingObservations, [
      classifyWebSocketLike('wss://private-stream.invalid/socket', LOCAL_ORIGIN),
    ]);

    expect(report.totalRequests).toBe(failingObservations.length);
    expect(report.blockedExternalCount).toBe(1);
    expect(report.webSockets).toEqual({ total: 1, byCategory: { 'external-origin': 1 } });
    expect(report.violations.map((violation) => violation.category).sort()).toEqual([
      'external-origin',
      'forbidden-app-destination',
      'non-idempotent-method',
      'non-static-local-path',
      'websocket-opened',
    ]);
    for (const violation of report.violations) {
      expect(violation.count).toBeGreaterThan(0);
      expect(violation.resourceTypes.length).toBeGreaterThan(0);
    }
    expect(report.legacyExternalStaticCount).toBe(0);
  });

  it('keeps sentinels out of the report and out of the failure message', () => {
    const report = buildNetworkPolicyReport(failingObservations, [
      classifyWebSocketLike('wss://private-stream.invalid/socket', LOCAL_ORIGIN),
    ]);
    const description = describeNetworkFailures(report);

    expectNoSentinel(report);
    expectNoSentinel(description);
    expect(description).toContain('external-origin x1');
    expect(description).toContain('websocket-opened x1');
    expect(description).not.toContain('/collect');
    expect(description).not.toContain('127.0.0.1');
    expect(description).not.toContain('wss://');
  });

  it('reports a clean lane without inventing violations', () => {
    const clean = [
      classifyRequestLike(
        requestLike({ url: `${LOCAL_ORIGIN}/`, resourceType: 'document' }),
        LOCAL_ORIGIN,
      ),
      classifyRequestLike(
        requestLike({ url: `${LOCAL_ORIGIN}/assets/app.js`, resourceType: 'script' }),
        LOCAL_ORIGIN,
      ),
    ];
    const report = buildNetworkPolicyReport(clean, []);
    expect(report.violations).toEqual([]);
    expect(describeNetworkFailures(report)).toBe('no static-only network policy violations');
  });

  it('exposes a versioned evidence schema and sanitized run identity', () => {
    expect(COMPAT_EVIDENCE_SCHEMA_VERSION).toBe(2);
    const runId = sanitizeRunId('local-2026-09-25T16:00:00.000Z');
    expect(runId).toMatch(/^[0-9A-Za-z-]+$/);
    expect(runId.startsWith('local-')).toBe(true);
    expect(runId.length).toBeLessThanOrEqual(40);
    expect(sanitizeRunId('///')).toBe('run-unknown');
    expect(sanitizeRunId('a'.repeat(80)).length).toBe(40);

    // Test titles are repo-controlled, so a slug only has to neutralize
    // structural characters: separators, quotes, and traversal segments.
    expect(sanitizeSlug('Records "quoted" / slash\\here')).toBe('records-quoted-slash-here');
    expect(sanitizeSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeSlug('')).toBe('test');
    expect(sanitizeRunnerImageLabel('ubuntu24 / 20250921.1.0')).toBe('ubuntu24-20250921.1.0');
    expect(sanitizeRunnerImageLabel(undefined)).toBeNull();

    const relativePath = evidenceRelativePath({
      runId: 'local-20260925T160000',
      project: 'compat-webkit',
      testTitle: 'Records "quoted" / slash\\here',
    });
    expect(relativePath).toBe(
      'artifacts/compatibility-evidence/local-20260925T160000/compat-webkit--records-quoted-slash-here.json',
    );
    expect(relativePath.startsWith('artifacts/compatibility-evidence/')).toBe(true);
    for (const segment of relativePath.split('/')) {
      expect(segment).not.toBe('');
      expect(segment).not.toBe('.');
      expect(segment).not.toBe('..');
    }
  });
});

describe('run identifiers', () => {
  const at = (iso: string) => new Date(iso);

  it('stays sanitized and within the 40-character limit', () => {
    const runId = buildLocalRunId(at('2026-09-25T14:16:30.123Z'), 4242);
    expect(runId).toBe('local-20260925T141630123Z-39u');
    expect(runId).toMatch(/^local-[0-9]{8}T[0-9]{9}Z-[0-9a-z]+$/);
    expect(runId.length).toBeLessThanOrEqual(40);
    expect(sanitizeRunId(runId)).toBe(runId);
  });

  it('cannot collide for two invocations inside the same minute', () => {
    const minute = '2026-09-25T14:16';
    const first = buildLocalRunId(at(`${minute}:00.001Z`), 1001);
    const sameSecond = buildLocalRunId(at(`${minute}:00.001Z`), 1002);
    const sameMinuteNextSecond = buildLocalRunId(at(`${minute}:59.999Z`), 1001);
    const sameMinuteNextMinute = buildLocalRunId(at('2026-09-25T14:17:00.001Z'), 1001);

    expect(new Set([first, sameSecond, sameMinuteNextSecond, sameMinuteNextMinute]).size).toBe(4);
  });

  it('does not leak a filesystem path or a user name', () => {
    const runId = buildLocalRunId(at('2026-09-25T14:16:30.123Z'), 1001);
    expectNoSentinel(runId);
    expect(runId).not.toContain('/');
    expect(runId).not.toContain('\\');
  });
});

describe('lane policy', () => {
  const base = {
    project: 'compat-chromium',
    approvedHosts: ['linux', 'macos', 'windows'] as const,
    actualHost: 'linux',
    engine: 'chromium',
    installTargets: ['chromium'] as const,
  };

  it('runs on an approved host with an available browser', () => {
    expect(
      decideLaneOutcome({ ...base, hostApproved: true, isCi: false, browserAvailable: true }),
    ).toEqual({ outcome: 'run', reason: expect.stringContaining('compat-chromium selected') });
  });

  it('never emits passing evidence on a host it is not approved for', () => {
    const local = decideLaneOutcome({
      ...base,
      hostApproved: false,
      isCi: false,
      browserAvailable: false,
    });
    expect(local.outcome).toBe('skip-host');
    expect(local.reason).toContain('not approved');

    const remote = decideLaneOutcome({
      ...base,
      hostApproved: false,
      isCi: true,
      browserAvailable: false,
    });
    expect(remote.outcome).toBe('fail-host');
  });

  it('fails instead of skipping when the browser is unavailable on an approved host', () => {
    for (const isCi of [false, true]) {
      const decision = decideLaneOutcome({
        ...base,
        hostApproved: true,
        isCi,
        browserAvailable: false,
        browserFailureText: `missing /opt/host/private/browser ${CREDENTIAL_SENTINEL}`,
      });
      expect(decision.outcome).toBe('fail-browser');
      expect(decision.reason).toContain('npx playwright install chromium');
      expect(decision.reason).toContain('<path>');
      expectNoSentinel(decision);
    }
  });

  it('normalizes every Node platform token used by the CI lanes', () => {
    expect(normalizeHost('linux')).toBe('linux');
    expect(normalizeHost('darwin')).toBe('macos');
    expect(normalizeHost('win32')).toBe('windows');
    expect(normalizeHost('aix')).toBeNull();
  });
});
