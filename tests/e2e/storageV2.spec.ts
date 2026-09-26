import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';

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

/**
 * Phase 4 storage-v2 browser lane.
 *
 * This suite runs against a build produced with `VITE_STORAGE_REPOSITORY=v2`
 * and is the only automated evidence in the plan that observes storage-v2 in a
 * real browser rather than in `fake-indexeddb` under jsdom. That is the gap the
 * Phase 3 evidence section recorded: real IndexedDB transaction semantics, a
 * real legacy migration, a real device-local attachment, and durability across a
 * reload were all unverified.
 *
 * What it proves, in five tests:
 *
 * 1. The lane exercised the artifact it claims to: the recorded identity of the
 *    flagged build, the served entrypoint bytes, and the build flag itself.
 * 2. A realistic synthetic legacy key set - subject index, subject, v3
 *    progression, preferences, shortcuts, sessions, a historical
 *    `/uploads/`-referenced attachment with no recoverable bytes, and an
 *    external attachment URL - migrates into real browser IndexedDB, hydrates in
 *    the UI, and loses nothing.
 * 3. A second load does not duplicate the migration: one active generation, one
 *    receipt, and unchanged record counts.
 * 4. A device-local image attachment written into the active generation is still
 *    byte-identical, with a matching SHA-256 content hash, after a full reload.
 * 5. The whole flow makes no upload request, no application-endpoint request, no
 *    external request, and no non-static request.
 *
 * The network spy is the same bounded reduction the compatibility suite uses, so
 * nothing in a failure message or an evidence file can carry a URL, a header, a
 * body, or a credential.
 *
 * Scope and honesty notes:
 *
 * - The lane does NOT drive the note editor's file picker. Reaching it means
 *   playing the Phaser tutorial to a room, which the Phase 1 suite deliberately
 *   does not do. The device-local attachment is therefore written through the
 *   storage contract the application itself writes, in a real browser
 *   transaction, and its durability and hash are asserted. The user-facing
 *   picker path stays a manual check in the Phase 4 plan and is covered at unit
 *   level by `tests/privacy/attachmentBytes.test.ts`.
 * - The seeded values are synthetic and self-describing. The only host is the
 *   reserved `example.invalid`, and it is never dereferenced: the route guard
 *   aborts any non-loopback request before it can leave the browser, and the
 *   attempt would still be recorded as a violation.
 * - Written evidence contains counts, categories, and booleans only. No subject
 *   name, room topic, note, filename, URL, request body, header, or credential
 *   is written to disk.
 */

const REPO_ROOT = process.cwd();
const MANIFEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-artifact-manifest.mjs');
const ENV_FILE = path.join(REPO_ROOT, STORAGE_V2_LANE.envFile);
const SUBJECT_FIXTURE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'persistence',
  'subject',
  'subject-1.1.0-full-unknown-fields.json',
);
const FALLBACK_PREVIEW_ORIGIN = 'http://127.0.0.1:43173';
const IS_CI = Boolean(process.env.CI);
const RUN_ID = sanitizeRunId(process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid));
const RUN_STARTED_AT = new Date().toISOString();
const HOST_EXECUTION: HostExecution = IS_CI ? 'ci' : 'local-host';
const RUNNER_IMAGE = {
  os: sanitizeRunnerImageLabel(process.env.ImageOS),
  version: sanitizeRunnerImageLabel(process.env.ImageVersion),
};

// ── Synthetic fixture values ───────────────────────────────────────────────

const SUBJECT_ID = 'subject-lane-synthetic';
const SUBJECT_NAME = 'Storage Lane Synthetic Subject';
const ROOM_ID = 'room-lane-synthetic-root';
const ROOM_TOPIC = 'Storage Lane Synthetic Root Topic';
const NOTE_BODY = 'Storage lane synthetic note body.';
const EXTERNAL_ATTACHMENT_URL = 'https://example.invalid/storage-lane-synthetic.png';
const LOCAL_ATTACHMENT_ID = 'att-lane-synthetic-local';
const EXTERNAL_ATTACHMENT_ID = 'att-lane-synthetic-external';
const DEVICE_LOCAL_ATTACHMENT_ID = 'att-lane-synthetic-device-local';
const SEEDED_XP = 17;

/** The storage-v2 object store list, exactly as plan section 7.1 declares it. */
const EXPECTED_OBJECT_STORES: readonly string[] = [
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
];

/** A complete, valid 1x1 PNG written out byte by byte: synthetic and self-describing. */
const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

const SYNTHETIC_PNG_SHA256 = createHash('sha256').update(Buffer.from(SYNTHETIC_PNG)).digest('hex');

/**
 * The realistic legacy key set. Every value is synthetic; the shapes match what
 * the current application actually writes, so a migration sees real data rather
 * than a shape it was written against.
 */
function legacyKeySet(): Record<string, string> {
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
  // The room is renamed *consistently*. The real application writes a room's
  // `roomId`, the `rooms` map key, the dungeon's room list, root pointer, edges,
  // and tag index together; renaming only the room's own field produces a subject
  // the shared validator rejects (`room-id-mismatch`, `missing-room-payload`),
  // which no implementation can migrate with "no data loss". Every identifier the
  // rename touches is updated here, in place and without reordering the map, so
  // the seeded device holds a structurally valid subject.
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
      // A historical `/uploads/` reference: the legacy web build posted the file
      // and kept only a relative path, so these bytes are not recoverable.
      attachmentId: LOCAL_ATTACHMENT_ID,
      sourceType: 'local',
      fileName: 'storage-lane-synthetic-uploaded.png',
      mimeType: 'image/png',
      relativePath: 'uploads/storage-lane-synthetic-uploaded.png',
      altText: 'storage lane synthetic uploaded alt',
      addedAt: '2026-01-04T03:04:05.000Z',
    },
    {
      // A user-supplied external URL. Never fetched, never backed up.
      attachmentId: EXTERNAL_ATTACHMENT_ID,
      sourceType: 'external',
      fileName: 'storage-lane-synthetic-external.png',
      mimeType: 'image/png',
      externalUrl: EXTERNAL_ATTACHMENT_URL,
      altText: 'storage lane synthetic external alt',
      addedAt: '2026-01-04T03:04:05.000Z',
    },
  ];

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
        sessionId: 'session-lane-synthetic',
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
  /** `null` when this test did not fetch the entrypoint itself. */
  readonly servedEntrypointMatchesRecorded: boolean | null;
  readonly servedStatus: number;
  readonly buildNode: string | null;
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
};

/** Verifies `dist` against the lane's OWN recorded identity, never the default one. */
function verifyRecordedFlaggedArtifact(): ManifestVerification {
  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [
        MANIFEST_SCRIPT,
        'verify',
        `--manifest=${path.join(REPO_ROOT, STORAGE_V2_LANE.manifestPath)}`,
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
      'Run "npm run test:e2e:storage" rather than previewing a different build.',
  ).toBe('match');
  return verification;
}

function readRecordedManifest(): RecordedManifest {
  const manifestPath = path.join(REPO_ROOT, STORAGE_V2_LANE.manifestPath);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No recorded flagged-artifact identity at ${STORAGE_V2_LANE.manifestPath}. ` +
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
  };
}

// ── Network spy ────────────────────────────────────────────────────────────

function observeSanitized(request: Request, localOrigin: string | null): SanitizedRequest {
  return classifyRequestLike(
    { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType() },
    localOrigin,
  );
}

async function attachSanitized(page: Page, localOrigin: string | null): Promise<{
  requests: SanitizedRequest[];
  webSockets: WebSocketCategory[];
}> {
  const requests: SanitizedRequest[] = [];
  const webSockets: WebSocketCategory[] = [];
  page.on('request', (request) => requests.push(observeSanitized(request, localOrigin)));
  await page.routeWebSocket(() => true, (webSocket) => {
    webSockets.push(classifyWebSocketLike(webSocket.url(), localOrigin));
  });
  return { requests, webSockets };
}

test.beforeEach(async ({ page }) => {
  // Keep every context offline: a privacy regression is still observed and
  // recorded, but no external request can leave the test browser.
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
});

// ── Seeding and probing ────────────────────────────────────────────────────

/**
 * Seeds the synthetic legacy key set exactly once per browser context, before
 * any application code runs. A later reload in the same test sees the same keys,
 * which is what "the legacy generation is still there" has to mean.
 */
async function seedLegacyStateOnce(page: Page): Promise<void> {
  await page.addInitScript(
    (keys: Record<string, string>) => {
      if (window.localStorage.getItem('kd-lane-seeded') === '1') return;
      for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
      window.localStorage.setItem('kd-lane-seeded', '1');
    },
    legacyKeySet(),
  );
}

interface StorageProbeResult {
  readonly databasePresent: boolean;
  /** Object stores the browser database actually has. */
  readonly objectStoreNames: readonly string[];
  readonly schemaVersion: number;
  readonly activeGenerationId: string | null;
  readonly generationRegistryIds: readonly string[];
  readonly storeCounts: Readonly<Record<string, number>>;
  readonly receiptCount: number;
  readonly receiptStatuses: readonly string[];
  readonly subject: {
    readonly subjectName: string;
    readonly roomTopic: string;
    readonly noteText: string;
    readonly attachmentIds: readonly string[];
  } | null;
  readonly progressionXpTotals: readonly number[];
  readonly attachments: readonly {
    readonly attachmentId: string;
    readonly availability: string;
    readonly contentHash: string | null;
    readonly byteLength: number | null;
    readonly contentHashMatchesBytes: boolean | null;
  }[];
  readonly legacyKeyCount: number;
  readonly legacySubjectJson: string | null;
}

/** Reads the storage-v2 database out of the live page. Never writes. */
async function probeStorage(page: Page): Promise<StorageProbeResult> {
  return page.evaluate(
    async (contract): Promise<StorageProbeResult> => {
      const openDatabase = (): Promise<IDBDatabase | null> =>
        new Promise((resolve) => {
          let request: IDBOpenDBRequest;
          try {
            request = indexedDB.open(contract.databaseName);
          } catch {
            resolve(null);
            return;
          }
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });

      const empty: StorageProbeResult = {
        databasePresent: false,
        objectStoreNames: [],
        schemaVersion: 0,
        activeGenerationId: null,
        generationRegistryIds: [],
        storeCounts: {},
        receiptCount: 0,
        receiptStatuses: [],
        subject: null,
        progressionXpTotals: [],
        attachments: [],
        legacyKeyCount: window.localStorage.length,
        legacySubjectJson: window.localStorage.getItem(
          `knowledge-dungeon:v1:subject:${contract.seededSubjectId}`,
        ),
      };

      const db = await openDatabase();
      if (!db) return empty;

      // `indexedDB.open` CREATES an empty, store-less database when none exists,
      // so "a database exists" proves nothing. The object stores and the schema
      // version are what prove the application actually opened storage-v2.
      const objectStoreNames = [...db.objectStoreNames].sort();
      const schemaVersion = db.version;

      const readAll = <T,>(storeName: string, generationId: string | null): Promise<T[]> =>
        new Promise((resolve) => {
          try {
            const store = db.transaction(storeName, 'readonly').objectStore(storeName);
            const source =
              generationId && store.indexNames.contains(contract.generationScopeIndex)
                ? store.index(contract.generationScopeIndex).getAll(IDBKeyRange.only(generationId))
                : store.getAll();
            source.onsuccess = () => resolve((source.result ?? []) as T[]);
            source.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        });

      // The `meta` store is keyed by `[generationId, recordId]`, so the
      // active-generation pointer is reached through its unique `byKey` index -
      // an out-of-line `get` would throw here.
      const pointer = await new Promise<{ activeGeneration: string | null } | null>((resolve) => {
        try {
          const store = db.transaction(contract.metaStore, 'readonly').objectStore(contract.metaStore);
          const request = store.index('byKey').get(contract.activeGenerationKey);
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

      const metaEntries = await new Promise<{ recordId: string }[]>((resolve) => {
        try {
          const request = db.transaction(contract.metaStore, 'readonly').objectStore(contract.metaStore).getAll();
          request.onsuccess = () => resolve((request.result ?? []) as { recordId: string }[]);
          request.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
      const generationRegistryIds = metaEntries
        .filter((entry) => entry.recordId.startsWith(contract.generationKeyPrefix))
        .map((entry) => entry.recordId.slice(contract.generationKeyPrefix.length));

      const storeNames = [
        contract.subjectsStore,
        contract.progressionStore,
        contract.sessionsStore,
        contract.preferencesStore,
        contract.shortcutsStore,
        contract.attachmentsStore,
        contract.migrationReceiptsStore,
      ];
      const storeCounts: Record<string, number> = {};
      for (const storeName of storeNames) {
        storeCounts[storeName] = (await readAll(storeName, activeGenerationId)).length;
      }

      const subjectRecords = await readAll<{ recordId: string; value: Record<string, unknown> }>(
        contract.subjectsStore,
        activeGenerationId,
      );
      let subject: StorageProbeResult['subject'] = null;
      if (subjectRecords.length > 0) {
        const value = subjectRecords[0]?.value ?? {};
        const snapshot = (value.snapshot ?? {}) as {
          dungeon?: { subjectName?: string };
          rooms?: Record<
            string,
            { topic?: string; noteText?: string; attachments?: { attachmentId: string }[] }
          >;
        };
        const firstRoom = Object.values(snapshot.rooms ?? {})[0];
        subject = {
          subjectName: snapshot.dungeon?.subjectName ?? '',
          roomTopic: firstRoom?.topic ?? '',
          noteText: firstRoom?.noteText ?? '',
          attachmentIds: (firstRoom?.attachments ?? []).map((entry) => entry.attachmentId).sort(),
        };
      }

      const progressionRecords = await readAll<{
        value: { bySubject?: Record<string, { xpTotal?: number }> };
      }>(contract.progressionStore, activeGenerationId);
      const progressionXpTotals: number[] = [];
      for (const record of progressionRecords) {
        for (const perSubject of Object.values(record.value.bySubject ?? {})) {
          if (typeof perSubject.xpTotal === 'number') progressionXpTotals.push(perSubject.xpTotal);
        }
      }

      const attachmentRecords = await readAll<{ recordId: string; value: Record<string, unknown> }>(
        contract.attachmentsStore,
        activeGenerationId,
      );
      const digest = async (bytes: Uint8Array): Promise<string> => {
        const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };

      type AttachmentEntry = {
        attachmentId: string;
        availability: string;
        contentHash: string | null;
        byteLength: number | null;
        contentHashMatchesBytes: boolean | null;
      };
      const attachments: AttachmentEntry[] = [];
      for (const record of attachmentRecords) {
        const value = record.value as {
          attachmentId?: string;
          availability?: string;
          contentHash?: string | null;
          byteLength?: number | null;
          bytes?: ArrayBuffer;
        };
        const isBlob = record.recordId.startsWith(contract.attachmentBlobPrefix);
        attachments.push({
          attachmentId: isBlob
            ? record.recordId.slice(contract.attachmentBlobPrefix.length)
            : (value.attachmentId ?? ''),
          availability: isBlob ? 'stored' : (value.availability ?? ''),
          contentHash: value.contentHash ?? null,
          byteLength: value.byteLength ?? null,
          contentHashMatchesBytes:
            isBlob && value.bytes instanceof ArrayBuffer
              ? (await digest(new Uint8Array(value.bytes))) === value.contentHash
              : null,
        });
      }
      attachments.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));

      const receipts = await readAll<{ value: { status?: string } }>(
        contract.migrationReceiptsStore,
        activeGenerationId,
      );
      db.close();

      return {
        databasePresent: true,
        objectStoreNames,
        schemaVersion,
        activeGenerationId,
        generationRegistryIds: generationRegistryIds.sort(),
        storeCounts,
        receiptCount: receipts.length,
        receiptStatuses: receipts.map((receipt) => receipt.value.status ?? 'unknown').sort(),
        subject,
        progressionXpTotals: progressionXpTotals.sort((left, right) => left - right),
        attachments,
        legacyKeyCount: window.localStorage.length,
        legacySubjectJson: window.localStorage.getItem(
          `knowledge-dungeon:v1:subject:${contract.seededSubjectId}`,
        ),
      };
    },
    { ...STORAGE_V2_STORAGE_CONTRACT, seededSubjectId: SUBJECT_ID },
  );
}

/** Writes a device-local attachment into the active generation, in the page. */
async function writeDeviceLocalAttachment(
  page: Page,
  generationId: string,
  attachmentId: string,
  payload: readonly number[],
): Promise<{ readonly contentHash: string; readonly byteLength: number }> {
  return page.evaluate(
    async (input): Promise<{ contentHash: string; byteLength: number }> => {
      const bytes = new Uint8Array(input.payload);
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
      const contentHash = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      const updatedAt = new Date().toISOString();

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(input.contract.databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('open-failed'));
      });

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(input.contract.attachmentsStore, 'readwrite');
        const store = transaction.objectStore(input.contract.attachmentsStore);
        store.put({
          generationId: input.generationId,
          recordId: `${input.contract.attachmentBlobPrefix}${input.attachmentId}`,
          value: {
            attachmentId: input.attachmentId,
            contentHash,
            bytes: bytes.buffer,
            byteLength: bytes.length,
            storedAt: updatedAt,
          },
          checksum: null,
          updatedAt,
        });
        store.put({
          generationId: input.generationId,
          recordId: `${input.contract.attachmentMetadataPrefix}${input.attachmentId}`,
          value: {
            attachmentId: input.attachmentId,
            subjectId: input.subjectId,
            roomId: input.roomId,
            sourceType: 'local',
            mimeType: 'image/png',
            availability: 'stored',
            contentHash,
            fileName: 'storage-lane-synthetic-device-local.png',
            altText: 'storage lane synthetic device-local alt',
            addedAt: updatedAt,
          },
          checksum: null,
          updatedAt,
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('transaction-failed'));
        transaction.onabort = () => reject(new Error('transaction-aborted'));
      });
      db.close();
      return { contentHash, byteLength: bytes.length };
    },
    {
      contract: STORAGE_V2_STORAGE_CONTRACT,
      generationId,
      attachmentId,
      payload,
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
    },
  );
}

/** Byte-level comparison of the stored attachment against the original payload. */
async function readDeviceLocalAttachmentBytes(
  page: Page,
  generationId: string,
  attachmentId: string,
): Promise<number[]> {
  return page.evaluate(
    async (input): Promise<number[]> => {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open(input.contract.databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (!db) return [];
      const record = await new Promise<{ value?: { bytes?: ArrayBuffer } } | null>((resolve) => {
        try {
          const request = db
            .transaction(input.contract.attachmentsStore, 'readonly')
            .objectStore(input.contract.attachmentsStore)
            .get([input.generationId, `${input.contract.attachmentBlobPrefix}${input.attachmentId}`]);
          request.onsuccess = () =>
            resolve((request.result ?? null) as { value?: { bytes?: ArrayBuffer } } | null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      db.close();
      if (!record?.value?.bytes) return [];
      return [...new Uint8Array(record.value.bytes)];
    },
    { contract: STORAGE_V2_STORAGE_CONTRACT, generationId, attachmentId },
  );
}

// ── Evidence ───────────────────────────────────────────────────────────────

interface DeviceLocalEvidence {
  readonly observed: boolean;
  readonly bytesIdentical: boolean;
  readonly contentHashMatches: boolean;
  readonly expectedSha256HexShape: boolean;
}

const UNOBSERVED_DEVICE_LOCAL: DeviceLocalEvidence = {
  observed: false,
  bytesIdentical: false,
  contentHashMatches: false,
  expectedSha256HexShape: false,
};

/**
 * What the application's own write path did, as counts and booleans.
 *
 * Declared here, before {@link StorageV2Evidence}, because the evidence record
 * carries it: an observation no evidence file records is an observation the next
 * maintainer has to take on trust.
 */
interface AppWritePathEvidenceShape {
  readonly observed: boolean;
  readonly requestsWhilePicking: number;
  readonly nonStaticRequestsWhilePicking: number;
  readonly appEndpointRequestsInSession: number;
  readonly bytesIdentical: boolean;
  readonly contentHashMatches: boolean;
  readonly durableAcrossReload: boolean;
  readonly mirroredIntoGeneration: boolean;
  readonly toastSaidStoredLocally: boolean;
}

interface StorageV2Evidence {
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
    readonly manifestPath: string;
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
  readonly storage: {
    readonly databasePresent: boolean;
    readonly schemaVersion: number;
    readonly objectStoreCount: number;
    readonly objectStoresMatchContract: boolean;
    readonly activeGenerationIdIsSafeIdentifier: boolean;
    readonly activeGenerationIdLength: number;
    readonly generationRegistryCount: number;
    readonly storeCounts: Readonly<Record<string, number>>;
    readonly receiptCount: number;
    readonly receiptStatuses: readonly string[];
    readonly subjectNameMatchesSeed: boolean;
    readonly roomTopicMatchesSeed: boolean;
    readonly noteBodyMatchesSeed: boolean;
    readonly seededAttachmentIdsPresent: number;
    readonly externalOnlyAttachmentCount: number;
    readonly externalOnlyWithNullHash: number;
    readonly storedAttachmentCount: number;
    readonly progressionContainsSeededXp: boolean;
    readonly legacyKeyCount: number;
    readonly legacySubjectJsonUnchanged: boolean;
  };
  readonly deviceLocalAttachment: DeviceLocalEvidence;
  /**
   * The application's *own* image write path, driven through the real file
   * control. Distinct from `deviceLocalAttachment`, which is a `page.evaluate`
   * write used to prove real-browser durability of the mirror target.
   */
  readonly appWritePath: AppWritePathEvidenceShape;
  readonly network: NetworkPolicyReport;
  readonly failure: { readonly name: string; readonly message: string } | null;
}

/** Only opaque, app-generated identifiers are recorded; anything else is redacted. */
function safeIdentifier(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

function buildEvidence(input: {
  testInfo: TestInfo;
  artifact: ArtifactEvidence;
  probe: StorageProbeResult | null;
  deviceLocal: DeviceLocalEvidence;
  /** Optional: only the test that drives the real file control observes it. */
  appWritePath?: AppWritePathEvidenceShape;
  network: NetworkPolicyReport;
  failure: Error | null;
  seededSubjectJson: string;
}): StorageV2Evidence {
  const probe = input.probe;
  const seededAttachmentIds = [EXTERNAL_ATTACHMENT_ID, LOCAL_ATTACHMENT_ID];
  return {
    schemaVersion: STORAGE_V2_LANE.schemaVersion,
    suite: STORAGE_V2_LANE.suite,
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    hostExecution: HOST_EXECUTION,
    project: STORAGE_V2_LANE.project,
    testTitle: input.testInfo.title,
    lane: {
      buildMode: STORAGE_V2_LANE.buildMode,
      flag: STORAGE_V2_LANE.flag,
      flagValue: STORAGE_V2_LANE.flagValue,
      storageRepository: STORAGE_V2_LANE.storageRepository,
      worldRenderer: STORAGE_V2_LANE.worldRenderer,
      manifestPath: STORAGE_V2_LANE.manifestPath,
      declaredViewport: STORAGE_V2_LANE.viewport,
      evidenceClass: STORAGE_V2_LANE.evidenceClass,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      ci: IS_CI,
      runnerImage: RUNNER_IMAGE,
    },
    artifact: input.artifact,
    storage: {
      databasePresent: probe?.databasePresent ?? false,
      schemaVersion: probe?.schemaVersion ?? 0,
      objectStoreCount: probe?.objectStoreNames.length ?? 0,
      objectStoresMatchContract:
        probe !== null &&
        probe.objectStoreNames.length === EXPECTED_OBJECT_STORES.length &&
        EXPECTED_OBJECT_STORES.every((store) => probe.objectStoreNames.includes(store)),
      activeGenerationIdIsSafeIdentifier: safeIdentifier(probe?.activeGenerationId ?? null) !== null,
      activeGenerationIdLength: probe?.activeGenerationId?.length ?? 0,
      generationRegistryCount: probe?.generationRegistryIds.length ?? 0,
      storeCounts: probe?.storeCounts ?? {},
      receiptCount: probe?.receiptCount ?? 0,
      receiptStatuses: probe?.receiptStatuses ?? [],
      subjectNameMatchesSeed: probe?.subject?.subjectName === SUBJECT_NAME,
      roomTopicMatchesSeed: probe?.subject?.roomTopic === ROOM_TOPIC,
      noteBodyMatchesSeed: probe?.subject?.noteText === NOTE_BODY,
      seededAttachmentIdsPresent: seededAttachmentIds.filter((id) =>
        (probe?.subject?.attachmentIds ?? []).includes(id),
      ).length,
      externalOnlyAttachmentCount: (probe?.attachments ?? []).filter(
        (entry) => entry.availability === 'external-only',
      ).length,
      externalOnlyWithNullHash: (probe?.attachments ?? []).filter(
        (entry) => entry.availability === 'external-only' && entry.contentHash === null,
      ).length,
      storedAttachmentCount: (probe?.attachments ?? []).filter((entry) => entry.availability === 'stored')
        .length,
      progressionContainsSeededXp: (probe?.progressionXpTotals ?? []).includes(SEEDED_XP),
      legacyKeyCount: probe?.legacyKeyCount ?? 0,
      legacySubjectJsonUnchanged: probe?.legacySubjectJson === input.seededSubjectJson,
    },
    deviceLocalAttachment: input.deviceLocal,
    appWritePath: input.appWritePath ?? UNOBSERVED_APP_WRITE_PATH,
    network: input.network,
    failure: input.failure
      ? {
          name: sanitizeToolchainText(input.failure.name) || 'Error',
          message: sanitizeToolchainText(input.failure.message.split('\n')[0] ?? ''),
        }
      : null,
  };
}

function writeEvidenceFile(testInfo: TestInfo, evidence: StorageV2Evidence): void {
  const relativePath = evidenceRelativePath({
    runId: RUN_ID,
    project: evidence.project,
    testTitle: testInfo.title,
  });
  const absolutePath = path.join(REPO_ROOT, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[storage-v2-evidence-file] ${relativePath}`);
}

test.beforeAll(() => {
  console.log(
    `[storage-v2-lane] ${STORAGE_V2_LANE.project} on ${os.platform()}/${os.arch()} node ${process.version} ` +
      `flag ${STORAGE_V2_LANE.flag}=${STORAGE_V2_LANE.flagValue} mode ${STORAGE_V2_LANE.buildMode}`,
  );
});

// ── Tests ──────────────────────────────────────────────────────────────────

test('the flagged artifact and the storage-v2 lane label are recorded', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  let failure: Error | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  try {
    // The build flag is a build-input claim, so it is verified from the file
    // that carries it rather than assumed.
    expect(existsSync(ENV_FILE), `${STORAGE_V2_LANE.envFile} must exist`).toBe(true);
    expect(readFileSync(ENV_FILE, 'utf8')).toMatch(
      new RegExp(`^\\s*${STORAGE_V2_LANE.flag}=${STORAGE_V2_LANE.flagValue}\\s*$`, 'm'),
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
      probe: null,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: '',
    }),
  );
  if (failure) throw failure;
  expect(network.webSockets.total).toBe(0);
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('a synthetic legacy key set migrates into real browser IndexedDB with no data loss', async ({
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let probe: StorageProbeResult | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());

    await page.goto('/');
    // Hydration in the UI: the seeded subject is listed, so the migrated state
    // is not merely stored but actually read back by the application.
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');

    probe = await probeStorage(page);

    // The application really created the storage-v2 schema in this browser.
    // `indexedDB.open` alone would create an empty, store-less database, so the
    // stores and the version are what make this assertion load-bearing.
    expect(probe.databasePresent, 'the storage-v2 database could not be opened').toBe(true);
    expect(probe.schemaVersion).toBe(STORAGE_V2_STORAGE_CONTRACT.schemaVersion);
    expect(probe.objectStoreNames).toEqual([...EXPECTED_OBJECT_STORES].sort());
    // ...with exactly one activated generation...
    expect(probe.activeGenerationId, 'no active storage-v2 generation was activated').not.toBeNull();
    expect(probe.generationRegistryIds).toHaveLength(1);
    // ...holding the migrated subject with no data loss.
    expect(probe.storeCounts.subjects).toBe(1);
    expect(probe.subject?.subjectName).toBe(SUBJECT_NAME);
    expect(probe.subject?.roomTopic).toBe(ROOM_TOPIC);
    expect(probe.subject?.noteText).toBe(NOTE_BODY);
    expect(probe.subject?.attachmentIds).toEqual([EXTERNAL_ATTACHMENT_ID, LOCAL_ATTACHMENT_ID].sort());
    expect(probe.progressionXpTotals).toContain(SEEDED_XP);
    expect(probe.storeCounts.progression).toBeGreaterThanOrEqual(1);
    expect(probe.storeCounts.sessions).toBeGreaterThanOrEqual(1);
    expect(probe.storeCounts.preferences).toBeGreaterThanOrEqual(1);
    expect(probe.storeCounts.shortcuts).toBeGreaterThanOrEqual(1);

    // Exactly one migration receipt, and it is the activated one.
    expect(probe.receiptCount).toBe(1);
    expect(probe.receiptStatuses).toEqual(['activated']);

    // The two historical attachments are external-only with no recoverable
    // bytes: no blob record, and no invented content hash.
    const metadata = probe.attachments.filter((entry) => entry.availability === 'external-only');
    expect(metadata.map((entry) => entry.attachmentId).sort()).toEqual(
      [EXTERNAL_ATTACHMENT_ID, LOCAL_ATTACHMENT_ID].sort(),
    );
    for (const entry of metadata) expect(entry.contentHash).toBeNull();
    expect(probe.attachments.filter((entry) => entry.availability === 'stored')).toEqual([]);

    // The legacy generation is still intact, so a rollback can still read it.
    expect(probe.legacyKeyCount).toBe(Object.keys(keys).length + 1);
    expect(probe.legacySubjectJson).toBe(keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('a second load does not duplicate the migration', async ({ page, baseURL }, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let first: StorageProbeResult | null = null;
  let second: StorageProbeResult | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());

    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    first = await probeStorage(page);
    expect(first.activeGenerationId, 'no active storage-v2 generation was activated').not.toBeNull();

    // A full reload: a new document, a new bootstrap, the same browser storage.
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    second = await probeStorage(page);

    // The migration is not re-staged, the pointer is not re-pointed at a new
    // generation, and no record is duplicated.
    expect(second.activeGenerationId).toBe(first.activeGenerationId);
    expect(second.generationRegistryIds).toEqual(first.generationRegistryIds);
    expect(second.storeCounts).toEqual(first.storeCounts);
    expect(second.receiptCount).toBe(1);
    expect(second.receiptStatuses).toEqual(['activated']);
    expect(second.storeCounts.subjects).toBe(1);
    expect(second.progressionXpTotals).toEqual(first.progressionXpTotals);
    expect(second.subject?.subjectName).toBe(SUBJECT_NAME);
    // The legacy keys were not rewritten by the second load either.
    expect(second.legacyKeyCount).toBe(Object.keys(keys).length + 1);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe: second ?? first,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('a device-local image attachment survives a reload byte for byte', async ({
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let probe: StorageProbeResult | null = null;
  let deviceLocal: DeviceLocalEvidence = UNOBSERVED_DEVICE_LOCAL;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  let generationId: string | null = null;

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());

    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    probe = await probeStorage(page);
    const active = probe.activeGenerationId;
    expect(active, 'no active storage-v2 generation was activated').not.toBeNull();
    if (active === null) throw new Error('no active storage-v2 generation was activated');
    generationId = active;

    // Write the bytes the way the application writes them, in a real IndexedDB
    // read-write transaction, with the page computing the content hash.
    const written = await writeDeviceLocalAttachment(
      page,
      generationId,
      DEVICE_LOCAL_ATTACHMENT_ID,
      SYNTHETIC_PNG,
    );
    expect(written.byteLength).toBe(SYNTHETIC_PNG.length);
    // Node's SHA-256 and the browser's Web Crypto must agree on the same bytes.
    expect(written.contentHash).toBe(SYNTHETIC_PNG_SHA256);

    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    probe = await probeStorage(page);

    if (generationId === null) throw new Error('no active storage-v2 generation was activated');
    const bytes = await readDeviceLocalAttachmentBytes(page, generationId, DEVICE_LOCAL_ATTACHMENT_ID);
    const bytesIdentical =
      bytes.length === SYNTHETIC_PNG.length && bytes.every((byte, index) => byte === SYNTHETIC_PNG[index]);
    const stored = probe.attachments.find(
      (entry) => entry.attachmentId === DEVICE_LOCAL_ATTACHMENT_ID && entry.availability === 'stored',
    );
    const contentHashMatches =
      stored !== undefined && stored.contentHash === SYNTHETIC_PNG_SHA256 && stored.contentHashMatchesBytes === true;

    deviceLocal = {
      observed: true,
      bytesIdentical,
      contentHashMatches,
      expectedSha256HexShape: /^[0-9a-f]{64}$/.test(SYNTHETIC_PNG_SHA256),
    };

    expect(stored, 'the device-local attachment did not survive the reload').toBeDefined();
    expect(bytesIdentical, 'the stored attachment bytes changed across the reload').toBe(true);
    expect(contentHashMatches, 'the stored content hash does not match the stored bytes').toBe(true);
    expect(stored?.byteLength).toBe(SYNTHETIC_PNG.length);
    // The external-only attachments are still honestly external-only.
    for (const entry of probe.attachments) {
      if (entry.attachmentId === DEVICE_LOCAL_ATTACHMENT_ID) continue;
      expect(entry.availability).toBe('external-only');
      expect(entry.contentHash).toBeNull();
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe,
      deviceLocal,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  // A device-local attachment must never become a request. The destinations this
  // asserts on are the ones the policy forbids: the app's own endpoint, any
  // external destination that is not the recorded pre-Cozy remote font, and any
  // non-static request. `blockedExternalCount` is *not* asserted as zero because
  // the pre-Cozy UI still links the Google Fonts stylesheet, and every load of
  // Welcome therefore produces two blocked font requests; that condition is the
  // recorded `external-legacy-static` one this lane already accounts for in the
  // "no non-static request" test below, and Phase 8 removes the dependency. The
  // per-destination counts make the distinction explicit rather than hiding it in
  // a total.
  expect(network.requestsByDestination['local-app-endpoint'] ?? 0).toBe(0);
  expect(network.requestsByDestination['external-other'] ?? 0).toBe(0);
  expect(network.blockedExternalCount).toBe(network.legacyExternalStaticCount);
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('the whole flow makes no upload request and no non-static request', async ({
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let probe: StorageProbeResult | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());

    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    probe = await probeStorage(page);

    const report = buildNetworkPolicyReport(spy.requests, spy.webSockets);
    // Non-vacuity: real requests were observed and really classified, so
    // "no violations" is a decision rather than an empty observation.
    expect(report.totalRequests).toBeGreaterThanOrEqual(4);
    expect(report.requestsByResourceType.script ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.requestsByDestination['local-static'] ?? 0).toBeGreaterThanOrEqual(2);
    // Every destination observed is one this application is allowed to use.
    const allowedDestinations = new Set([
      'local-static',
      // The pre-Cozy remote font stylesheet. Phase 8 removes it; it is blocked
      // and counted here, exactly as the compatibility lane records it.
      'external-legacy-static',
      'data-url',
      'blob-local',
    ]);
    for (const destination of Object.keys(report.requestsByDestination)) {
      expect(allowedDestinations.has(destination), `unexpected destination: ${destination}`).toBe(true);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(network.totalRequests).toBeGreaterThan(0);
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
  expect(network.webSockets.total).toBe(0);
});

// ── Gaps Phase 3 recorded as unverified, now covered in a real browser ────
//
// The Phase 3 limitations named real-browser transaction semantics, cross-tab
// concurrent migration, `versionchange`/`blocked` upgrade behaviour, and quota
// exhaustion during staging as unverified. The four tests above cover the first
// and the happy path; the three below close the rest rather than leaving them as
// documentation.

test('a quota failure during staging leaves the legacy generation authoritative', async ({
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let probe: StorageProbeResult | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  // The application's own write path fails with a real `QuotaExceededError` the
  // first time it writes a subject, so the staged transaction aborts in a real
  // browser rather than in `fake-indexeddb`.
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function quotaBlockedPut(
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'subjects') {
        throw new DOMException('synthetic quota exhaustion', 'QuotaExceededError');
      }
      return original.apply(this, args);
    } as typeof IDBObjectStore.prototype.put;
  });

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());
    await page.goto('/');
    // The learner still sees their subject: a failed migration falls back to the
    // legacy repository, so a recovery state never shows a blank Welcome screen.
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    probe = await probeStorage(page);

    // No generation was activated, and the pointer was never flipped.
    expect(probe.activeGenerationId, 'a failed staging run activated a generation').toBeNull();
    expect(probe.storeCounts.subjects).toBe(0);
    expect(probe.receiptCount).toBe(0);
    // The legacy generation is byte-for-byte what the migration read, which is
    // what makes the rollback path and the recovery screen honest.
    expect(probe.legacyKeyCount).toBe(Object.keys(keys).length + 1);
    expect(probe.legacySubjectJson).toBe(keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('two tabs migrating at once converge on one generation and one receipt', async ({
  context,
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const firstSpy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let probe: StorageProbeResult | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;

  // A second tab in the same browser context, seeded identically and loaded at
  // the same time as the first: the concurrent case `fake-indexeddb` cannot
  // produce, because it is single-threaded and never blocks a transaction.
  const second = await context.newPage();
  const secondSpy = await attachSanitized(second, localOrigin);
  await seedLegacyStateOnce(second);

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());
    await Promise.all([page.goto('/'), second.goto('/')]);
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await expect(second.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await second.waitForLoadState('networkidle');
    // A reload in the second tab, after the first tab already migrated.
    await second.reload();
    await expect(second.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await second.waitForLoadState('networkidle');

    probe = await probeStorage(page);
    const fromSecondTab = await probeStorage(second);

    // One generation, one receipt, one subject: neither tab re-staged or
    // duplicated anything, and both tabs see the same activated generation.
    expect(probe.activeGenerationId).not.toBeNull();
    expect(fromSecondTab.activeGenerationId).toBe(probe.activeGenerationId);
    expect(probe.generationRegistryIds).toHaveLength(1);
    expect(probe.storeCounts.subjects).toBe(1);
    expect(probe.receiptCount).toBe(1);
    expect(probe.receiptStatuses).toEqual(['activated']);
    expect(fromSecondTab.storeCounts).toEqual(probe.storeCounts);
    // Both tabs hydrate the same subject from the same generation.
    expect(fromSecondTab.subject?.subjectName).toBe(SUBJECT_NAME);
    expect(probe.legacyKeyCount).toBe(Object.keys(keys).length + 1);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await second.close();
  }

  const network = buildNetworkPolicyReport(
    [...firstSpy.requests, ...secondSpy.requests],
    [...firstSpy.webSockets, ...secondSpy.webSockets],
  );
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

test('an upgrade is blocked while the application holds the database open', async ({
  context,
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  // What the second page observed: whether the upgrade request was blocked, and
  // whether it completed once the first page released its connection.
  let blockedWhileHeld = false;
  let completedAfterRelease = false;

  const second = await context.newPage();
  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());
    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');

    // The upgrade is issued from a same-origin document that does NOT run the
    // application, so the only connection holding version 1 open is the app's.
    // Navigating to the app here would make this test vacuous: two app tabs
    // would hold the database and closing one would release nothing.
    await second.goto('/assets/sprite-manifest.json');
    // One upgrade request, created once and stashed on the page, so the second
    // phase can await the *same* request rather than queueing a second one behind
    // it.
    const held = await second.evaluate(
      (contract): Promise<{ blocked: boolean; completed: boolean }> => {
        const request = indexedDB.open(contract.databaseName, contract.schemaVersion + 1);
        const stash = window as unknown as {
          __kdUpgradeRequest?: IDBOpenDBRequest;
          __kdUpgradeState?: { blocked: boolean; settled: boolean };
        };
        const state = { blocked: false, settled: false };
        stash.__kdUpgradeState = state;
        request.onblocked = () => {
          state.blocked = true;
        };
        request.onsuccess = () => {
          state.settled = true;
          request.result.close();
        };
        request.onerror = () => {
          state.settled = true;
        };
        stash.__kdUpgradeRequest = request;
        return new Promise<{ blocked: boolean; completed: boolean }>((resolve) => {
          setTimeout(() => resolve({ blocked: state.blocked, completed: state.settled }), 3000);
        });
      },
      { databaseName: STORAGE_V2_STORAGE_CONTRACT.databaseName, schemaVersion: STORAGE_V2_STORAGE_CONTRACT.schemaVersion },
    );
    blockedWhileHeld = held.blocked;
    // The application holds its connection for the session, so a structural
    // upgrade cannot proceed while it is open. This is the `onblocked` condition
    // `openStorageV2Database` refuses on, observed in a real browser.
    expect(blockedWhileHeld, 'the upgrade was not blocked by the open application connection').toBe(true);
    expect(held.completed, 'the upgrade completed while a connection was still open').toBe(false);

    // Releasing the connection lets the queued upgrade proceed, so the block is
    // the app's connection and not a permanently stuck request.
    await page.close();
    completedAfterRelease = await second.evaluate(
      (): Promise<boolean> => {
        const stash = window as unknown as { __kdUpgradeState?: { blocked: boolean; settled: boolean } };
        const state = stash.__kdUpgradeState ?? { blocked: false, settled: false };
        return new Promise<boolean>((resolve) => {
          const started = Date.now();
          const poll = (): void => {
            if (state.settled) {
              resolve(true);
              return;
            }
            if (Date.now() - started > 8000) {
              resolve(false);
              return;
            }
            setTimeout(poll, 100);
          };
          poll();
        });
      },
    );
    expect(completedAfterRelease, 'the upgrade never completed after the connection was released').toBe(true);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (!page.isClosed()) await page.close();
    await second.close();
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe: null,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(blockedWhileHeld).toBe(true);
  expect(completedAfterRelease).toBe(true);
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
});

// ── The application's own image write path, in a real browser ──────────────
//
// The device-local attachment test above writes the store through `page.evaluate`,
// which proves real-browser IndexedDB durability of the *mirror target* but never
// runs the application. The lane's own claim is that the app "makes no upload
// request", and that claim had no test behind it: nothing drove the file control.
// This block drives the real control - Welcome, Start Tutorial, the room panel,
// the room's primary action, the note editor's Images panel, and the actual
// `+ Add image` file input - while every request is recorded, and then reads the
// bytes back out of the device-local database and hashes them in the page.
//
// It lives in the wired lane rather than in a separate project because it needs
// only this build, and because a spec that no project runs is not evidence.

/** A complete 1x1 PNG, byte for byte. Synthetic and self-describing. */
const SYNTHETIC_PNG_BYTES: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];
const DEVICE_LOCAL_DATABASE_NAME = 'knowledge-dungeon-attachments';
const PICKED_FILE_NAME = 'lane-synthetic-picked.png';

const UNOBSERVED_APP_WRITE_PATH: AppWritePathEvidenceShape = {
  observed: false,
  requestsWhilePicking: 0,
  nonStaticRequestsWhilePicking: 0,
  appEndpointRequestsInSession: 0,
  bytesIdentical: false,
  contentHashMatches: false,
  durableAcrossReload: false,
  mirroredIntoGeneration: false,
  toastSaidStoredLocally: false,
};

/** The device-local database, read raw and re-hashed in the page. */
async function readDeviceLocalStore(page: Page): Promise<
  {
    attachmentId: string;
    subjectId: string;
    sourceType: string;
    availability: string;
    contentHash: string | null;
    byteLength: number;
    fileName: string | null;
    sha256OfStoredBytes: string | null;
  }[]
> {
  return page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    if (!db) return [];
    if (!db.objectStoreNames.contains('attachmentBytes')) {
      db.close();
      return [];
    }
    const rows = await new Promise<Record<string, unknown>[]>((resolve) => {
      const request = db.transaction('attachmentBytes', 'readonly').objectStore('attachmentBytes').getAll();
      request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
      request.onerror = () => resolve([]);
    });
    db.close();
    const hex = (buffer: ArrayBuffer): string =>
      [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const bytes = row.bytes as ArrayBuffer | null;
      let sha256OfStoredBytes: string | null = null;
      if (bytes) {
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
        sha256OfStoredBytes = hex(digest);
      }
      out.push({
        attachmentId: row.attachmentId,
        subjectId: row.subjectId,
        sourceType: row.sourceType,
        availability: row.availability,
        contentHash: row.contentHash,
        byteLength: row.byteLength,
        fileName: row.fileName,
        sha256OfStoredBytes,
      });
    }
    return out as never;
  }, DEVICE_LOCAL_DATABASE_NAME);
}

/** Drive the application's own UI to the note editor's file control. */
async function openNoteEditorImageLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start Tutorial' }).click();
  await expect(page.locator('.game-canvas-host canvas')).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  const onboarding = page.getByRole('dialog', { name: 'Gameplay onboarding' });
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: 'Start exploring' }).click();
    await expect(onboarding).toHaveCount(0, { timeout: 20_000 });
  }
  await page.getByRole('button', { name: 'Open room info panel' }).click();
  await page.locator('.room-primary-action').click();
  const editor = page.getByRole('dialog', { name: 'Note editor' });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.getByRole('button', { name: 'Images' }).click();
  await expect(editor.getByRole('button', { name: '+ Add image' })).toBeVisible({ timeout: 20_000 });
}

test('the application stores a picked image on this device and requests nothing', async ({
  page,
  baseURL,
}, testInfo) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const spy = await attachSanitized(page, localOrigin);
  const keys = legacyKeySet();
  await seedLegacyStateOnce(page);

  let failure: Error | null = null;
  let probe: StorageProbeResult | null = null;
  let artifact: ArtifactEvidence = UNVERIFIED_ARTIFACT;
  let appWritePath: AppWritePathEvidenceShape = UNOBSERVED_APP_WRITE_PATH;

  try {
    artifact = artifactEvidenceFrom(verifyRecordedFlaggedArtifact(), readRecordedManifest());
    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await openNoteEditorImageLibrary(page);
    const editor = page.getByRole('dialog', { name: 'Note editor' });
    // The control is a real file input, reached through the real button.
    const fileInput = editor.locator('input[type="file"]');
    await expect(fileInput).toHaveCount(1);
    const before = spy.requests.length;
    await fileInput.setInputFiles({
      name: PICKED_FILE_NAME,
      mimeType: 'image/png',
      buffer: Buffer.from(SYNTHETIC_PNG_BYTES),
    });

    // The application said, in its own words, that it stored the image locally.
    const toast = editor.getByText('Image saved on this device and attached to room.');
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastSaidStoredLocally = true;

    await expect
      .poll(async () => (await readDeviceLocalStore(page)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const stored = (await readDeviceLocalStore(page)).find(
      (row) => row.availability === 'stored' && row.fileName === PICKED_FILE_NAME,
    );
    const whilePicking = spy.requests.slice(before);
    const nonStatic = whilePicking.filter(
      (entry) => entry.destination !== 'local-static' && entry.destination !== 'data-url',
    );
    const session = buildNetworkPolicyReport(spy.requests, spy.webSockets);

    // Durable across a reload, and mirrored into the active generation.
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const afterReload = (await readDeviceLocalStore(page)).find(
      (row) => row.availability === 'stored' && row.fileName === PICKED_FILE_NAME,
    );
    probe = await probeStorage(page);
    const mirrored = probe.attachments.filter((row) => row.availability === 'stored');

    appWritePath = {
      observed: true,
      requestsWhilePicking: whilePicking.length,
      nonStaticRequestsWhilePicking: nonStatic.length,
      appEndpointRequestsInSession: session.requestsByDestination['local-app-endpoint'] ?? 0,
      bytesIdentical:
        afterReload !== undefined && afterReload.byteLength === SYNTHETIC_PNG_BYTES.length,
      contentHashMatches:
        stored?.contentHash === SYNTHETIC_PNG_SHA256 &&
        stored?.sha256OfStoredBytes === SYNTHETIC_PNG_SHA256,
      durableAcrossReload: afterReload?.sha256OfStoredBytes === SYNTHETIC_PNG_SHA256,
      mirroredIntoGeneration: mirrored.length > 0,
      toastSaidStoredLocally,
    };

    // The bytes are on this device, hashed the same way Node hashes them.
    expect(stored, 'the picked image was not stored on the device').toBeDefined();
    expect(stored?.byteLength).toBe(SYNTHETIC_PNG_BYTES.length);
    expect(stored?.sha256OfStoredBytes).toBe(SYNTHETIC_PNG_SHA256);
    expect(stored?.sourceType).toBe('local');
    // Nothing was requested to add it: only the application's own lazily loaded
    // code, and never a request with a method or destination that could carry the
    // bytes away.
    expect(nonStatic, JSON.stringify(nonStatic.map((entry) => entry.destination))).toEqual([]);
    expect(whilePicking.every((entry) => entry.resourceType === 'script')).toBe(true);
    // And the device-local database is a different one from storage-v2, so this
    // write is not a storage-v2 write.
    expect(await page.evaluate(async (name) => {
      const factory = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
      if (typeof factory.databases !== 'function') return true;
      const names = (await factory.databases()).map((entry) => entry.name ?? '');
      return names.includes(name);
    }, DEVICE_LOCAL_DATABASE_NAME)).toBe(true);
    expect(appWritePath.durableAcrossReload).toBe(true);
    expect(appWritePath.mirroredIntoGeneration).toBe(true);
    expect(appWritePath.appEndpointRequestsInSession).toBe(0);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const network = buildNetworkPolicyReport(spy.requests, spy.webSockets);
  writeEvidenceFile(
    testInfo,
    buildEvidence({
      testInfo,
      artifact,
      probe,
      deviceLocal: UNOBSERVED_DEVICE_LOCAL,
      appWritePath,
      network,
      failure,
      seededSubjectJson: keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] ?? '',
    }),
  );
  if (failure) throw failure;
  expect(network.violations, describeNetworkFailures(network)).toEqual([]);
  expect(network.webSockets.total).toBe(0);
});
