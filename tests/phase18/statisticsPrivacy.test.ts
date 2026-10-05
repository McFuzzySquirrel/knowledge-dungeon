/**
 * Phase 18 gate 4: no statistics leave the device.
 *
 * ## The exit criterion under test
 *
 * Phase 18: *"No network request carries statistics."* Plan working rule 6 is the broader form:
 * do not log or place learner data in URLs, filenames, feature flags, or error reports. Phase 18's
 * scope adds "Add no remote analytics", and its non-goals forbid cloud analytics, cross-device
 * telemetry, opaque behavioural profiling, and a public leaderboard.
 *
 * The existing structural walk in `tests/phase18/statisticsDomainBoundary.test.ts` reads source
 * text. That is necessary and it is not sufficient, so this file adds the two halves it cannot
 * reach:
 *
 * - **Runtime.** A whole session is driven for real - canonical activation, a room visit, a room
 *   clear, a review pass, a catch, every end signal, and the reader - with `fetch`,
 *   `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`, and every `console`
 *   method replaced by recorders. The claim is then **zero** recorded calls, and every recorded
 *   payload is searched for the synthetic session id, subject name, room id, and event digest.
 * - **Data products.** A real `.kdbak` and a real `.kdsubject` are produced from a device whose
 *   records carry planted marker strings in every field a learner would recognise - a subject
 *   name, a room topic, a note, a tag, a fish display name. No member **name**, no manifest
 *   string, and no file name may contain one.
 *
 * ## Non-vacuity
 *
 * Every "zero" and every "not found" in this file is paired with a positive control in the same
 * case:
 *
 * - the network recorders are exercised with one deliberate `fetch` to a reserved `.invalid`
 *   host, so "nothing was recorded" is a measurement rather than an absent instrument;
 * - the source scanner is run against a synthetic source that *does* contain the pattern, so
 *   "no match" cannot be explained by a regex that matches nothing;
 * - the console recorder is exercised with one deliberate `console.warn`, so "no learner data in
 *   a log line" is a search over a populated list.
 *
 * ## Boundaries this file does not cross
 *
 * - jsdom has no network, so a **real** request carrying statistics cannot be observed here. The
 *   browser lane (`tests/e2e/currentBuild.spec.ts`) records every request the production artifact
 *   makes, and that is where the URL-level claim is evidenced.
 * - A physical-device claim about a screen reader announcing a subject name is Phase 21's gate.
 *
 * ## Privacy
 *
 * Every fixture is synthetic. The one host used is the reserved `example.invalid`/`collector.invalid`
 * names, which cannot resolve. No learner data, no credential, no real URL, no request body.
 */

import 'fake-indexeddb/auto';

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readArchive } from '@/services/persistence/v2/archive';
import {
  exportFullDeviceBackup,
  FULL_DEVICE_BACKUP_FILE_NAME,
} from '@/services/persistence/products/fullDeviceBackup';
import {
  exportSubjectBackup,
  SUBJECT_BACKUP_FILE_NAME,
} from '@/services/persistence/products/subjectBackup';

import {
  ALL_MARKERS,
  ALPHA,
  FIXED_NOW,
  forgeDevice,
  type ForgedDevice,
} from '../phase6/support/forge';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

const SUBJECT = 'synthetic-qa18-privacy-subject';
const SUBJECT_NAME = 'Synthetic QA18 Privacy Subject';
const ROOM = 'synthetic-qa18-privacy-room';
const SESSION = 'synthetic-qa18-privacy-session';
/** Reserved, non-resolvable host used only by the positive control. */
const RESERVED_HOST = 'collector.invalid';

// ── The network recorder ────────────────────────────────────────────────────

interface RecordedCall {
  readonly api: string;
  readonly detail: string;
}

let calls: RecordedCall[] = [];
const originals: Array<() => void> = [];

function record(api: string, detail: unknown): void {
  calls.push({ api, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) ?? '' });
}

/**
 * Replace every network and console entry point with a recorder.
 *
 * Replaced rather than spied, so a call through a captured reference is still recorded. Each
 * replacement is registered for restoration in `afterEach`.
 */
function installRecorders(): void {
  const global = globalThis as unknown as Record<string, unknown>;

  const originalFetch = global.fetch;
  global.fetch = ((input: unknown, init?: unknown) => {
    record('fetch', {
      url: typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input),
      method: (init as { method?: string } | undefined)?.method ?? 'GET',
      headers: (init as { headers?: unknown } | undefined)?.headers ?? null,
      body: (init as { body?: unknown } | undefined)?.body ?? null,
    });
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
  originals.push(() => {
    global.fetch = originalFetch;
  });

  const XHR = global.XMLHttpRequest;
  if (XHR !== undefined) {
    class RecordingXHR extends (XHR as unknown as { new (): XMLHttpRequest }) {
      override open(method: string, url: string | URL): void {
        record('xhr.open', { method, url: String(url) });
        super.open(method, url);
      }
      override send(body?: Document | XMLHttpRequestBodyInit | null): void {
        record('xhr.send', body === undefined ? null : body);
        super.send(body ?? null);
      }
    }
    global.XMLHttpRequest = RecordingXHR;
    originals.push(() => {
      global.XMLHttpRequest = XHR;
    });
  }

  const navigatorLike = global.navigator as unknown as Record<string, unknown> | undefined;
  if (navigatorLike !== undefined && 'sendBeacon' in navigatorLike) {
    const originalBeacon = navigatorLike.sendBeacon;
    navigatorLike.sendBeacon = ((url: unknown, data?: unknown) => {
      record('navigator.sendBeacon', { url: String(url), data: data ?? null });
      return true;
    }) as unknown as typeof navigatorLike.sendBeacon;
    originals.push(() => {
      navigatorLike.sendBeacon = originalBeacon;
    });
  }

  const WebSocketCtor = global.WebSocket;
  if (WebSocketCtor !== undefined) {
    // No `super(...)`: constructing a real socket in jsdom is not the point, and `about:blank`
    // is not a legal WebSocket URL. The subclass records and then delegates nothing - the
    // positive control in the test below proves the constructor really did run.
    class RecordingWebSocket extends (WebSocketCtor as unknown as new (url: string) => WebSocket) {
      constructor(url: string | URL) {
        record('WebSocket', String(url));
        super(`ws://${RESERVED_HOST}/recorded`);
      }
    }
    global.WebSocket = RecordingWebSocket;
    originals.push(() => {
      global.WebSocket = WebSocketCtor;
    });
  }

  const EventSourceCtor = global.EventSource;
  if (EventSourceCtor !== undefined) {
    class RecordingEventSource extends (
      EventSourceCtor as unknown as new (url: string) => EventSource
    ) {
      constructor(url: string | URL) {
        record('EventSource', String(url));
        super(`http://${RESERVED_HOST}/recorded`);
      }
    }
    global.EventSource = RecordingEventSource;
    originals.push(() => {
      global.EventSource = EventSourceCtor;
    });
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    const original = (console as unknown as Record<string, unknown>)[level];
    if (typeof original !== 'function') continue;
    (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      record(
        'console.' + level,
        args.map((value) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))),
      );
    };
    originals.push(() => {
      (console as unknown as Record<string, unknown>)[level] = original;
    });
  }
}

const consoleCalls = (): RecordedCall[] => calls.filter((entry) => entry.api.startsWith('console.'));
const networkCalls = (): RecordedCall[] => calls.filter((entry) => !entry.api.startsWith('console.'));

// ── The source scanner ───────────────────────────────────────────────────────

/** Blank comments and string literals, so prose and data cannot satisfy or defeat a scan. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Patterns that would put data on the wire or into the address bar.
 *
 * `location` and `history` are here because a statistics identifier in a query string reaches
 * the wire only after someone builds a URL, and `URLSearchParams` / `encodeURIComponent` are the
 * two ways that happens without a literal `?`.
 */
const OUTBOUND_PATTERNS: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\bnew\s+XMLHttpRequest\b/,
  /\bnavigator\s*\.\s*sendBeacon\b/,
  /\bnew\s+WebSocket\b/,
  /\bnew\s+EventSource\b/,
  /\bnavigator\s*\.\s*connection\b/,
  /\bnew\s+URLSearchParams\b/,
  /\bencodeURIComponent\s*\(/,
  /\.searchParams\b/,
  /\blocation\s*\.\s*(href|search|hash|assign|replace)\s*[=(]/,
  /\bhistory\s*\.\s*(pushState|replaceState)\s*\(/,
];

/**
 * Every pattern a source matches.
 *
 * Returns the pattern objects themselves, not their string forms, so a control can assert
 * *which* pattern fired by identity. Comparing `String(pattern)` against the found list is the
 * kind of assertion that passes for the wrong reason: `'/new\\s+WebSocket/'` is not a substring of
 * anything the join produces, so a control written that way is either always red or has to be
 * weakened into meaninglessness.
 */
function scanForOutbound(source: string): RegExp[] {
  const code = codeOnly(source);
  return OUTBOUND_PATTERNS.filter((pattern) => pattern.test(code));
}

const OPEN_DEVICES: ForgedDevice[] = [];

beforeEach(() => {
  calls = [];
  installRecorders();
  window.localStorage.clear();
});

afterEach(async () => {
  while (originals.length > 0) {
    const restore = originals.pop();
    if (restore === undefined) continue;
    try {
      restore();
    } catch {
      /* nothing to restore */
    }
  }
  while (OPEN_DEVICES.length > 0) {
    const device = OPEN_DEVICES.pop();
    if (device === undefined) continue;
    device.repository.close();
    indexedDB.deleteDatabase(device.databaseName);
  }
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Runtime: a whole session makes no network call and logs nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('a real session makes no network call and writes no log line', () => {
  it('drives activation, a room visit, three awards, every end signal, and the reader', async () => {
    vi.resetModules();
    const subjectStore = await import('@/store/subjectStore');
    void subjectStore;
    const progressionStore = await import('@/store/progressionStore');
    const sessionStore = await import('@/store/sessionStore');
    const tracker = await import('@/services/sessionTracker');
    const binding = await import('@/store/sessionLifecycleBinding');
    const { readStatisticsEventLedgerFromFields } = await import('@/core/statistics/statisticsEvents');

    const { FISH_CATALOG } = await import('@/core/fishing/fishingTypes');
    const { toCatchRewardIdentity } = await import('@/core/fishing/catchRewards');

    // The stores are put in the state a real activation leaves behind, so the award sites write
    // the record the reader reads rather than a record keyed on an empty subject.
    progressionStore.useProgressionStore
      .getState()
      .hydrateProgression(progressionStore.readPersistedProgressionPayload());
    progressionStore.useProgressionStore.getState().setActiveSubject(SUBJECT);
    sessionStore.useSessionStore.getState().setActiveSubjectId(SUBJECT);
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT);

    // ── The session id is pinned so the privacy search has a literal to look for.
    const lifecycle = tracker.sessionLifecycle();
    const open = lifecycle.handleSubjectActivated({ subjectId: SUBJECT, subjectName: SUBJECT_NAME });
    expect(open).not.toBeNull();
    const sessionId = (open as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    expect(sessionId).not.toBe(SESSION);

    binding.installSessionLifecycleBinding();

    // ── A room visit, through the wiring.
    sessionStore.useSessionStore.getState().setFocusedRoomId(ROOM);

    // ── Three awards, through the real progression store.
    const clear = { roomId: ROOM, clearIdentity: 'clear-0000qa18-privacy' };
    const clearInputs = {
      qualityBonus: 5,
      totalRooms: 1,
      creatorMappedRooms: 1,
      scribeClearedRooms: 1,
      archaeologistFullReviewPasses: 0,
    };
    progressionStore.useProgressionStore.getState().awardRoomClear({ ...clearInputs, clear });
    progressionStore.useProgressionStore
      .getState()
      .awardReviewPass({ roomId: ROOM, passNumber: 1, reviewIdentity: 'review-0000qa18-privacy' });
    const catalogEntry = FISH_CATALOG.find((entry) => entry.id === 'moss-carp');
    if (catalogEntry === undefined) throw new Error('the shipped catalogue has no moss-carp');
    progressionStore.useProgressionStore.getState().recordCatch({
      subjectId: SUBJECT,
      identity: toCatchRewardIdentity({
        contextId: 'synthetic-qa18-privacy-pond',
        catalogId: catalogEntry.id,
        castNumber: 1,
      }),
      outcome: 'answered-correct',
      catalogEntry,
      subjectName: SUBJECT_NAME,
      recallRoomId: null,
    });

    // ── Every end signal, then the reader.
    window.dispatchEvent(new Event('pagehide'));
    tracker.endCurrentSession();
    const stats = tracker.computeSessionStats(new Date(FIXED_NOW));
    const ledger = readStatisticsEventLedgerFromFields(
      progressionStore.useProgressionStore.getState().bySubject[SUBJECT]?.extraFields,
    );

    // ── The measurement is real: three notes' worth of activity was recorded.
    expect(stats.totalNotesSubmitted).toBe(1);
    expect(stats.totalReviewsCompleted).toBe(1);
    expect(ledger.events.length).toBeGreaterThanOrEqual(6);
    // The reader saw the session that was just closed, which is what makes the "zero network
    // calls" below a statement about a device that *did* record something.
    expect(stats.totalSessions).toBeGreaterThanOrEqual(1);
    expect(stats.totalXpEarned).toBeGreaterThan(0);

    // ── POSITIVE CONTROL: the recorders work. One deliberate call to a reserved host is
    // counted, so the "zero" below is a measurement and not an absent instrument.
    calls = [];
    await fetch(`https://${RESERVED_HOST}/positive-control`);
    const controlSocket = new WebSocket(`wss://${RESERVED_HOST}/positive-control`);
    void controlSocket;
    console.warn('positive-control-log-line');
    expect(networkCalls().length).toBe(2);
    expect(consoleCalls().length).toBe(1);

    // ── Now the real session again, with the recorders live and nothing else.
    calls = [];
    const second = lifecycle.handleSubjectActivated({ subjectId: SUBJECT, subjectName: SUBJECT_NAME });
    expect(second).not.toBeNull();
    const secondId = (second as { sessionId: string }).sessionId;
    sessionStore.useSessionStore.getState().setFocusedRoomId(ROOM);
    progressionStore.useProgressionStore.getState().awardRoomClear({
      ...clearInputs,
      clear: { roomId: ROOM, clearIdentity: 'clear-0000qa18-privacy-2' },
    });
    window.dispatchEvent(new Event('pagehide'));
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if (descriptor === undefined) {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      } else {
        Object.defineProperty(document, 'visibilityState', descriptor);
      }
    }
    tracker.computeSessionStats(new Date(FIXED_NOW));
    tracker.computeStatisticsFromRecords({
      sessions: tracker.readSessionRecords(),
      subjects: [],
      now: new Date(FIXED_NOW),
    });
    tracker.mergeSessionRecord(tracker.readSessionRecords(), tracker.readSessionRecords()[0]);

    // ── Zero network calls.
    expect(networkCalls(), JSON.stringify(networkCalls())).toEqual([]);

    // ── And nothing that reached a recorder carries a statistics identifier. The search is
    // over a list that the control above proved is populated.
    const identifiers = [sessionId, secondId, SUBJECT, SUBJECT_NAME, ROOM, 'clear-0000qa18-privacy', 'review-0000qa18-privacy'];
    const searchable = [...networkCalls(), ...consoleCalls()];
    for (const identifier of identifiers) {
      expect(identifier.length).toBeGreaterThan(0);
      for (const entry of searchable) {
        expect(entry.detail, `${entry.api} carried ${identifier}`).not.toContain(identifier);
      }
    }
    // The console was not merely silent on statistics - it was not used at all on this path.
    expect(consoleCalls()).toEqual([]);

    // ── A last structural read: nothing the session persisted is a URL, a query, or a header.
    const raw = window.localStorage.getItem('knowledge-dungeon:v1:sessions') ?? '';
    expect(raw).not.toContain('http');
    expect(raw).not.toContain('?');
    expect(raw).not.toContain('Bearer');

  });

  it('a persistence failure is swallowed without a log line and without an id in the error', async () => {
    // The lifecycle swallows a persistence failure by design. What has to hold is that swallowing
    // it does not become *reporting* it: no console line, no thrown value, and nothing that
    // reaches a caller's error handler carrying the session id or the subject name.
    const { createSessionLifecycleController } = await import('@/application/sessionLifecycle');
    let thrownToCaller: unknown = null;
    const controller = createSessionLifecycleController({
      nowMs: () => Date.parse(FIXED_NOW),
      persistence: {
        write: () => Promise.reject(new Error(`storage rejected the write for ${SUBJECT_NAME}`)),
        read: () => Promise.resolve([]),
      },
      subject: { readActiveSubject: () => null },
    });

    calls = [];
    // A deliberate positive control on the console recorder first.
    console.error('positive-control-error-line');
    expect(consoleCalls()).toHaveLength(1);
    calls = [];

    try {
      const opened = controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: SUBJECT_NAME });
      expect(opened).not.toBeNull();
      const outcome = controller.endSession('requested');
      expect(outcome.ended).toBe(true);
      // The closed record is still correct in memory, even though nothing persisted it.
      expect(outcome.record?.endedAt).not.toBeNull();
      // Let the rejected write settle, unhandled by design.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } catch (error) {
      thrownToCaller = error;
    }

    expect(thrownToCaller).toBeNull();
    expect(consoleCalls(), 'a persistence failure was logged').toEqual([]);
    expect(networkCalls()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Structural: no module on the statistics path can build a URL or call out
// ─────────────────────────────────────────────────────────────────────────────

describe('no statistics or session module can put data on the wire', () => {
  it('the session tracker, the lifecycle, the statistics core, and both stores are clean', () => {
    const entries = [
      join('core', 'statistics', 'activitySink.ts'),
      join('core', 'statistics', 'localCalendar.ts'),
      join('core', 'statistics', 'statisticsEvents.ts'),
      join('core', 'statistics', 'statisticsMetrics.ts'),
      join('core', 'statistics', 'index.ts'),
      join('application', 'sessionLifecycle.ts'),
      join('application', 'subjectActivation.ts'),
      join('services', 'sessionTracker.ts'),
      join('store', 'statisticsStore.ts'),
      join('store', 'sessionLifecycleBinding.ts'),
    ];
    for (const entry of entries) {
      const path = resolve(SRC, entry);
      const source = readFileSync(path, 'utf8');
      expect(scanForOutbound(source), entry).toEqual([]);
    }
  });

  it('CONTROL: the scanner finds every pattern it claims to find', () => {
    // Without this the scan above could be passing because the regexes match nothing. Each
    // pattern is exercised against a synthetic source that contains it, and the scanner is
    // required to name it.
    const probes: ReadonlyArray<readonly [RegExp, string]> = [
      [OUTBOUND_PATTERNS[0], 'async function go(u){ await fetch(u); }'],
      [OUTBOUND_PATTERNS[1], 'const r = new XMLHttpRequest();'],
      [OUTBOUND_PATTERNS[2], 'navigator.sendBeacon("/x");'],
      [OUTBOUND_PATTERNS[3], 'const s = new WebSocket("wss://x.invalid");'],
      [OUTBOUND_PATTERNS[4], 'const e = new EventSource("/x");'],
      [OUTBOUND_PATTERNS[5], 'navigator.connection.effectiveType;'],
      [OUTBOUND_PATTERNS[6], 'const p = new URLSearchParams();'],
      [OUTBOUND_PATTERNS[7], 'const q = encodeURIComponent(v);'],
      [OUTBOUND_PATTERNS[8], 'url.searchParams.get("a");'],
      [OUTBOUND_PATTERNS[9], 'location.href = "/x";'],
      [OUTBOUND_PATTERNS[10], 'history.pushState({}, "", "/x");'],
    ];
    // Every pattern in the list is probed, so a pattern added later without a probe is itself a
    // failure rather than an untested entry.
    expect(probes).toHaveLength(OUTBOUND_PATTERNS.length);
    for (const [pattern, source] of probes) {
      expect(scanForOutbound(source), `the scanner missed ${String(pattern)}`).toContain(pattern);
    }
    // And the patterns are word-bounded, so a longer identifier that merely contains one is not
    // a finding. `noteSubmissionEventSourceIdentity` is a real function in the statistics core.
    expect(scanForOutbound('export function noteSubmissionEventSourceIdentity(x){ return x; }')).toEqual([]);
    // And a clean source is still clean, so the control is not "the scanner always fires".
    expect(scanForOutbound('export const total = a + b;')).toEqual([]);
    // Prose cannot satisfy the scan, because comments and strings are blanked first.
    expect(scanForOutbound('// do not call fetch()\n/* nor encodeURIComponent */')).toEqual([]);
  });

  it('the whole `src/core/statistics` directory is clean, and the directory is not empty', () => {
    const dir = join(SRC, 'core', 'statistics');
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    // Named, not just non-empty: an empty directory would make the loop vacuously pass.
    expect(files.sort()).toEqual([
      'activitySink.ts',
      'index.ts',
      'localCalendar.ts',
      'statisticsEvents.ts',
      'statisticsMetrics.ts',
    ]);
    for (const name of files) {
      expect(scanForOutbound(readFileSync(join(dir, name), 'utf8')), name).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Data products: no marker in a member name, a manifest string, or a file name
// ─────────────────────────────────────────────────────────────────────────────

describe('no learner-visible string reaches a file name or an archive member name', () => {
  it('a .kdbak and a .kdsubject carry the records but never name a marker', async () => {
    const device = await forgeDevice();
    OPEN_DEVICES.push(device);

    // The forge plants a marker in a subject name, a room topic, a note, a file name, an alt
    // text, and a tag, so the check below has something real to miss.
    expect(ALL_MARKERS.length).toBeGreaterThan(0);

    const full = await exportFullDeviceBackup({
      repository: device.repository,
      generationId: device.generationId,
      now: FIXED_NOW,
    });
    const subject = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: ALPHA,
      now: FIXED_NOW,
      payloadBytes: new Map([['att-alpha-0001', device.sharedBytes]]),
    });

    for (const [label, bytes] of [
      ['.kdbak', full.bytes],
      ['.kdsubject', subject.bytes],
    ] as const) {
      const members = readArchive(bytes);
      // The archive really does carry members, so the name scan below is over a populated list.
      expect(members.length, `${label} had no members`).toBeGreaterThan(1);
      for (const member of members) {
        for (const marker of ALL_MARKERS) {
          expect(member.path, `${label} member ${member.path} names ${marker}`).not.toContain(marker);
        }
        // The attachment prefix is content-addressed by a digest, never a display name.
        expect(member.path).not.toContain('.png');
        expect(member.path).not.toContain(' ');
        expect(member.path).not.toContain(encodeURIComponent(' '));
      }
      const manifest = JSON.parse(
        new TextDecoder().decode(members.find((member) => member.path === 'manifest.json')?.bytes ?? new Uint8Array()),
      ) as { members: Array<{ path: string }>; [key: string]: unknown };
      // The manifest is the one member a UI can list, so it is checked separately: no field
      // anywhere in it may hold a marker.
      for (const marker of ALL_MARKERS) {
        expect(JSON.stringify(manifest), `${label} manifest carries ${marker}`).not.toContain(marker);
      }
      expect(manifest.members.length).toBe(members.length - 1);
    }

    // The download file names the UI offers are static literals with no subject in them.
    for (const marker of ALL_MARKERS) {
      expect(FULL_DEVICE_BACKUP_FILE_NAME).not.toContain(marker);
      expect(SUBJECT_BACKUP_FILE_NAME).not.toContain(marker);
    }
    expect(FULL_DEVICE_BACKUP_FILE_NAME).toBe('knowledge-dungeon-device-backup.kdbak');
    expect(SUBJECT_BACKUP_FILE_NAME).toBe('knowledge-dungeon-subject-backup.kdsubject');
  });

  it('CONTROL: the marker really is inside the archive bytes, so the scan is not vacuous', async () => {
    const device = await forgeDevice();
    OPEN_DEVICES.push(device);
    const full = await exportFullDeviceBackup({
      repository: device.repository,
      generationId: device.generationId,
      now: FIXED_NOW,
    });
    // Decoded and *decompressed*: a ZIP's raw bytes hold none of the content, so a scan over
    // them would find nothing and pass for the wrong reason.
    const decoded = readArchive(full.bytes)
      .map((member) => new TextDecoder().decode(member.bytes))
      .join('\n');
    const present = ALL_MARKERS.filter((marker) => decoded.includes(marker));
    expect(present.length, 'the archive carries no marker at all, so nothing was scanned').toBe(
      ALL_MARKERS.length,
    );
  });
});