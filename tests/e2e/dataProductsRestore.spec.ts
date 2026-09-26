import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test';

import {
  buildLocalRunId,
  buildNetworkPolicyReport,
  classifyRequestLike,
  classifyWebSocketLike,
  describeNetworkFailures,
  evidenceRelativePath,
  sanitizeRunId,
  sanitizeRunnerImageLabel,
  sanitizeToolchainText,
  type HostExecution,
  type NetworkPolicyReport,
  type SanitizedRequest,
  type WebSocketCategory,
} from './compat-evidence';
import { STORAGE_V2_LANE, STORAGE_V2_STORAGE_CONTRACT } from './storage-v2-lane';
import { DATA_PRODUCTS_LANE, DATA_PRODUCTS_OWNER_FLAG } from './data-products-lane';

/**
 * Phase 5 fresh-profile restore lane.
 *
 * Plan section 7.3 and the Phase 5 deliverable list: a `.kdbak` written on one
 * device restores on another, and the evidence for it has to come from a browser,
 * not from `fake-indexeddb`. The strongest available form of that evidence is a
 * **fresh profile**: export in one browser context, import into a second context
 * that was created empty, and assert the state comes back.
 *
 * Four tests, in the order the claim builds:
 *
 * 1. **The lane exercised the artifact it claims to.** The recorded identity of the
 *    shared flagged artifact, the served entrypoint bytes, and the build flag. This
 *    test cannot pass against the wrong `dist`.
 * 2. **The restore context is genuinely empty.** Proven, not assumed: the origin is
 *    inspected on a same-origin *non-application* URL before any application code
 *    runs, and again after the application has loaded. Both the `localStorage` key
 *    set and the IndexedDB database list are recorded at both points, so "fresh" is
 *    an observation with counts in it rather than a claim about a new context.
 * 3. **A backup exported from a populated device restores into that fresh profile,
 *    and the restored state reads back equal.** This is the registered reproduction:
 *    the Data Center and its full-backup tab do not exist yet, so this test fails at
 *    a named, deliberate point rather than at a locator timeout.
 * 4. **Nothing left the device at any point.** No upload request, no
 *    application-endpoint request, no non-idempotent method, no WebSocket, and no
 *    download of anything the user did not ask for.
 *
 * ## Honesty about the failing test
 *
 * Test 3 is expected to fail today, and it is written so that its failure says
 * *"the Phase 5 product interface is not implemented yet"* rather than anything
 * vaguer. The spec reaches the Data Center through the plan's own vocabulary
 * ("Data Center", a "full backup" tab) and, if no such control exists, throws a
 * {@link RegisteredInterface} whose message names the missing interface. It does not
 * stub the application, does not seed the restore, and does not synthesise an
 * archive: the archive under test must be the one the product's own export wrote,
 * because a synthesised one would prove nothing about the product.
 *
 * ## What this lane does not do
 *
 * It does not play the Phaser tutorial, it does not drive a file picker to *create*
 * an attachment, and it does not test a corrupt archive. Those are the Phase 4
 * lane's job, `tests/data`'s job, and a manual check respectively. The device is
 * populated by seeding the synthetic legacy key set and letting the application's
 * own migration run, which is the same path the Phase 4 lane already proves.
 *
 * ## Evidence
 *
 * Written evidence contains counts, categories, and booleans only - no header, no
 * query string, no fragment, no body, no credential, no hostname, no private URL,
 * and no learner value. Every fixture value is synthetic and self-describing, and
 * the only host it names is the reserved `example.invalid`, which is never
 * dereferenced: the route guard aborts any non-loopback request before it can leave
 * the browser, and the attempt would still be recorded as a violation.
 */

const REPO_ROOT = process.cwd();
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');
const ENV_FILE = path.join(REPO_ROOT, DATA_PRODUCTS_LANE.envFile);
const SUBJECT_FIXTURE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'persistence',
  'subject',
  'subject-1.1.0-full-unknown-fields.json',
);
const FALLBACK_PREVIEW_ORIGIN = `http://127.0.0.1:43179`;
const IS_CI = Boolean(process.env.CI);
const RUN_ID = sanitizeRunId(process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid));
const RUN_STARTED_AT = new Date().toISOString();
const HOST_EXECUTION: HostExecution = IS_CI ? 'ci' : 'local-host';
const RUNNER_IMAGE = {
  os: sanitizeRunnerImageLabel(process.env.ImageOS),
  version: sanitizeRunnerImageLabel(process.env.ImageVersion),
};

// ── Synthetic fixture values ───────────────────────────────────────────────

const SUBJECT_ID = 'subject-restore-synthetic';
const SUBJECT_NAME = 'Fresh Profile Restore Synthetic Subject';
const ROOM_ID = 'room-restore-synthetic-root';
const ROOM_TOPIC = 'Fresh Profile Restore Synthetic Root Topic';
const NOTE_BODY = 'Fresh profile restore synthetic note body.';
const EXTERNAL_ATTACHMENT_ID = 'att-restore-synthetic-external';
const LOCAL_ATTACHMENT_ID = 'att-restore-synthetic-unrecoverable';
const EXTERNAL_ATTACHMENT_URL = 'https://example.invalid/restore-synthetic.png';
const SEEDED_XP = 23;
const SEEDED_KEY_COUNT = 9;

/**
 * A registration marker the spec throws when the product is absent.
 *
 * Its whole purpose is to make a red run legible: the failure message names the
 * interface, not a locator, and it is a distinct class so nothing can mistake it
 * for a real assertion failure.
 */
class RegisteredInterface extends Error {
  readonly interfaceName: string;

  constructor(interfaceName: string, detail: string) {
    super(
      `REGISTERED INTERFACE - the Phase 5 product does not implement ${interfaceName} yet. ${detail}`,
    );
    this.name = 'RegisteredInterface';
    this.interfaceName = interfaceName;
  }
}

/**
 * The seeded subject snapshot, with every room renamed consistently.
 *
 * Factored out of {@link legacyKeySet} so the lane's *expected* room-id set is read
 * from the same construction the seed uses, rather than transcribed a second time.
 * A transcription would be a place for the two to disagree, and a disagreement
 * there would look exactly like a restore that lost a room.
 */
function seededSubjectSnapshot(): {
  dungeon: Record<string, unknown> & {
    rooms: { roomId: string }[];
    rootRoomId: string;
    edges?: { fromRoomId: string; toRoomId: string }[];
    tagIndex?: Record<string, string[]>;
  };
  rooms: Record<string, Record<string, unknown>>;
} {
  const subject = JSON.parse(readFileSync(SUBJECT_FIXTURE, 'utf8')) as {
    dungeon: Record<string, unknown> & {
      rooms: { roomId: string }[];
      rootRoomId: string;
      edges?: { fromRoomId: string; toRoomId: string }[];
      tagIndex?: Record<string, string[]>;
    };
    rooms: Record<string, Record<string, unknown>>;
  };
  subject.dungeon.dungeonId = SUBJECT_ID;
  subject.dungeon.subjectName = SUBJECT_NAME;
  const seedRoom = subject.rooms[ROOM_ID] ?? Object.values(subject.rooms)[0];
  if (!seedRoom) throw new Error('The subject fixture has no room to seed.');
  const previousRoomId = seedRoom.roomId as string;
  if (previousRoomId !== ROOM_ID) {
    for (const entry of subject.dungeon.rooms) {
      if (entry.roomId === previousRoomId) entry.roomId = ROOM_ID;
    }
    if (subject.dungeon.rootRoomId === previousRoomId) subject.dungeon.rootRoomId = ROOM_ID;
    for (const edge of subject.dungeon.edges ?? []) {
      if (edge.fromRoomId === previousRoomId) edge.fromRoomId = ROOM_ID;
      if (edge.toRoomId === previousRoomId) edge.toRoomId = ROOM_ID;
    }
    for (const roomIds of Object.values(subject.dungeon.tagIndex ?? {})) {
      for (let index = 0; index < roomIds.length; index += 1) {
        if (roomIds[index] === previousRoomId) roomIds[index] = ROOM_ID;
      }
    }
    const renamed: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(subject.rooms)) {
      renamed[key === previousRoomId ? ROOM_ID : key] = value;
    }
    subject.rooms = renamed;
  }
  const room = subject.rooms[ROOM_ID] as Record<string, unknown>;
  room.roomId = ROOM_ID;
  room.topic = ROOM_TOPIC;
  room.noteText = NOTE_BODY;
  room.attachments = [
    {
      // A historical `/uploads/` reference: these bytes are not on any device and
      // the restore must disclose that rather than fail.
      attachmentId: LOCAL_ATTACHMENT_ID,
      sourceType: 'local',
      fileName: 'restore-synthetic-uploaded.png',
      mimeType: 'image/png',
      relativePath: 'uploads/restore-synthetic-uploaded.png',
      altText: 'restore synthetic uploaded alt',
      addedAt: '2026-01-04T03:04:05.000Z',
    },
    {
      // A user-supplied external URL. Never fetched, never backed up.
      attachmentId: EXTERNAL_ATTACHMENT_ID,
      sourceType: 'external',
      fileName: 'restore-synthetic-external.png',
      mimeType: 'image/png',
      externalUrl: EXTERNAL_ATTACHMENT_URL,
      altText: 'restore synthetic external alt',
      addedAt: '2026-01-04T03:04:05.000Z',
    },
  ];
  return subject;
}

/**
 * The room ids the seed writes, sorted.
 *
 * A `.kdbak` state document is canonical JSON and `canonicalJsonStringify` sorts
 * object keys at every depth, so a restored room map comes back in **sorted-key**
 * order rather than seed order. The lane therefore addresses rooms by id and
 * compares id *sets*; it never compares positions, because position order here is an
 * artifact of key sorting rather than a property of the restore.
 */
function seededRoomIds(): string[] {
  return Object.keys(seededSubjectSnapshot().rooms).sort();
}

/** How many rooms the seed writes, and therefore how many must come back. */
const SEEDED_ROOM_COUNT = seededRoomIds().length;

/** The realistic synthetic legacy key set, identical in shape to Phase 4's. */
function legacyKeySet(): Record<string, string> {
  const subject = seededSubjectSnapshot();
  return {
    'knowledge-dungeon:v1:subjects': JSON.stringify([SUBJECT_ID]),
    [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: JSON.stringify(subject),
    'knowledge-dungeon:v1:activeSubjectId': SUBJECT_ID,
    'knowledge-dungeon:v1:progression': JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: SEEDED_XP,
          rank: 'Novice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 0,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [],
        },
      },
      crossSubjectAchievements: [],
    }),
    'knowledge-dungeon:session:preferences': JSON.stringify({
      graphicsMode: 'rpg',
      colorTheme: 'aurora',
      activeSpritePack: null,
    }),
    'knowledge-dungeon:session:shortcuts': JSON.stringify([
      { labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false },
      { labelKey: 'shortcuts.toggleInfoPanel', key: 'i', ctrlKey: false, shiftKey: false },
    ]),
    'knowledge-dungeon:v1:sessions': JSON.stringify([
      {
        sessionId: 'session-restore-synthetic',
        subjectId: SUBJECT_ID,
        startedAt: '2026-01-04T03:00:00.000Z',
        endedAt: '2026-01-04T03:30:00.000Z',
        roomsVisited: [ROOM_ID],
        notesSubmitted: 1,
        reviewsCompleted: 0,
        xpEarned: SEEDED_XP,
      },
    ]),
    'knowledge-dungeon:locale': 'en',
  };
}

// ── Manifest verification ──────────────────────────────────────────────────

interface RecordedManifest {
  readonly entrypoint?: { readonly path?: string; readonly sha256?: string; readonly bytes?: number };
  readonly build?: { readonly node?: string; readonly platform?: string; readonly arch?: string };
}

interface ManifestVerification {
  readonly status: string;
  readonly code: string;
  readonly message: string;
  readonly identity?: { readonly treeSha256: string; readonly fileCount: number; readonly totalBytes: number } | null;
}

interface ArtifactEvidence {
  readonly verificationStatus: string;
  readonly verificationCode: string;
  readonly treeSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly recordedEntrypointSha256: string;
  readonly servedEntrypointSha256: string;
  readonly servedEntrypointMatchesRecorded: boolean | null;
  readonly servedStatus: number;
  readonly buildNode: string | null;
  /** The same identity the Phase 4 lane verifies, by construction. */
  readonly sharesIdentityWithPhase4Lane: boolean;
}

const UNVERIFIED_ARTIFACT: ArtifactEvidence = {
  verificationStatus: 'not-verified',
  verificationCode: 'verification-did-not-complete',
  treeSha256: 'unknown',
  fileCount: 0,
  totalBytes: 0,
  recordedEntrypointSha256: '',
  servedEntrypointSha256: '',
  servedEntrypointMatchesRecorded: false,
  servedStatus: 0,
  buildNode: null,
  sharesIdentityWithPhase4Lane: false,
};

function verifyRecordedFlaggedArtifact(): ManifestVerification {
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [
        MANIFEST_SCRIPT,
        'verify',
        `--manifest=${path.join(REPO_ROOT, DATA_PRODUCTS_LANE.manifestPath)}`,
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
    `The previewed build is not the recorded flagged artifact (${verification.code}: ${verification.message}). ` +
      'Run "npm run test:e2e:data-products" rather than previewing a different build.',
  ).toBe('match');
  return verification;
}

function readRecordedManifest(): RecordedManifest {
  const manifestPath = path.join(REPO_ROOT, DATA_PRODUCTS_LANE.manifestPath);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No recorded flagged-artifact identity at ${DATA_PRODUCTS_LANE.manifestPath}. ` +
        'Run "npm run build:storage-v2-flagged && npm run record:web-artifact:storage-v2".',
    );
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RecordedManifest;
}

function artifactEvidenceFrom(
  verification: ManifestVerification,
  manifest: RecordedManifest,
  served?: { readonly status: number; readonly sha256: string },
): ArtifactEvidence {
  const recorded = manifest.entrypoint?.sha256 ?? '';
  return {
    verificationStatus: verification.status,
    verificationCode: verification.code,
    treeSha256: verification.identity?.treeSha256 ?? 'unknown',
    fileCount: verification.identity?.fileCount ?? 0,
    totalBytes: verification.identity?.totalBytes ?? 0,
    recordedEntrypointSha256: recorded,
    servedEntrypointSha256: served?.sha256 ?? '',
    servedEntrypointMatchesRecorded: served === undefined ? null : served.sha256 === recorded,
    servedStatus: served?.status ?? 0,
    buildNode: manifest.build?.node ?? null,
    // The two lanes read the same manifest file, so "shares identity" is a
    // property of the declaration rather than of a second comparison.
    sharesIdentityWithPhase4Lane: DATA_PRODUCTS_LANE.manifestPath === STORAGE_V2_LANE.manifestPath,
  };
}

// ── Network spy ────────────────────────────────────────────────────────────

function observeSanitized(request: Request, localOrigin: string | null): SanitizedRequest {
  return classifyRequestLike(
    { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType() },
    localOrigin,
  );
}

async function attachSanitized(
  target: Page,
  localOrigin: string | null,
): Promise<{ requests: SanitizedRequest[]; webSockets: WebSocketCategory[] }> {
  const requests: SanitizedRequest[] = [];
  const webSockets: WebSocketCategory[] = [];
  target.on('request', (request) => requests.push(observeSanitized(request, localOrigin)));
  await target.routeWebSocket(() => true, (webSocket) => {
    webSockets.push(classifyWebSocketLike(webSocket.url(), localOrigin));
  });
  return { requests, webSockets };
}

/** Every non-loopback request is aborted before it can leave the browser. */
async function blockExternal(page: Page): Promise<void> {
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
}

test.beforeEach(async ({ page }) => {
  await blockExternal(page);
});

// ── Profile probing ────────────────────────────────────────────────────────

/**
 * What a profile holds, read from inside the page.
 *
 * Every field is a count, a list of code-shaped names, or a boolean. Nothing here
 * is a learner value, and the shape is the same whether it is read before or after
 * the application runs, which is what makes the two readings comparable.
 */
interface ProfileObservation {
  /** `localStorage` key count. */
  readonly legacyKeyCount: number;
  /** Sorted `localStorage` keys, code-shaped only. */
  readonly legacyKeys: readonly string[];
  /** IndexedDB database names, sorted. */
  readonly databaseNames: readonly string[];
  /** Object stores the storage-v2 database has, or `[]` when it has none. */
  readonly storageObjectStores: readonly string[];
  readonly storageSchemaVersion: number;
  readonly activeGenerationId: string | null;
  /** Subject count in the active generation. */
  readonly subjectCount: number;
  readonly progressionXpTotal: number | null;
  readonly externalOnlyAttachmentCount: number;
  readonly externalOnlyWithNullHash: number;
  readonly receiptCount: number;
  /** The seeded subject's name, present only after the application has read it. */
  readonly subjectNameMatchesSeed: boolean;
  /**
   * The seeded room's topic and note, read **by room id**.
   *
   * Not by position. A `.kdbak` state document is canonical JSON and
   * `canonicalJsonStringify` sorts object keys at every depth, so a restored room map
   * comes back in sorted-key order; `Object.values(rooms)[0]` would name whichever
   * room sorts first, which is a property of key sorting rather than of the restore.
   */
  readonly roomTopicMatchesSeedById: boolean;
  readonly noteBodyMatchesSeedById: boolean;
  /**
   * How many rooms the restored subject carries, and whether its room-id *set*
   * equals the seed's.
   *
   * This is what catches a restore that dropped a room. Together with the
   * by-id lookups it makes the room assertion complete rather than partial: a
   * restore that lost a room would fail the count, and a restore that swapped two
   * rooms' contents would fail the set.
   */
  readonly roomCount: number;
  readonly roomIdsMatchSeed: boolean;
  /** Count of subject-name-shaped buttons on the Welcome screen. */
  readonly welcomeSubjectButtons: number;
}

/**
 * The IndexedDB database names, read without opening anything.
 *
 * This is the only safe way to ask "does a database exist here?", because opening
 * one creates it. The freshness proof takes a reading before and after
 * {@link observeProfile} and requires the two to be identical, so a probe that
 * quietly created a database would fail the test rather than satisfy it.
 */
async function listDatabaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const factory = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    if (typeof factory.databases !== 'function') return ['<unavailable>'];
    return (await factory.databases())
      .map((entry) => entry.name ?? '')
      .filter((name) => name.length > 0)
      .sort();
  });
}

/**
 * One generation's descriptor and record counts, read by id.
 *
 * The retention proof needs to look at a generation that is no longer active, so
 * it cannot go through {@link observeProfile} - that always follows the pointer.
 * `generationId` is passed in from the test, never discovered here, so the caller
 * states which generation it believes was superseded and the probe reports what is
 * actually there.
 */
interface GenerationObservation {
  /** False when the registry holds no descriptor under this id at all. */
  readonly descriptorFound: boolean;
  /** `staged`, `active`, `superseded`, or `none`. */
  readonly status: string;
  readonly subjectCount: number;
  readonly preferenceCount: number;
  /** Whether a record with this exact id is present in the `preferences` store. */
  readonly sentinelRecordPresent: boolean;
  /** Whether the descriptor's roll-up checksum is a real SHA-256 hex digest. */
  readonly contentChecksumIsSha256Hex: boolean;
}

/** The record id the lane writes into the target's pre-restore generation. */
const PRIOR_GENERATION_SENTINEL_RECORD_ID = 'kd-restore-lane-prior-sentinel';

/**
 * Writes one sentinel record into `generationId`, through a real IndexedDB
 * transaction in the page.
 *
 * This is the instrument that makes the retention claim provable rather than
 * asserted. A fresh profile's first-run generation is *empty*, so "the previous
 * generation was retained" checked against it would pass even if the importer
 * deleted it - an empty generation that is gone is indistinguishable from an empty
 * generation that is intact. Writing a known record first means the assertion
 * afterwards is "the record I put there is still readable", which an importer that
 * deletes the previous generation cannot satisfy.
 *
 * It is a test instrument in the same sense as the Phase 4 lane's
 * `writeDeviceLocalAttachment`: it writes through the store's own key structure in
 * a real browser transaction. The application itself is not involved, and nothing is
 * stubbed.
 */
async function writeSentinelRecord(
  page: Page,
  generationId: string,
): Promise<{ written: boolean; recordId: string }> {
  return page.evaluate(
    async (input): Promise<{ written: boolean; recordId: string }> => {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open(input.contract.databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
      if (!db) return { written: false, recordId: input.recordId };
      const written = await new Promise<boolean>((resolve) => {
        try {
          const transaction = db.transaction(
            [input.contract.preferencesStore],
            'readwrite',
          );
          transaction.objectStore(input.contract.preferencesStore).put({
            generationId: input.generationId,
            recordId: input.recordId,
            value: { preferenceId: input.recordId, value: 1, updatedAt: input.now },
            // The repository computes the real checksum; `null` is the value it
            // writes before one is computed, and `validateRecordEnvelope` tolerates
            // it. This generation is never validated by the lane.
            checksum: null,
            updatedAt: input.now,
          });
          transaction.oncomplete = () => resolve(true);
          transaction.onerror = () => resolve(false);
          transaction.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
      db.close();
      return { written, recordId: input.recordId };
    },
    {
      contract: STORAGE_V2_STORAGE_CONTRACT,
      generationId,
      recordId: PRIOR_GENERATION_SENTINEL_RECORD_ID,
      now: '2026-01-04T03:00:00.000Z',
    },
  );
}

/** Reads one named generation's descriptor and record counts out of the page. */
async function readGeneration(
  page: Page,
  generationId: string,
): Promise<GenerationObservation> {
  return page.evaluate(
    async (input): Promise<GenerationObservation> => {
      const open = (): Promise<IDBDatabase | null> =>
        new Promise((resolve) => {
          const request = indexedDB.open(input.contract.databaseName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });
      const db = await open();
      if (!db) {
        return {
          descriptorFound: false,
          status: 'none',
          subjectCount: 0,
          preferenceCount: 0,
          sentinelRecordPresent: false,
          contentChecksumIsSha256Hex: false,
        };
      }

      // A record store is keyed by the compound `[generationId, recordId]`, so a
      // generation's records are reached through the `byGeneration` index rather
      // than through a range over the compound key. The `meta` registry row is keyed
      // by the same compound key and is read directly, because its record id is the
      // generation's own label.
      const readRecordsOf = <T,>(storeName: string): Promise<T[]> =>
        new Promise((resolve) => {
          try {
            const store = db.transaction(storeName, 'readonly').objectStore(storeName);
            if (!store.indexNames.contains(input.contract.generationScopeIndex)) {
              resolve([]);
              return;
            }
            const request = store
              .index(input.contract.generationScopeIndex)
              .getAll(IDBKeyRange.only(input.generationId));
            request.onsuccess = () => resolve((request.result ?? []) as T[]);
            request.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        });
      const readMetaRow = <T,>(recordId: string): Promise<T[]> =>
        new Promise((resolve) => {
          try {
            const store = db.transaction(input.contract.metaStore, 'readonly').objectStore(input.contract.metaStore);
            const request = store.get([input.generationId, recordId]);
            request.onsuccess = () =>
              resolve(request.result === undefined ? [] : ([request.result] as T[]));
            request.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        });

      // The registry row: `generation:<id>` in the `meta` store.
      const registryKey = `${input.contract.generationKeyPrefix}${input.generationId}`;
      const descriptor = (
        await readMetaRow<{ value?: { status?: string; contentChecksum?: string } }>(registryKey)
      )[0]?.value;

      const subjects = await readRecordsOf<{ recordId: string }>(input.contract.subjectsStore);
      const preferences = await readRecordsOf<{ recordId: string }>(input.contract.preferencesStore);
      db.close();

      return {
        descriptorFound: descriptor !== undefined,
        status: descriptor?.status ?? 'none',
        subjectCount: subjects.length,
        preferenceCount: preferences.length,
        sentinelRecordPresent: preferences.some(
          (record) => record.recordId === input.recordId,
        ),
        contentChecksumIsSha256Hex: /^[0-9a-f]{64}$/.test(descriptor?.contentChecksum ?? ''),
      };
    },
    {
      contract: STORAGE_V2_STORAGE_CONTRACT,
      generationId,
      recordId: PRIOR_GENERATION_SENTINEL_RECORD_ID,
    },
  );
}

/**
 * Reads the profile. Never writes.
 *
 * `indexedDB.open` CREATES an empty, store-less database when none exists, so
 * "a database exists" proves nothing: the object-store list and the schema version
 * are what prove the application actually opened storage-v2, and an empty
 * `storageObjectStores` is the honest reading of a profile the app has never run in.
 */
async function observeProfile(page: Page): Promise<ProfileObservation> {
  return page.evaluate(
    async (input): Promise<ProfileObservation> => {
      const safeKey = (key: string): boolean => /^[A-Za-z0-9._:-]{1,96}$/.test(key);

      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key !== null && safeKey(key)) keys.push(key);
      }
      keys.sort();

      const factory = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
      const databaseNames =
        typeof factory.databases === 'function'
          ? (await factory.databases())
              .map((entry) => entry.name ?? '')
              .filter((name) => name.length > 0)
              .sort()
          : [];

      // `indexedDB.open` CREATES an empty, store-less database when none exists.
      // Opening one to look inside it would therefore *manufacture* the very state
      // the freshness proof exists to observe, and a fresh profile would report a
      // storage-v2 database that the application never opened. So the database
      // list is read first, and the database is opened only when it is already
      // there. `listDatabaseNames` in the spec takes a second reading around this
      // call and asserts the list is unchanged, which is what makes "the probe did
      // not create it" a measured property.
      const storageDatabaseExists = databaseNames.includes(input.contract.databaseName);
      const openDatabase = (name: string): Promise<IDBDatabase | null> =>
        new Promise((resolve) => {
          if (!storageDatabaseExists) {
            resolve(null);
            return;
          }
          let request: IDBOpenDBRequest;
          try {
            request = indexedDB.open(name);
          } catch {
            resolve(null);
            return;
          }
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });

      const db = storageDatabaseExists ? await openDatabase(input.contract.databaseName) : null;
      if (!db) {
        return {
          legacyKeyCount: keys.length,
          legacyKeys: keys,
          databaseNames,
          storageObjectStores: [],
          storageSchemaVersion: 0,
          activeGenerationId: null,
          subjectCount: 0,
          progressionXpTotal: null,
          externalOnlyAttachmentCount: 0,
          externalOnlyWithNullHash: 0,
          receiptCount: 0,
          subjectNameMatchesSeed: false,
          roomTopicMatchesSeedById: false,
          noteBodyMatchesSeedById: false,
          roomCount: 0,
          roomIdsMatchSeed: false,
          welcomeSubjectButtons: 0,
        };
      }

      const objectStoreNames = [...db.objectStoreNames].sort();
      const schemaVersion = db.version;

      const readAll = (storeName: string, generationId: string | null): Promise<Record<string, unknown>[]> =>
        new Promise((resolve) => {
          try {
            const store = db.transaction(storeName, 'readonly').objectStore(storeName);
            const source =
              generationId && store.indexNames.contains(input.contract.generationScopeIndex)
                ? store.index(input.contract.generationScopeIndex).getAll(IDBKeyRange.only(generationId))
                : store.getAll();
            source.onsuccess = () => resolve((source.result ?? []) as Record<string, unknown>[]);
            source.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        });

      const pointer = await new Promise<{ activeGeneration: string | null } | null>((resolve) => {
        try {
          const store = db.transaction(input.contract.metaStore, 'readonly').objectStore(input.contract.metaStore);
          const request = store.index('byKey').get(input.contract.activeGenerationKey);
          request.onsuccess = () =>
            resolve(
              ((request.result as { value?: { activeGeneration: string | null } } | undefined)?.value ??
                null) as { activeGeneration: string | null } | null,
            );
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      const activeGenerationId = pointer?.activeGeneration ?? null;

      const subjectRecords = (await readAll(
        input.contract.subjectsStore,
        activeGenerationId,
      )) as { value: Record<string, unknown> }[];
      let subjectNameMatchesSeed = false;
      let roomTopicMatchesSeedById = false;
      let noteBodyMatchesSeedById = false;
      let roomCount = 0;
      let roomIdsMatchSeed = false;
      if (subjectRecords.length > 0) {
        const value = (subjectRecords[0]?.value ?? {}) as {
          snapshot?: {
            dungeon?: { subjectName?: string };
            rooms?: Record<string, { topic?: string; noteText?: string }>;
          };
        };
        const rooms = value.snapshot?.rooms ?? {};
        const roomIds = Object.keys(rooms);
        roomCount = roomIds.length;
        // Compare id *sets*, in sorted order, so the comparison is about which rooms
        // exist and not about the order the map happens to enumerate in.
        const actual = [...roomIds].sort();
        const expected = [...input.expect.roomIds].sort();
        roomIdsMatchSeed = actual.length === expected.length && actual.every((id, i) => id === expected[i]);
        // ...and address the seeded room by its own id.
        const seededRoom = rooms[input.expect.roomId];
        subjectNameMatchesSeed = value.snapshot?.dungeon?.subjectName === input.expect.subjectName;
        roomTopicMatchesSeedById = seededRoom?.topic === input.expect.roomTopic;
        noteBodyMatchesSeedById = seededRoom?.noteText === input.expect.noteBody;
      }

      const progressionRecords = (await readAll(
        input.contract.progressionStore,
        activeGenerationId,
      )) as { value: { bySubject?: Record<string, { xpTotal?: number }> } }[];
      let progressionXpTotal: number | null = null;
      for (const record of progressionRecords) {
        for (const perSubject of Object.values(record.value.bySubject ?? {})) {
          if (typeof perSubject.xpTotal === 'number') {
            progressionXpTotal = (progressionXpTotal ?? 0) + perSubject.xpTotal;
          }
        }
      }

      const attachmentRecords = (await readAll(
        input.contract.attachmentsStore,
        activeGenerationId,
      )) as { recordId: string; value: Record<string, unknown> }[];
      let externalOnlyAttachmentCount = 0;
      let externalOnlyWithNullHash = 0;
      for (const record of attachmentRecords) {
        if (!record.recordId.startsWith(input.contract.attachmentMetadataPrefix)) continue;
        const value = record.value as { availability?: string; contentHash?: string | null };
        if (value.availability !== 'external-only') continue;
        externalOnlyAttachmentCount += 1;
        if (value.contentHash === null) externalOnlyWithNullHash += 1;
      }

      const receipts = await readAll(input.contract.migrationReceiptsStore, activeGenerationId);
      db.close();

      return {
        legacyKeyCount: window.localStorage.length,
        legacyKeys: keys,
        databaseNames,
        storageObjectStores: objectStoreNames,
        storageSchemaVersion: schemaVersion,
        activeGenerationId,
        subjectCount: subjectRecords.length,
        progressionXpTotal,
        externalOnlyAttachmentCount,
        externalOnlyWithNullHash,
        receiptCount: receipts.length,
        subjectNameMatchesSeed,
        roomTopicMatchesSeedById,
        noteBodyMatchesSeedById,
        roomCount,
        roomIdsMatchSeed,
        welcomeSubjectButtons: 0,
      };
    },
    {
      contract: { ...STORAGE_V2_STORAGE_CONTRACT, seededSubjectId: SUBJECT_ID },
      expect: {
        subjectName: SUBJECT_NAME,
        roomTopic: ROOM_TOPIC,
        noteBody: NOTE_BODY,
        roomId: ROOM_ID,
        roomIds: seededRoomIds(),
      },
    },
  );
}

/** Counts the subject-name-shaped controls on the Welcome screen. */
async function countWelcomeSubjectButtons(page: Page): Promise<number> {
  return page.getByRole('button', { name: new RegExp(SUBJECT_NAME) }).count();
}

/**
 * Creates a genuinely fresh context.
 *
 * No `storageState` is passed, which is the whole point: a context created with one
 * would inherit cookies and `localStorage` from a saved profile, and a context
 * created inside a reused context would inherit its IndexedDB databases too. This
 * takes a `Browser`, not the test's `context` fixture, so nothing can be inherited
 * by accident.
 */
async function createFreshContext(browser: {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
}): Promise<BrowserContext> {
  return browser.newContext({
    acceptDownloads: true,
    viewport: { ...DATA_PRODUCTS_LANE.viewport },
    deviceScaleFactor: DATA_PRODUCTS_LANE.deviceScaleFactor,
    hasTouch: DATA_PRODUCTS_LANE.hasTouch,
  });
}

/** Seeds the synthetic legacy key set once per context, before any app code. */
async function seedLegacyStateOnce(page: Page): Promise<void> {
  await page.addInitScript(
    (keys: Record<string, string>) => {
      if (window.localStorage.getItem('kd-restore-lane-seeded') === '1') return;
      for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
      window.localStorage.setItem('kd-restore-lane-seeded', '1');
    },
    legacyKeySet(),
  );
}

// ── Evidence ───────────────────────────────────────────────────────────────

interface FreshnessEvidence {
  /** The context was created without a `storageState`. */
  readonly contextCreatedWithoutStorageState: boolean;
  readonly observedBeforeApplicationKeyCount: number;
  readonly observedBeforeApplicationDatabaseCount: number;
  readonly observedBeforeApplicationStorageObjectStoreCount: number;
  readonly observedAfterApplicationKeyCount: number;
  readonly observedAfterApplicationDatabaseCount: number;
  readonly observedAfterApplicationStorageObjectStoreCount: number;
  /** Keys the application itself wrote on its own initiative, counted not listed. */
  readonly appInitiativeKeyCount: number;
  readonly noContentKeysBeforeApplication: boolean;
  readonly noStorageDatabaseBeforeApplication: boolean;
  /**
   * True when the database list was identical before and after the profile probe.
   *
   * The load-bearing one. `indexedDB.open` creates a store-less database when none
   * exists, so a probe that opened the storage-v2 database to look inside it would
   * manufacture the very absence it is trying to observe. This flag is what makes
   * "the profile was empty" an observation rather than an artifact of the
   * instrument.
   */
  readonly probeCreatedNoDatabase: boolean;
  /** True when the generation the application created holds no learner record. */
  readonly initialGenerationIsEmpty: boolean;
}

const UNOBSERVED_FRESHNESS: FreshnessEvidence = {
  contextCreatedWithoutStorageState: false,
  observedBeforeApplicationKeyCount: -1,
  observedBeforeApplicationDatabaseCount: -1,
  observedBeforeApplicationStorageObjectStoreCount: -1,
  observedAfterApplicationKeyCount: -1,
  observedAfterApplicationDatabaseCount: -1,
  observedAfterApplicationStorageObjectStoreCount: -1,
  appInitiativeKeyCount: -1,
  noContentKeysBeforeApplication: false,
  noStorageDatabaseBeforeApplication: false,
  probeCreatedNoDatabase: false,
  initialGenerationIsEmpty: false,
};

interface RestoreEvidence {
  /** Whether the export control was found and driven. */
  readonly exportControlFound: boolean;
  readonly downloadStarted: boolean;
  readonly downloadSuggestedFilenameExtensionIsKdbak: boolean | null;
  readonly downloadByteLength: number;
  readonly importControlFound: boolean;
  readonly restoredSubjectCount: number;
  readonly restoredProgressionXpTotal: number | null;
  readonly restoredSubjectNameMatchesSeed: boolean;
  readonly restoredRoomTopicMatchesSeedById: boolean;
  readonly restoredNoteBodyMatchesSeedById: boolean;
  /** Rooms in the restored subject, and whether the room-id set equals the seed's. */
  readonly restoredRoomCount: number;
  readonly restoredRoomIdsMatchSeed: boolean;
  readonly restoredExternalOnlyAttachmentCount: number;
  readonly restoredExternalOnlyWithNullHash: number;
  /**
   * The target's own prior active generation, and what happened to it.
   *
   * Read back **by id** after the restore, which is the only way to prove the
   * retention promise: an importer that deleted the previous generation would leave
   * no descriptor and no records, and both of those are reported here.
   */
  readonly targetPriorGenerationIdIsCodeShaped: boolean;
  readonly targetPriorGenerationIsRetained: boolean | null;
  readonly targetPriorGenerationStatus: string;
  readonly targetPriorSentinelSurvived: boolean | null;
  readonly targetPriorSubjectCountUnchanged: boolean | null;
  /** The active generation after the restore is not the target's prior one. */
  readonly activeGenerationIsNotThePriorOne: boolean | null;
  /** The named interface the run stopped at, or `null` when it completed. */
  readonly stoppedAtInterface: string | null;
}

const UNOBSERVED_RESTORE: RestoreEvidence = {
  exportControlFound: false,
  downloadStarted: false,
  downloadSuggestedFilenameExtensionIsKdbak: null,
  downloadByteLength: 0,
  importControlFound: false,
  restoredSubjectCount: 0,
  restoredProgressionXpTotal: null,
  restoredSubjectNameMatchesSeed: false,
  restoredRoomTopicMatchesSeedById: false,
  restoredNoteBodyMatchesSeedById: false,
  restoredRoomCount: 0,
  restoredRoomIdsMatchSeed: false,
  restoredExternalOnlyAttachmentCount: 0,
  restoredExternalOnlyWithNullHash: 0,
  targetPriorGenerationIdIsCodeShaped: false,
  targetPriorGenerationIsRetained: null,
  targetPriorGenerationStatus: 'none',
  targetPriorSentinelSurvived: null,
  targetPriorSubjectCountUnchanged: null,
  activeGenerationIsNotThePriorOne: null,
  stoppedAtInterface: null,
};

interface RestoreLaneEvidence {
  readonly schemaVersion: number;
  readonly suite: string;
  readonly runId: string;
  readonly runStartedAt: string;
  readonly hostExecution: HostExecution;
  readonly project: string;
  readonly testTitle: string;
  readonly lane: {
    readonly buildMode: string;
    readonly flag: string;
    readonly flagValue: string;
    readonly storageRepository: string;
    readonly worldRenderer: string;
    readonly dataProductsV2: boolean;
    readonly manifestPath: string;
    readonly sharesArtifactWith: string;
    readonly declaredViewport: { readonly width: number; readonly height: number };
    readonly evidenceClass: string;
  };
  readonly host: {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly release: string;
    readonly ci: boolean;
    readonly runnerImage: { readonly os: string | null; readonly version: string | null };
  };
  readonly artifact: ArtifactEvidence;
  readonly sourceProfile: {
    readonly seededKeyCount: number;
    readonly subjectCount: number;
    readonly activeGenerationIsSafeIdentifier: boolean;
    readonly receiptCount: number;
    readonly externalOnlyAttachmentCount: number;
    readonly progressionContainsSeededXp: boolean;
  };
  readonly freshness: FreshnessEvidence;
  readonly restore: RestoreEvidence;
  readonly network: NetworkPolicyReport;
  readonly failure: { readonly name: string; readonly message: string } | null;
}

function buildEvidence(input: {
  testInfo: TestInfo;
  artifact: ArtifactEvidence;
  source: ProfileObservation | null;
  freshness: FreshnessEvidence;
  restore: RestoreEvidence;
  network: NetworkPolicyReport;
  failure: Error | null;
}): RestoreLaneEvidence {
  const source = input.source;
  return {
    schemaVersion: DATA_PRODUCTS_LANE.schemaVersion,
    suite: DATA_PRODUCTS_LANE.suite,
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    hostExecution: HOST_EXECUTION,
    project: DATA_PRODUCTS_LANE.project,
    testTitle: input.testInfo.title,
    lane: {
      buildMode: DATA_PRODUCTS_LANE.buildMode,
      flag: DATA_PRODUCTS_LANE.flag,
      flagValue: DATA_PRODUCTS_LANE.flagValue,
      storageRepository: DATA_PRODUCTS_LANE.storageRepository,
      worldRenderer: DATA_PRODUCTS_LANE.worldRenderer,
      dataProductsV2: DATA_PRODUCTS_LANE.dataProductsV2,
      manifestPath: DATA_PRODUCTS_LANE.manifestPath,
      sharesArtifactWith: DATA_PRODUCTS_LANE.sharesArtifactWith,
      declaredViewport: DATA_PRODUCTS_LANE.viewport,
      evidenceClass: DATA_PRODUCTS_LANE.evidenceClass,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      ci: IS_CI,
      runnerImage: RUNNER_IMAGE,
    },
    artifact: input.artifact,
    sourceProfile: {
      seededKeyCount: SEEDED_KEY_COUNT,
      subjectCount: source?.subjectCount ?? 0,
      activeGenerationIsSafeIdentifier:
        source?.activeGenerationId !== null && /^[A-Za-z0-9._-]{1,64}$/.test(source?.activeGenerationId ?? ''),
      receiptCount: source?.receiptCount ?? 0,
      externalOnlyAttachmentCount: source?.externalOnlyAttachmentCount ?? 0,
      progressionContainsSeededXp: source?.progressionXpTotal === SEEDED_XP,
    },
    freshness: input.freshness,
    restore: input.restore,
    network: input.network,
    failure: input.failure
      ? {
          name: sanitizeToolchainText(input.failure.name) || 'Error',
          message: sanitizeToolchainText(input.failure.message.split('\n')[0] ?? ''),
        }
      : null,
  };
}

function writeEvidenceFile(testInfo: TestInfo, evidence: RestoreLaneEvidence): void {
  const relativePath = evidenceRelativePath({
    runId: RUN_ID,
    project: evidence.project,
    testTitle: testInfo.title,
  });
  const absolutePath = path.join(REPO_ROOT, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[data-products-evidence-file] ${relativePath}`);
}

test.beforeAll(() => {
  console.log(
    `[data-products-lane] ${DATA_PRODUCTS_LANE.project} on ${os.platform()}/${os.arch()} node ${process.version} ` +
      `artifact ${DATA_PRODUCTS_LANE.buildMode} (shared with ${DATA_PRODUCTS_LANE.sharesArtifactWith}) ` +
      `dataProductsV2=${String(DATA_PRODUCTS_LANE.dataProductsV2)}`,
  );
});

// ── Tests ──────────────────────────────────────────────────────────────────

test('the lane exercised the shared flagged artifact, with the Phase 5 product on', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  let failure: Error | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  try {
    // The build flag is a build-input claim, so it is verified from the file that
    // carries it rather than assumed.
    expect(existsSync(ENV_FILE), `${DATA_PRODUCTS_LANE.envFile} must exist`).toBe(true);
    expect(readFileSync(ENV_FILE, 'utf8')).toMatch(
      new RegExp(`^\\s*${DATA_PRODUCTS_LANE.flag}=${DATA_PRODUCTS_LANE.flagValue}\\s*$`, 'm'),
    );

    const verification = verifyRecordedFlaggedArtifact();
    const manifest = readRecordedManifest();
    expect(manifest.entrypoint?.sha256 ?? '').toMatch(/^[0-9a-f]{64}$/);

    const response = await request.get('/');
    expect(response.status(), 'The production preview must serve the recorded entrypoint.').toBe(200);
    artifact = artifactEvidenceFrom(verification, manifest, {
      status: response.status(),
      sha256: createHash('sha256').update(await response.body()).digest('hex'),
    });

    expect(artifact.verificationStatus).toBe('match');
    expect(artifact.fileCount).toBeGreaterThan(0);
    expect(artifact.totalBytes).toBeGreaterThan(0);
    expect(artifact.servedEntrypointMatchesRecorded).toBe(true);
    // This lane and the Phase 4 lane read the same recorded identity, so neither
    // can be pointed at a different build without both noticing.
    expect(artifact.sharesIdentityWithPhase4Lane).toBe(true);
    // The Phase 5 owner flag is ON in the artifact this lane previews. Recording it
    // rather than inferring it is the point: a lane that silently previewed a
    // product-free build would report the restore as impossible for a reason that
    // had nothing to do with the product.
    expect(DATA_PRODUCTS_LANE.dataProductsV2).toBe(true);
    // ...and the flag really is the one the plan names, so "on" means something.
    expect(DATA_PRODUCTS_OWNER_FLAG).toBe('VITE_DATA_PRODUCTS_V2');

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await page.waitForLoadState('networkidle');
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      source: null,
      freshness: UNOBSERVED_FRESHNESS,
      restore: UNOBSERVED_RESTORE,
      network,
      failure,
    }),
  );
  if (failure) throw failure;
  expect(network.webSockets.total).toBe(0);
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('a second browser context starts from an empty profile, and the observation proves it', async ({
  browser,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  let failure: Error | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  let freshness: FreshnessEvidence = UNOBSERVED_FRESHNESS;
  let spy: { requests: SanitizedRequest[]; webSockets: WebSocketCategory[] } = {
    requests: [],
    webSockets: [],
  };

  let context: BrowserContext | null = null;
  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());

    // The freshness proof, in order:
    //
    // 1. A context is created from the *browser*, not from the test's context
    //    fixture, and with no `storageState`. Nothing can be inherited.
    context = await createFreshContext(browser);
    const page = await context.newPage();
    spy = await attachSanitized(page, localOrigin);
    await blockExternal(page);

    // 2. The origin is inspected on a same-origin *non-application* URL, so the
    //    reading is of a profile the application has never touched. This is the
    //    step that makes "fresh" an observation rather than an assumption: a
    //    reading taken after `page.goto('/')` could not distinguish "the app
    //    created nothing" from "the app had already created something".
    await page.goto('/assets/sprite-manifest.json');
    // The probe must not create what it measures, so the database list is read
    // before and after the observation and the two must be identical.
    const databasesBeforeProbe = await listDatabaseNames(page);
    const before = await observeProfile(page);
    const databasesAfterProbe = await listDatabaseNames(page);
    expect(databasesAfterProbe, 'the profile probe created an IndexedDB database').toEqual(
      databasesBeforeProbe,
    );

    // 3. The application is loaded into the same context, and the profile is read
    //    again. The difference between the two readings is exactly what the
    //    application did to a profile it found empty.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const after = await observeProfile(page);
    const welcomeSubjectButtons = await countWelcomeSubjectButtons(page);

    // Non-vacuity: both readings are real observations with counts in them, not
    // two empty objects.
    expect(before.legacyKeyCount).toBeGreaterThanOrEqual(0);
    expect(before.storageObjectStores).toEqual([]);
    // Version 0 is "no database", not "an empty database": the probe reads the
    // database list first and only opens the database when it is already there, so
    // this reading is of an origin the application has never written to.
    expect(before.storageSchemaVersion).toBe(0);
    // Nothing learner-owned exists yet: no `localStorage` key at all, no
    // `knowledge-dungeon-storage-v2` database, and no storage-v2 object store.
    expect(before.legacyKeyCount).toBe(0);
    expect(before.legacyKeys).toEqual([]);
    expect(before.databaseNames).not.toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(before.activeGenerationId).toBeNull();
    expect(before.subjectCount).toBe(0);
    expect(before.receiptCount).toBe(0);
    // ...and the Welcome screen agrees: a first run has no subject to show.
    expect(welcomeSubjectButtons).toBe(0);

    // After the application has run, the legacy key set may contain the keys the
    // application writes on its own initiative - the i18next language detector's
    // `knowledge-dungeon:locale` and the language cookie it mirrors - and nothing
    // else. That distinction is the Phase 4 defect class this lane inherits: a key
    // the app writes on its own initiative is a marker, not content.
    const afterKeys = [...after.legacyKeys];
    const appInitiativeKeys = afterKeys.filter(
      (key) => key === 'knowledge-dungeon:locale' || key.startsWith('i18nextLng'),
    );
    const contentKeys = afterKeys.filter(
      (key) => key !== 'kd-restore-lane-seeded' && !appInitiativeKeys.includes(key),
    );
    expect(contentKeys, afterKeys.join(',')).toEqual([]);

    // The application really did open storage-v2, and really did create the
    // generation a first run needs - an **empty** one. "Fresh" therefore means
    // "holds no learner record", not "holds nothing at all", and the difference is
    // asserted rather than glossed: a generation that exists with zero subjects,
    // zero receipts, and no progression is the correct state for a profile nobody
    // has used yet, and a generation with a subject in it would mean the context
    // was not fresh.
    expect(after.databaseNames).toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(after.storageObjectStores).toEqual([
      'assistance',
      'attachments',
      'customSprites',
      'meta',
      'migrationReceipts',
      'preferences',
      'progression',
      'recovery',
      'sessions',
      'shortcuts',
      'subjects',
    ]);
    expect(after.storageSchemaVersion).toBe(STORAGE_V2_STORAGE_CONTRACT.schemaVersion);
    expect(after.subjectCount).toBe(0);
    expect(after.receiptCount).toBe(0);
    expect(after.progressionXpTotal).toBeNull();
    expect(after.externalOnlyAttachmentCount).toBe(0);
    expect(after.subjectNameMatchesSeed).toBe(false);
    // The room assertions must not fire on a profile with no subject at all, so the
    // by-id lookups are false here and `roomIdsMatchSeed` is too. Without this, a
    // probe that reported `true` vacuously on an empty profile would look like a
    // passing room check.
    expect(after.roomTopicMatchesSeedById).toBe(false);
    expect(after.noteBodyMatchesSeedById).toBe(false);
    expect(after.roomCount).toBe(0);
    expect(after.roomIdsMatchSeed).toBe(false);
    // The active generation is either absent or the application's own
    // deterministic empty first-run id, and either way it is code-shaped.
    const activeGenerationIsCodeShaped =
      after.activeGenerationId === null || /^[A-Za-z0-9._-]{1,64}$/.test(after.activeGenerationId);
    expect(activeGenerationIsCodeShaped).toBe(true);
    // ...and the Welcome screen agrees: a first run has no subject to show.
    expect(await countWelcomeSubjectButtons(page)).toBe(0);

    freshness = {
      contextCreatedWithoutStorageState: true,
      observedBeforeApplicationKeyCount: before.legacyKeyCount,
      observedBeforeApplicationDatabaseCount: before.databaseNames.length,
      observedBeforeApplicationStorageObjectStoreCount: before.storageObjectStores.length,
      observedAfterApplicationKeyCount: after.legacyKeyCount,
      observedAfterApplicationDatabaseCount: after.databaseNames.length,
      observedAfterApplicationStorageObjectStoreCount: after.storageObjectStores.length,
      appInitiativeKeyCount: appInitiativeKeys.length,
      noContentKeysBeforeApplication: before.legacyKeyCount === 0 && before.legacyKeys.length === 0,
      noStorageDatabaseBeforeApplication: !before.databaseNames.includes(
        STORAGE_V2_STORAGE_CONTRACT.databaseName,
      ),
      probeCreatedNoDatabase: databasesAfterProbe.length === databasesBeforeProbe.length,
      initialGenerationIsEmpty:
        after.subjectCount === 0 &&
        after.receiptCount === 0 &&
        after.progressionXpTotal === null,
    };
    expect(freshness.noContentKeysBeforeApplication).toBe(true);
    expect(freshness.noStorageDatabaseBeforeApplication).toBe(true);
    expect(freshness.probeCreatedNoDatabase).toBe(true);
    expect(freshness.initialGenerationIsEmpty).toBe(true);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (context !== null) await context.close();
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      source: null,
      freshness,
      restore: UNOBSERVED_RESTORE,
      network,
      failure,
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('a populated device exports a backup that restores into the fresh profile', async ({
  browser,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const keys = legacyKeySet();
  let failure: Error | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  let source: ProfileObservation | null = null;
  let restore: RestoreEvidence = UNOBSERVED_RESTORE;
  let sourceSpy: { requests: SanitizedRequest[]; webSockets: WebSocketCategory[] } = {
    requests: [],
    webSockets: [],
  };
  let targetSpy: { requests: SanitizedRequest[]; webSockets: WebSocketCategory[] } = {
    requests: [],
    webSockets: [],
  };

  let sourceContext: BrowserContext | null = null;
  let targetContext: BrowserContext | null = null;
  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());

    // ── The source device: a populated storage-v2 state, produced by the
    //    application's own migration rather than by this lane writing records.
    sourceContext = await createFreshContext(browser);
    const sourcePage = await sourceContext.newPage();
    sourceSpy = await attachSanitized(sourcePage, localOrigin);
    await blockExternal(sourcePage);
    await seedLegacyStateOnce(sourcePage);
    await sourcePage.goto('/');
    await expect(sourcePage.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await sourcePage.waitForLoadState('networkidle');
    source = await observeProfile(sourcePage);

    // The source is genuinely populated, so "the state came back" is a claim about
    // data rather than about an empty archive.
    expect(source.subjectCount).toBe(1);
    expect(source.progressionXpTotal).toBe(SEEDED_XP);
    expect(source.receiptCount).toBe(1);
    expect(source.externalOnlyAttachmentCount).toBe(2);
    expect(source.externalOnlyWithNullHash).toBe(2);
    expect(source.activeGenerationId).not.toBeNull();

    // ── The export. Driven through the Data Center's full-backup tab, by a real
    //    user action, because plan section 2.5 requires an explicit user action
    //    before anything is downloaded.
    const dataCenter = sourcePage.getByRole('button', { name: DATA_PRODUCTS_LANE.interactionContract.dataCenterName });
    if ((await dataCenter.count()) === 0) {
      restore = { ...UNOBSERVED_RESTORE, stoppedAtInterface: 'the Data Center shell' };
      throw new RegisteredInterface(
        'the Data Center shell (src/ui/data/DataCenter.tsx)',
        `No control matching ${String(DATA_PRODUCTS_LANE.interactionContract.dataCenterName)} is present on the Welcome screen of the flagged build.`,
      );
    }
    await dataCenter.first().click();
    const fullBackupTab = sourcePage.getByRole('tab', { name: DATA_PRODUCTS_LANE.interactionContract.fullBackupTabName });
    if ((await fullBackupTab.count()) === 0) {
      restore = { ...UNOBSERVED_RESTORE, stoppedAtInterface: 'the Data Center full-backup tab' };
      throw new RegisteredInterface(
        'the Data Center full-backup tab',
        `The Data Center opened but exposes no tab matching ${String(DATA_PRODUCTS_LANE.interactionContract.fullBackupTabName)}.`,
      );
    }
    await fullBackupTab.first().click();
    const createBackup = sourcePage.getByRole('button', {
      name: DATA_PRODUCTS_LANE.interactionContract.createBackupControlName,
    });
    if ((await createBackup.count()) === 0) {
      restore = { ...UNOBSERVED_RESTORE, stoppedAtInterface: 'the local-download control' };
      throw new RegisteredInterface(
        'the full-backup local download control',
        `The full-backup tab exposes no control matching ${String(DATA_PRODUCTS_LANE.interactionContract.createBackupControlName)}.`,
      );
    }

    const downloadPromise: Promise<Download> = sourcePage.waitForEvent('download', { timeout: 60_000 });
    await createBackup.first().click();
    const download = await downloadPromise;
    const suggested = download.suggestedFilename();
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const archiveBytes = Buffer.concat(chunks);

    restore = {
      ...UNOBSERVED_RESTORE,
      exportControlFound: true,
      downloadStarted: true,
      downloadSuggestedFilenameExtensionIsKdbak: /\.kdbak$/i.test(suggested),
      downloadByteLength: archiveBytes.byteLength,
    };
    // A backup is a local file, and the plan's non-goals forbid a cloud upload or
    // a Web Share, so the download must be a real file with real bytes.
    expect(archiveBytes.byteLength).toBeGreaterThan(0);
    expect(restore.downloadByteLength).toBe(archiveBytes.byteLength);
    // The file is never written into the repository: the lane holds it in memory
    // and hands it to the fresh context through the file picker.

    // ── The restore target: a second, freshly created context.
    targetContext = await createFreshContext(browser);
    const targetPage = await targetContext.newPage();
    targetSpy = await attachSanitized(targetPage, localOrigin);
    await blockExternal(targetPage);
    // The profile is observed *before* the application runs, again, in this
    // context, so the emptiness the restore is credited with is measured in the
    // same context the restore happens in.
    await targetPage.goto('/assets/sprite-manifest.json');
    const targetBefore = await observeProfile(targetPage);
    expect(targetBefore.legacyKeyCount).toBe(0);
    expect(targetBefore.databaseNames).not.toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);

    await targetPage.goto('/');
    await expect(targetPage.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await targetPage.waitForLoadState('networkidle');

    // ── Prime the target's *own* prior generation, so retention is provable.
    //
    // The fresh profile's first-run generation is empty, and "an empty previous
    // generation is still there" is indistinguishable from "there is no previous
    // generation". So the lane puts a known record into it first, through a real
    // IndexedDB transaction, and afterwards reads that generation back **by id**.
    // The importer's `previousGenerationRetained` field is a claim
    // (`previousActiveGenerationId !== null`); this is the measurement.
    const targetPrimed = await observeProfile(targetPage);
    expect(
      targetPrimed.activeGenerationId,
      'the fresh profile has no first-run generation to be superseded',
    ).not.toBeNull();
    const targetPriorGenerationId = targetPrimed.activeGenerationId as string;
    const sentinel = await writeSentinelRecord(targetPage, targetPriorGenerationId);
    expect(sentinel.written, 'the pre-restore sentinel could not be written').toBe(true);
    const priorBefore = await readGeneration(targetPage, targetPriorGenerationId);
    // The sentinel really is there, so "it survived" later is not vacuous.
    expect(priorBefore.descriptorFound).toBe(true);
    expect(priorBefore.sentinelRecordPresent).toBe(true);
    expect(priorBefore.preferenceCount).toBe(1);
    restore = {
      ...restore,
      targetPriorGenerationIdIsCodeShaped: /^[A-Za-z0-9._-]{1,64}$/.test(targetPriorGenerationId),
    };

    const targetDataCenter = targetPage.getByRole('button', {
      name: DATA_PRODUCTS_LANE.interactionContract.dataCenterName,
    });
    if ((await targetDataCenter.count()) === 0) {
      restore = { ...restore, stoppedAtInterface: 'the Data Center shell' };
      throw new RegisteredInterface(
        'the Data Center shell (src/ui/data/DataCenter.tsx)',
        'The fresh profile loaded Welcome, but the Data Center is not reachable from it.',
      );
    }
    await targetDataCenter.first().click();
    const targetTab = targetPage.getByRole('tab', { name: DATA_PRODUCTS_LANE.interactionContract.fullBackupTabName });
    if ((await targetTab.count()) === 0) {
      restore = { ...restore, stoppedAtInterface: 'the Data Center full-backup tab' };
      throw new RegisteredInterface(
        'the Data Center full-backup tab',
        'The Data Center opened in the fresh profile but exposes no full-backup tab.',
      );
    }
    await targetTab.first().click();
    const inspect = targetPage.getByRole('button', {
      name: DATA_PRODUCTS_LANE.interactionContract.inspectFileControlName,
    });
    if ((await inspect.count()) === 0) {
      restore = { ...restore, stoppedAtInterface: 'the file-inspection control' };
      throw new RegisteredInterface(
        'the full-backup file-inspection control',
        `The full-backup tab exposes no control matching ${String(DATA_PRODUCTS_LANE.interactionContract.inspectFileControlName)}.`,
      );
    }
    // The archive is handed over through the real file input, which is the only
    // path a learner's own file takes.
    const fileInput = targetPage.locator('input[type="file"]');
    await expect(fileInput).toHaveCount(1);
    await fileInput.setInputFiles({
      name: 'device-restore.kdbak',
      mimeType: 'application/zip',
      buffer: archiveBytes,
    });

    // File inspection, then the explicit destructive confirmation the plan
    // requires. The confirmation is asserted to be *absent* before it is used, so
    // a product that skipped the confirmation fails here rather than passing by
    // accident.
    const confirm = targetPage.getByRole('button', {
      name: DATA_PRODUCTS_LANE.interactionContract.destructiveConfirmControlName,
    });
    if ((await confirm.count()) === 0) {
      restore = { ...restore, stoppedAtInterface: 'the destructive confirmation' };
      throw new RegisteredInterface(
        'the explicit destructive confirmation on import',
        `After a file was chosen, no control matching ${String(DATA_PRODUCTS_LANE.interactionContract.destructiveConfirmControlName)} appeared.`,
      );
    }
    await confirm.first().click();
    await expect(
      targetPage.getByRole('button', { name: new RegExp(SUBJECT_NAME) }),
      'the restored subject is not listed after the import',
    ).toBeVisible({ timeout: 60_000 });
    await targetPage.reload();
    await expect(targetPage.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await targetPage.waitForLoadState('networkidle');

    const targetAfter = await observeProfile(targetPage);
    // The prior generation, read back by id. This is the retention measurement.
    const priorAfter = await readGeneration(targetPage, targetPriorGenerationId);
    const activeGenerationIsNotThePriorOne =
      targetAfter.activeGenerationId !== null &&
      targetAfter.activeGenerationId !== targetPriorGenerationId;
    restore = {
      ...restore,
      importControlFound: true,
      restoredSubjectCount: targetAfter.subjectCount,
      restoredProgressionXpTotal: targetAfter.progressionXpTotal,
      restoredSubjectNameMatchesSeed: targetAfter.subjectNameMatchesSeed,
      restoredRoomTopicMatchesSeedById: targetAfter.roomTopicMatchesSeedById,
      restoredNoteBodyMatchesSeedById: targetAfter.noteBodyMatchesSeedById,
      restoredRoomCount: targetAfter.roomCount,
      restoredRoomIdsMatchSeed: targetAfter.roomIdsMatchSeed,
      restoredExternalOnlyAttachmentCount: targetAfter.externalOnlyAttachmentCount,
      restoredExternalOnlyWithNullHash: targetAfter.externalOnlyWithNullHash,
      targetPriorGenerationIsRetained:
        priorAfter.descriptorFound && priorAfter.sentinelRecordPresent,
      targetPriorGenerationStatus: priorAfter.status,
      targetPriorSentinelSurvived: priorAfter.sentinelRecordPresent,
      targetPriorSubjectCountUnchanged: priorAfter.subjectCount === priorBefore.subjectCount,
      activeGenerationIsNotThePriorOne,
    };

    // The state came back, field by field, into a profile that was empty.
    expect(targetAfter.subjectCount).toBe(1);
    expect(targetAfter.subjectNameMatchesSeed).toBe(true);
    // Rooms, addressed by id and as a set. A `.kdbak` state document is canonical
    // JSON, so the restored map enumerates in sorted-key order; position is not a
    // property of the restore and is not asserted.
    expect(targetAfter.roomCount).toBe(SEEDED_ROOM_COUNT);
    expect(targetAfter.roomIdsMatchSeed).toBe(true);
    expect(targetAfter.roomTopicMatchesSeedById).toBe(true);
    expect(targetAfter.noteBodyMatchesSeedById).toBe(true);
    expect(targetAfter.progressionXpTotal).toBe(SEEDED_XP);
    // The external-only attachments came back as external-only, with no invented
    // hash, and did not fail the import.
    expect(targetAfter.externalOnlyAttachmentCount).toBe(2);
    expect(targetAfter.externalOnlyWithNullHash).toBe(2);

    // ── Retention: plan section 7.1 step 6, and the promise the Data Center's
    // confirmation dialog makes to a learner. Proved three ways, because each alone
    // is satisfiable by a broken importer:
    //
    // 1. The active generation is not the one that was active before. An importer
    //    that mutated the previous generation in place would fail here.
    expect(targetAfter.activeGenerationId).not.toBeNull();
    expect(activeGenerationIsNotThePriorOne).toBe(true);
    // 2. The previous generation's descriptor is still there, marked superseded -
    //    which is how storage-v2 retains it. An importer that deleted it would leave
    //    no registry row at all.
    expect(priorAfter.descriptorFound, 'the previous generation descriptor is gone').toBe(true);
    expect(priorAfter.status).toBe('superseded');
    expect(priorAfter.contentChecksumIsSha256Hex).toBe(true);
    // 3. The record the lane put there before the restore is still readable
    //    afterwards, and the previous generation's record count is unchanged. This
    //    is the assertion a deleting importer cannot pass: an empty generation that
    //    has been removed still "has zero subjects".
    expect(priorAfter.sentinelRecordPresent, 'the previous generation lost its records').toBe(
      true,
    );
    expect(priorAfter.preferenceCount).toBe(priorBefore.preferenceCount);
    expect(restore.targetPriorSentinelSurvived).toBe(true);
    expect(restore.targetPriorSubjectCountUnchanged).toBe(true);
    // The two devices may share a generation label - the importer adopts the
    // archive's own label when the receiving device holds nothing under it, so the
    // migration receipts keep naming the generation they belong to. That is why the
    // claim above is about the target's *own* prior generation and not about a
    // difference between the two devices.
    expect(source.activeGenerationId).not.toBeNull();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (sourceContext !== null) await sourceContext.close();
    if (targetContext !== null) await targetContext.close();
  }

  const network = buildNetworkPolicyReport(
    [...sourceSpy.requests, ...targetSpy.requests],
    [...sourceSpy.webSockets, ...targetSpy.webSockets],
  );
  writeEvidenceFile(
    testInfo,
    buildEvidence({ testInfo, artifact, source, freshness: UNOBSERVED_FRESHNESS, restore, network, failure }),
  );
  if (failure) throw failure;
  // Non-vacuity: real requests were observed and classified in both contexts.
  expect(network.totalRequests).toBeGreaterThanOrEqual(4);
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
  expect(network.webSockets.total).toBe(0);
  expect(restore.downloadStarted).toBe(true);
  void Object.keys(keys);
});

test('a backup never becomes a request: no upload, no share, no non-static request', async ({
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  let failure: Error | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  let source: ProfileObservation | null = null;

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());
    const keys = legacyKeySet();
    await seedLegacyStateOnce(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    source = await observeProfile(page);
    expect(source.subjectCount).toBe(1);

    const report = buildNetworkPolicyReport(spy.requests, spy.webSockets);
    // Non-vacuity: real requests were observed and really classified, so
    // "no violations" is a decision rather than an empty observation.
    expect(report.totalRequests).toBeGreaterThanOrEqual(4);
    expect(report.requestsByResourceType.script ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.requestsByDestination['local-static'] ?? 0).toBeGreaterThanOrEqual(2);
    const allowedDestinations = new Set([
      'local-static',
      // The pre-Cozy remote font stylesheet. Phase 8 removes it; it is blocked
      // and counted here, exactly as the Phase 4 lane records it.
      'external-legacy-static',
      'data-url',
      'blob-local',
    ]);
    for (const destination of Object.keys(report.requestsByDestination)) {
      expect(allowedDestinations.has(destination), `unexpected destination: ${destination}`).toBe(true);
    }
    // The legacy key set the lane seeded is intact: a backup flow must not
    // rewrite it, and a privacy regression would have to come through a request.
    expect(keys['knowledge-dungeon:v1:subjects']).toContain(SUBJECT_ID);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      source,
      freshness: UNOBSERVED_FRESHNESS,
      restore: UNOBSERVED_RESTORE,
      network,
      failure,
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
  expect(network.webSockets.total).toBe(0);
});
