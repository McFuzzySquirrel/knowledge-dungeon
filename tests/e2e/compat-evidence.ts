/**
 * Phase 1A sanitized compatibility-evidence helpers.
 *
 * This module is deliberately pure: no Playwright imports, no filesystem, no
 * network, and no global state. Every function here is safe to call from a
 * failure path, so nothing it returns can carry a raw URL, hostname, port,
 * query string, fragment, request header, request body, credential, or local
 * filesystem path. Network input is reduced immediately to bounded categories
 * and counts, and every message built from it is sanitized.
 *
 * The compatibility spec imports these helpers, and the Vitest suites exercise
 * them with synthetic sentinel values so a future change cannot reintroduce
 * learner-data or private-URL leakage into failure messages or evidence files.
 */

export const COMPAT_EVIDENCE_SCHEMA_VERSION = 2;

export type HostOperatingSystemId = 'linux' | 'macos' | 'windows';
export type HostExecution = 'ci' | 'local-host';
export type DeviceEvidence = 'emulated';

/** Bounded request destinations. No URL, hostname, or path is ever returned. */
export type RequestDestination =
  | 'local-static'
  | 'local-non-static'
  | 'local-app-endpoint'
  | 'data-url'
  | 'blob-local'
  | 'blob-external'
  | 'external-legacy-static'
  | 'external-other'
  | 'non-http-protocol';

export type SanitizedMethod = 'GET' | 'HEAD' | 'OTHER';

export type NetworkViolationCategory =
  | 'non-idempotent-method'
  | 'forbidden-app-destination'
  | 'external-origin'
  | 'external-blob-origin'
  | 'non-static-local-path'
  | 'websocket-opened';

export interface SanitizedRequest {
  readonly method: SanitizedMethod;
  readonly resourceType: string;
  readonly destination: RequestDestination;
  readonly blockedByRouteGuard: boolean;
  readonly isPhaserVendorChunk: boolean;
  readonly isRendererChunkMatchingPixi: boolean;
}

export interface NetworkPolicyViolation {
  readonly category: NetworkViolationCategory;
  readonly count: number;
  readonly resourceTypes: readonly string[];
}

export interface NetworkPolicyReport {
  readonly totalRequests: number;
  readonly requestsByResourceType: Readonly<Record<string, number>>;
  readonly requestsByDestination: Readonly<Record<string, number>>;
  readonly blockedExternalCount: number;
  readonly legacyExternalStaticCount: number;
  readonly violations: readonly NetworkPolicyViolation[];
  readonly webSockets: {
    readonly total: number;
    readonly byCategory: Readonly<Record<string, number>>;
  };
}

export type WebSocketCategory = 'local' | 'external-origin' | 'blob-external' | 'non-http-protocol';

export type LaneOutcome = 'run' | 'skip-host' | 'fail-host' | 'fail-browser';

export interface LaneDecision {
  readonly outcome: LaneOutcome;
  readonly reason: string;
}

const MAX_TEXT_LENGTH = 200;
const MAX_CATEGORY_ITEMS = 6;
const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

/**
 * Known pre-Cozy remote font endpoints. The current UI still links them; Phase 8
 * removes that dependency. They are recognized only so a lane can record a
 * bounded "legacy external static" count - the hostnames themselves are never
 * written to evidence or failure messages.
 */
const LEGACY_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

const FORBIDDEN_APP_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)api(?:\/|$)/i,
  /(?:^|\/)uploads(?:\/|$)/i,
  /(?:analytics|telemetry|remote[-_]?config)/i,
];

const ALLOWED_LOCAL_STATIC_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/favicon\.ico$/,
  /^\/assets\//,
];

const PHASER_VENDOR_CHUNK_PATTERN = /^\/assets\/vendor-phaser-[^/]+\.js$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Reduces arbitrary text to a printable, bounded, path-free single line. Used for
 * toolchain output such as a browser launch failure, which can contain absolute
 * filesystem paths from the host.
 */
export function sanitizeToolchainText(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return raw
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, '<url>')
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/\/(?:[^\s"'/]+\/)*[^\s"']*/g, '<path>')
    // Long opaque tokens are redacted, but bounded kebab-case problem codes stay
    // readable because a failure message must remain actionable.
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, (token) =>
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(token) ? token : '<redacted>',
    )
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/** Maps a Node platform token onto the support-matrix host id. */
export function normalizeHost(platform: string): HostOperatingSystemId | null {
  switch (platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return null;
  }
}

/** Sanitizes a GitHub runner image label (`ImageOS` / `ImageVersion`). */
export function sanitizeRunnerImageLabel(value: string | undefined): string | null {
  if (!value) return null;
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-').slice(0, 64);
  return sanitized.length > 0 ? sanitized : null;
}

function isLocalOrigin(origin: string, localOrigin: string | null): boolean {
  if (localOrigin && origin === localOrigin) return true;
  return LOOPBACK_ORIGIN_PATTERN.test(origin);
}

function sanitizeMethod(method: string | undefined): SanitizedMethod {
  const upper = (method ?? '').toUpperCase();
  if (upper === 'GET') return 'GET';
  if (upper === 'HEAD') return 'HEAD';
  return 'OTHER';
}

function sanitizeResourceType(resourceType: string | undefined): string {
  const sanitized = (resourceType ?? 'unknown').replace(/[^a-z-]/gi, '').slice(0, 24);
  return sanitized.length > 0 ? sanitized.toLowerCase() : 'unknown';
}

/**
 * The single capture boundary. Only `url`, `method`, and `resourceType` are read;
 * headers, cookies, post data, and any other request property are ignored by
 * construction, so they cannot reach evidence or a failure message.
 */
export function classifyRequestLike(
  request: { url: () => string; method: () => string; resourceType: () => string },
  localOrigin: string | null,
): SanitizedRequest {
  const method = sanitizeMethod(request.method());
  const resourceType = sanitizeResourceType(request.resourceType());
  const base: SanitizedRequest = {
    method,
    resourceType,
    destination: 'non-http-protocol',
    blockedByRouteGuard: false,
    isPhaserVendorChunk: false,
    isRendererChunkMatchingPixi: false,
  };

  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return base;
  }

  if (url.protocol === 'data:') return { ...base, destination: 'data-url' };

  if (url.protocol === 'blob:') {
    let blobOrigin: string | null = null;
    try {
      blobOrigin = new URL(url.pathname).origin;
    } catch {
      blobOrigin = null;
    }
    return { ...base, destination: blobOrigin && isLocalOrigin(blobOrigin, localOrigin) ? 'blob-local' : 'blob-external' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return base;

  if (!isLocalOrigin(url.origin, localOrigin)) {
    return {
      ...base,
      destination: LEGACY_FONT_HOSTS.has(url.hostname) ? 'external-legacy-static' : 'external-other',
      blockedByRouteGuard: true,
    };
  }

  if (FORBIDDEN_APP_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return { ...base, destination: 'local-app-endpoint' };
  }
  if (!ALLOWED_LOCAL_STATIC_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return { ...base, destination: 'local-non-static' };
  }
  return {
    ...base,
    destination: 'local-static',
    isPhaserVendorChunk: PHASER_VENDOR_CHUNK_PATTERN.test(url.pathname),
    isRendererChunkMatchingPixi: /pixi/i.test(url.pathname),
  };
}

export function classifyWebSocketLike(rawUrl: string, localOrigin: string | null): WebSocketCategory {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'non-http-protocol';
  }
  if (url.protocol === 'blob:') return 'blob-external';
  const socketProtocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : null;
  if (!socketProtocol) return 'non-http-protocol';
  const origin = `${socketProtocol}//${url.host}`;
  return isLocalOrigin(origin, localOrigin) ? 'local' : 'external-origin';
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * A single request can break more than one rule at once, for example a POST to an
 * external origin. Every applicable bounded category is reported.
 */
function violationsFor(request: SanitizedRequest): readonly NetworkViolationCategory[] {
  const categories: NetworkViolationCategory[] = [];
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    categories.push('non-idempotent-method');
  }
  switch (request.destination) {
    case 'local-app-endpoint':
      categories.push('forbidden-app-destination');
      break;
    case 'external-other':
      categories.push('external-origin');
      break;
    case 'blob-external':
      categories.push('external-blob-origin');
      break;
    case 'local-non-static':
      categories.push('non-static-local-path');
      break;
    default:
      break;
  }
  return categories;
}

/**
 * Aggregates sanitized requests into bounded categories and counts. The result is
 * safe to serialize into evidence or to embed in a failure message.
 */
export function buildNetworkPolicyReport(
  requests: readonly SanitizedRequest[],
  webSocketCategories: readonly WebSocketCategory[] = [],
): NetworkPolicyReport {
  const counts = new Map<NetworkViolationCategory, { count: number; resourceTypes: Set<string> }>();
  const add = (category: NetworkViolationCategory, resourceType: string) => {
    const existing = counts.get(category) ?? { count: 0, resourceTypes: new Set<string>() };
    existing.count += 1;
    existing.resourceTypes.add(resourceType);
    counts.set(category, existing);
  };

  for (const request of requests) {
    for (const category of violationsFor(request)) add(category, request.resourceType);
  }
  for (const _category of webSocketCategories) {
    void _category;
    add('websocket-opened', 'websocket');
  }

  const violations: NetworkPolicyViolation[] = [...counts.entries()]
    .map(([category, value]) => ({
      category,
      count: value.count,
      resourceTypes: [...value.resourceTypes].sort().slice(0, MAX_CATEGORY_ITEMS),
    }))
    .sort((left, right) => (left.category < right.category ? -1 : 1));

  return {
    totalRequests: requests.length,
    requestsByResourceType: countBy(requests.map((request) => request.resourceType)),
    requestsByDestination: countBy(requests.map((request) => request.destination)),
    blockedExternalCount: requests.filter((request) => request.blockedByRouteGuard).length,
    legacyExternalStaticCount: requests.filter(
      (request) => request.destination === 'external-legacy-static',
    ).length,
    violations,
    webSockets: {
      total: webSocketCategories.length,
      byCategory: countBy(webSocketCategories),
    },
  };
}

/** Bounded, sentinel-free failure text built only from categories and counts. */
export function describeNetworkFailures(report: NetworkPolicyReport): string {
  if (report.violations.length === 0) return 'no static-only network policy violations';
  return `static-only network policy violations: ${report.violations
    .map((violation) => `${violation.category} x${violation.count} (resource types: ${violation.resourceTypes.join(', ')})`)
    .join('; ')}`;
}

/**
 * Lane policy. A lane never emits passing evidence on a host it is not approved
 * for, and an unavailable browser build is a failure on an approved host rather
 * than a silently skipped test.
 */
export function decideLaneOutcome(input: {
  readonly hostApproved: boolean;
  readonly isCi: boolean;
  readonly browserAvailable: boolean;
  readonly project: string;
  readonly approvedHosts: readonly string[];
  readonly actualHost: string;
  readonly engine: string;
  readonly channelOption?: string;
  readonly installTargets: readonly string[];
  readonly browserFailureText?: string;
}): LaneDecision {
  if (!input.hostApproved) {
    const reason =
      `host "${input.actualHost}" is not approved for this lane ` +
      `(approved: ${input.approvedHosts.join(', ')}); no evidence is recorded for ${input.project}.`;
    return { outcome: input.isCi ? 'fail-host' : 'skip-host', reason };
  }
  if (!input.browserAvailable) {
    const engineLabel = input.channelOption ? `${input.engine} (${input.channelOption} channel)` : input.engine;
    const detail = input.browserFailureText ? ` ${sanitizeToolchainText(input.browserFailureText)}` : '';
    const reason =
      `${engineLabel} is unavailable on this approved host.${detail} ` +
      `Install it with "npx playwright install ${input.installTargets.join(' ')}".`;
    return { outcome: 'fail-browser', reason };
  }
  return { outcome: 'run', reason: `${input.project} selected on approved host "${input.actualHost}".` };
}

/** Sanitizes a run identifier: alphanumerics and dashes only, at most 40 chars. */
export function sanitizeRunId(value: string): string {
  const sanitized = value.replace(/[^0-9A-Za-z-]/g, '').replace(/-{2,}/g, '-').slice(0, 40);
  return sanitized.length > 0 ? sanitized : 'run-unknown';
}

/**
 * Builds a local run identifier that two invocations cannot share: UTC date,
 * seconds, and milliseconds plus a short per-process discriminator. The result is
 * sanitized and stays well under the 40-character limit, so evidence from a
 * rerun lands in its own directory instead of overwriting an earlier one.
 */
export function buildLocalRunId(date: Date, processId: number): string {
  const stamp = date.toISOString().replace(/[^0-9A-Za-z]/g, ''); // YYYYMMDDTHHMMSSmmm
  return sanitizeRunId(`local-${stamp}-${Math.abs(Math.trunc(processId)).toString(36)}`);
}

/** Sanitizes a test title into a stable file-name segment. */
export function sanitizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'test';
}

/** Relative evidence path under the allowlisted compatibility evidence root. */
export function evidenceRelativePath(input: {
  readonly runId: string;
  readonly project: string;
  readonly testTitle: string;
}): string {
  return [
    'artifacts',
    'compatibility-evidence',
    sanitizeRunId(input.runId),
    `${sanitizeSlug(input.project)}--${sanitizeSlug(input.testTitle)}.json`,
  ].join('/');
}
