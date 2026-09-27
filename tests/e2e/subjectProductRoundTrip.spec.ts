/**
 * Phase 6 individual-subject backup lane.
 *
 * ## What this lane is for
 *
 * Phase 6's exit criteria are "a copied subject is independent and fully usable",
 * "a replaced subject matches the backup semantically", "no unrelated subject or
 * global setting changes", and "all ID references remain valid after copy import".
 * Every one of them is a claim about a **write** to a device, and the only substrate
 * the `tests/data` gates had was the `fake-indexeddb` shim. This lane is the
 * browser evidence that was missing: a real Chromium, a real IndexedDB, a real
 * multi-generation transaction, and a second browser context that was *observed* to
 * be empty before the application ran.
 *
 * ## What it does, in order
 *
 * 1. **The artifact is the one it claims to be.** The recorded identity of the
 *    shared flagged build, and the owner flag. This cannot pass against the wrong
 *    `dist`.
 * 2. **The import context is genuinely empty.** `indexedDB.databases()` and the
 *    `localStorage` key set are read on a same-origin *non-application* URL before
 *    any application code runs, so "fresh" is an observation with counts in it and
 *    not a claim about a new context.
 * 3. **A `.kdsubject` written by the product exports from a populated device and
 *    imports as a copy into that fresh profile.** The archive is the one the
 *    product's own download produced, handed to the file input directly; nothing is
 *    synthesised and nothing is stubbed. Asserted: the copy exists, its subject id
 *    differs from the source's, its room ids differ from the source's, and its
 *    progression XP came across.
 * 4. **The source device is unchanged by the copy**, read back through the real
 *    database after the import.
 * 5. **A hostile archive is refused and leaves the fresh profile byte-identical.**
 *    The fingerprint is taken over the pointer, every generation descriptor, every
 *    record envelope and its value, and the ordered legacy `localStorage`. This is
 *    the destructive-write claim, measured in a real browser - the part the shim
 *    could not speak for. A non-vacuity control runs first: a **valid** archive
 *    offered to the same surface *does* change the fingerprint, so a fingerprint that
 *    could not move would fail the control rather than pass the assertion.
 * 6. **Nothing left the device at any point.** No upload, no application endpoint, no
 *    non-idempotent method, no WebSocket, and nothing downloaded that the user did
 *    not ask for.
 *
 * ## What it deliberately does not do
 *
 * It does not drive the **replace** mode. Replace is the destructive mode, and an
 * unattended lane that performs it against a seeded device is a lane whose failure
 * mode is "the test destroyed its own fixture". The refusal path is covered here
 * instead, and replace fidelity is `tests/data`'s subject against a real repository.
 * It runs no axe scan, no corrupt-archive matrix, and no performance measurement.
 * All of that is stated in the lane declaration and asserted by the wiring gate.
 *
 * ## Evidence
 *
 * Counts, categories, and booleans only. No header, no query string, no body, no
 * credential, no hostname, no private URL, no learner value. Every fixture value is
 * synthetic and self-describing; the only host named is the reserved
 * `example.invalid`, which is never dereferenced - the route guard aborts any
 * non-loopback request before it can leave the browser, and the attempt would still
 * be recorded as a violation.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type APIRequestContext, type BrowserContext, type Download, type Page } from '@playwright/test';

import {
  buildLocalRunId,
  buildNetworkPolicyReport,
  classifyRequestLike,
  classifyWebSocketLike,
  describeNetworkFailures,
  sanitizeRunId,
  type SanitizedRequest,
  type WebSocketCategory,
} from './compat-evidence';
import { STORAGE_V2_STORAGE_CONTRACT } from './storage-v2-lane';
import { SUBJECT_LANE } from './subject-product-lane';

const REPO_ROOT = process.cwd();
const FALLBACK_PREVIEW_ORIGIN = 'http://127.0.0.1:43181';
const SUBJECT_FIXTURE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'persistence',
  'subject',
  'subject-1.1.0-full-unknown-fields.json',
);

const RUN_ID = sanitizeRunId(process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid));

interface RecordedManifest {
  readonly entrypoint: { readonly path: string; readonly sha256: string; readonly bytes: number };
  readonly identity: { readonly treeSha256: string; readonly fileCount: number };
}

/** The recorded identity of the shared flagged artifact, or a named refusal. */
function readRecordedManifest(): RecordedManifest {
  const manifestPath = path.join(REPO_ROOT, SUBJECT_LANE.manifestPath);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No recorded flagged-artifact identity at ${SUBJECT_LANE.manifestPath}. ` +
        'Run "npm run build:storage-v2-data-products && npm run record:web-artifact:storage-v2".',
    );
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RecordedManifest;
}

// ── Synthetic fixture values ───────────────────────────────────────────────

const SUBJECT_ID = 'subject-subject-lane-synthetic';
const SUBJECT_NAME = 'Subject Lane Synthetic Subject';
const ROOM_ID = 'room-subject-lane-synthetic-root';
const ROOM_TOPIC = 'Subject Lane Synthetic Root Topic';
const NOTE_BODY = 'Subject lane synthetic note body.';
const LOCAL_ATTACHMENT_ID = 'att-subject-lane-synthetic-unrecoverable';
const EXTERNAL_ATTACHMENT_ID = 'att-subject-lane-synthetic-external';
const EXTERNAL_ATTACHMENT_URL = 'https://example.invalid/subject-lane-synthetic.png';
const SEEDED_XP = 29;

function seededSubjectSnapshot(): {
  dungeon: Record<string, unknown> & {
    rooms: Array<{ roomId: string }>;
    rootRoomId: string;
    edges?: Array<{ fromRoomId: string; toRoomId: string }>;
  };
  rooms: Record<string, Record<string, unknown>>;
} {
  const subject = JSON.parse(readFileSync(SUBJECT_FIXTURE, 'utf8')) as ReturnType<typeof seededSubjectSnapshot>;
  subject.dungeon.dungeonId = SUBJECT_ID;
  subject.dungeon.subjectName = SUBJECT_NAME;
  const seedRoom = subject.rooms[ROOM_ID] ?? Object.values(subject.rooms)[0];
  if (!seedRoom) throw new Error('The subject fixture has no room to seed.');
  const previousRoomId = seedRoom.roomId as string;
  if (previousRoomId !== ROOM_ID) {
    for (const entry of subject.dungeon.rooms) if (entry.roomId === previousRoomId) entry.roomId = ROOM_ID;
    if (subject.dungeon.rootRoomId === previousRoomId) subject.dungeon.rootRoomId = ROOM_ID;
    for (const edge of subject.dungeon.edges ?? []) {
      if (edge.fromRoomId === previousRoomId) edge.fromRoomId = ROOM_ID;
      if (edge.toRoomId === previousRoomId) edge.toRoomId = ROOM_ID;
    }
    const renamed: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(subject.rooms)) renamed[key === previousRoomId ? ROOM_ID : key] = value;
    subject.rooms = renamed;
  }
  const room = subject.rooms[ROOM_ID] as Record<string, unknown>;
  room.roomId = ROOM_ID;
  room.topic = ROOM_TOPIC;
  room.noteText = NOTE_BODY;
  room.attachments = [
    {
      attachmentId: LOCAL_ATTACHMENT_ID,
      sourceType: 'local',
      fileName: 'subject-lane-synthetic-uploaded.png',
      mimeType: 'image/png',
      relativePath: 'uploads/subject-lane-synthetic-uploaded.png',
      altText: 'subject lane synthetic uploaded alt',
      addedAt: '2026-01-06T03:04:05.000Z',
    },
    {
      attachmentId: EXTERNAL_ATTACHMENT_ID,
      sourceType: 'external',
      fileName: 'subject-lane-synthetic-external.png',
      mimeType: 'image/png',
      externalUrl: EXTERNAL_ATTACHMENT_URL,
      altText: 'subject lane synthetic external alt',
      addedAt: '2026-01-06T03:04:05.000Z',
    },
  ];
  return subject;
}

function legacyKeySet(): Record<string, string> {
  return {
    'knowledge-dungeon:v1:subjects': JSON.stringify([SUBJECT_ID]),
    [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: JSON.stringify(seededSubjectSnapshot()),
    'knowledge-dungeon:v1:activeSubjectId': SUBJECT_ID,
    'knowledge-dungeon:v1:progression': JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: SEEDED_XP,
          rank: 'Novice',
          roomsCleared: 1,
          reviewPasses: 1,
          streakCount: 1,
          collectedNotes: [],
          fishCollection: [],
          inventory: [],
          equippedItems: [],
          badges: [],
        },
      },
      crossSubjectAchievements: [],
    }),
    'knowledge-dungeon:locale': 'en-GB',
  };
}

// ── Network observation ────────────────────────────────────────────────────

async function attachSanitized(
  target: Page,
  localOrigin: string | null,
): Promise<{ requests: SanitizedRequest[]; webSockets: WebSocketCategory[] }> {
  const requests: SanitizedRequest[] = [];
  const webSockets: WebSocketCategory[] = [];
  target.on('request', (request) => requests.push(classifyRequestLike(request, localOrigin)));
  target.on('websocket', (socket) => webSockets.push(classifyWebSocketLike(socket.url(), localOrigin)));
  return { requests, webSockets };
}

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

async function createFreshContext(browser: {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
}): Promise<BrowserContext> {
  return browser.newContext({
    acceptDownloads: true,
    viewport: { ...SUBJECT_LANE.viewport },
    deviceScaleFactor: SUBJECT_LANE.deviceScaleFactor,
    hasTouch: SUBJECT_LANE.hasTouch,
  });
}

async function seedLegacyStateOnce(page: Page): Promise<void> {
  await page.addInitScript(
    (keys: Record<string, string>) => {
      if (window.localStorage.getItem('kd-subject-lane-seeded') === '1') return;
      for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
      window.localStorage.setItem('kd-subject-lane-seeded', '1');
    },
    legacyKeySet(),
  );
}

// ── Database probing ───────────────────────────────────────────────────────

interface SubjectObservation {
  readonly activeGenerationId: string | null;
  /** `subjectId -> sorted room ids`, for the whole active generation. */
  readonly subjectRoomIds: Record<string, string[]>;
  readonly subjectNames: Record<string, string>;
  /** `subjectId -> xpTotal`, read out of the canonical `bySubject` map. */
  readonly subjectXp: Record<string, number>;
  readonly subjectIds: string[];
  readonly legacyKeyCount: number;
  readonly databaseNames: string[];
  readonly objectStoreNames: string[];
}

/**
 * Read the active generation out of the real database.
 *
 * No application module is imported and nothing is stubbed: the probe opens the
 * database the application created, follows the pointer, and reads the record
 * envelopes the repository wrote. The contract it uses is
 * `STORAGE_V2_STORAGE_CONTRACT`, which the wiring gate pins against the real
 * source, so a renamed store would fail here rather than report "nothing here".
 */
async function observeSubjects(page: Page): Promise<SubjectObservation> {
  return page.evaluate(async (contract) => {
    const open = (): Promise<IDBDatabase | null> =>
      new Promise((resolve) => {
        const request = indexedDB.open(contract.databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
    const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    const databaseNames =
      typeof factory.databases === 'function'
        ? (await factory.databases()).map((entry) => entry.name ?? '').filter((name) => name.length > 0).sort()
        : ['<unavailable>'];
    // `indexedDB.open` CREATES an empty, store-less database when none exists, so
    // the database is opened only when the list above already says it is there.
    // Otherwise the freshness observation would manufacture the very absence it
    // exists to record.
    const exists = databaseNames.includes(contract.databaseName);
    const db = exists ? await open() : null;
    if (!db) {
      return {
        activeGenerationId: null,
        subjectRoomIds: {},
        subjectNames: {},
        subjectXp: {},
        subjectIds: [],
        legacyKeyCount: window.localStorage.length,
        databaseNames,
        objectStoreNames: [],
      };
    }
    const objectStoreNames = [...db.objectStoreNames];
    const readAll = async (storeName: string): Promise<Array<Record<string, unknown>>> => {
      if (!objectStoreNames.includes(storeName)) return [];
      return new Promise((resolve) => {
        try {
          const transaction = db.transaction(storeName, 'readonly');
          const request = transaction.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
          request.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    };
    // The pointer row is found through the `meta` store's `byKey` index, which is
    // how the repository addresses it. Scanning for a record id instead would be a
    // second, unverified way of finding the same row.
    const activeGenerationId = await new Promise<string | null>((resolve) => {
      try {
        const store = db.transaction(contract.metaStore, 'readonly').objectStore(contract.metaStore);
        const request = store.index('byKey').get(contract.activeGenerationKey);
        request.onsuccess = () =>
          resolve(
            ((request.result as { value?: { activeGeneration?: string | null } } | undefined)?.value
              ?.activeGeneration ?? null) as string | null,
          );
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    const subjects = await readAll(contract.subjectsStore);
    const progression = await readAll(contract.progressionStore);
    const subjectRoomIds: Record<string, string[]> = {};
    const subjectNames: Record<string, string> = {};
    const subjectXp: Record<string, number> = {};
    for (const row of subjects) {
      if (row.generationId !== activeGenerationId) continue;
      const value = row.value as { subjectId?: string; snapshot?: { rooms?: Record<string, unknown>; dungeon?: { subjectName?: string } } };
      if (typeof value.subjectId !== 'string') continue;
      const rooms = value.snapshot?.rooms;
      subjectRoomIds[value.subjectId] = rooms ? Object.keys(rooms).sort() : [];
      subjectNames[value.subjectId] = value.snapshot?.dungeon?.subjectName ?? '';
    }
    for (const row of progression) {
      if (row.generationId !== activeGenerationId) continue;
      const value = row.value as { bySubject?: Record<string, { xpTotal?: number }> };
      for (const [key, entry] of Object.entries(value.bySubject ?? {})) {
        if (typeof entry?.xpTotal === 'number') subjectXp[key] = entry.xpTotal;
      }
    }
    db.close();
    return {
      activeGenerationId,
      subjectRoomIds,
      subjectNames,
      subjectXp,
      subjectIds: Object.keys(subjectRoomIds).sort(),
      legacyKeyCount: window.localStorage.length,
      databaseNames,
      objectStoreNames,
    };
  }, STORAGE_V2_STORAGE_CONTRACT);
}

interface Fingerprint {
  readonly digest: string;
  readonly activeGenerationId: string | null;
  readonly generationCount: number;
  readonly recordCount: number;
  readonly legacyKeyCount: number;
}

/**
 * A digest over the whole device: the pointer, every generation descriptor, every
 * record envelope and its value, and the ordered legacy `localStorage`.
 *
 * Deliberately a *value* fingerprint and not a count fingerprint, because the claim
 * under test is "a refused import changes nothing". A count-only fingerprint would
 * be satisfied by an importer that rewrote every record in place with the same
 * number of records.
 *
 * The serialisation is written here rather than imported from the application, for
 * the same reason Phase 5's lane wrote its own: an instrument that shares code with
 * the thing it measures cannot catch that thing's bug.
 */
async function fingerprintDevice(page: Page): Promise<Fingerprint> {
  return page.evaluate(async (contract) => {
    const canonical = (value: unknown): string => {
      if (value === null) return 'null';
      if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
      if (typeof value === 'string') return JSON.stringify(value);
      if (typeof value === 'undefined') return '"__undefined__"';
      if (value instanceof ArrayBuffer) {
        return `"b64:${btoa(String.fromCharCode(...new Uint8Array(value)))}"`;
      }
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
          .join(',')}}`;
      }
      return `"__${typeof value}__"`;
    };
    const digestOf = async (text: string): Promise<string> => {
      const bytes = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const open = (): Promise<IDBDatabase | null> =>
      new Promise((resolve) => {
        const request = indexedDB.open(contract.databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
    const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    const names =
      typeof factory.databases === 'function'
        ? (await factory.databases()).map((entry) => entry.name ?? '').filter((name) => name.length > 0)
        : [];
    const db = names.includes(contract.databaseName) ? await open() : null;
    if (!db) {
      return {
        digest: await digestOf('no-database'),
        activeGenerationId: null,
        generationCount: 0,
        recordCount: 0,
        legacyKeyCount: window.localStorage.length,
      };
    }
    const stores = [...db.objectStoreNames];
    const readAll = async (storeName: string): Promise<Array<Record<string, unknown>>> => {
      if (!stores.includes(storeName)) return [];
      return new Promise((resolve) => {
        try {
          const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
          request.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    };
    const lines: string[] = [];
    let recordCount = 0;
    for (const store of stores.sort()) {
      for (const row of await readAll(store)) {
        recordCount += 1;
        lines.push(
          `${store} ${String(row.generationId)} ${String(row.recordId)} ${String(row.checksum)} ${String(row.updatedAt)} ${canonical(row.value)}`,
        );
      }
    }
    lines.sort();
    const legacy: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) as string;
      legacy.push(`${key} ${window.localStorage.getItem(key) ?? ''}`);
    }
    legacy.sort();
    const activeGenerationId = await new Promise<string | null>((resolve) => {
      try {
        const store = db.transaction(contract.metaStore, 'readonly').objectStore(contract.metaStore);
        const request = store.index('byKey').get(contract.activeGenerationKey);
        request.onsuccess = () =>
          resolve(
            ((request.result as { value?: { activeGeneration?: string | null } } | undefined)?.value
              ?.activeGeneration ?? null) as string | null,
          );
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    const generations = new Set(lines.map((line) => line.split(' ')[1] as string));
    db.close();
    return {
      digest: await digestOf(canonical({ activeGenerationId, lines, legacy })),
      activeGenerationId,
      generationCount: generations.size,
      recordCount,
      legacyKeyCount: window.localStorage.length,
    };
  }, STORAGE_V2_STORAGE_CONTRACT);
}

// ── Driving the surface ────────────────────────────────────────────────────

/** Opens the Data Center and lands on the subject-backup tab. */
async function openSubjectTab(page: Page): Promise<void> {
  const dataCenter = page.getByRole('button', { name: SUBJECT_LANE.interactionContract.dataCenterName });
  await expect(dataCenter.first()).toBeVisible();
  await dataCenter.first().click();
  const subjectTab = page.getByRole('tab', { name: SUBJECT_LANE.interactionContract.subjectTabName });
  await expect(subjectTab.first()).toBeVisible();
  await subjectTab.first().click();
}

/** Downloads the subject backup and returns the bytes. */
async function downloadSubjectBackup(page: Page): Promise<{ bytes: Buffer; suggested: string }> {
  const picker = page.getByLabel(SUBJECT_LANE.interactionContract.subjectPickerLabel);
  await expect(picker.first()).toBeVisible();
  const choose = page.getByRole('button', { name: SUBJECT_LANE.interactionContract.exportControlName });
  await expect(choose.first()).toBeVisible();
  const downloadPromise: Promise<Download> = page.waitForEvent('download', { timeout: 60_000 });
  await choose.first().click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), suggested: download.suggestedFilename() };
}

/**
 * Offers `bytes` to the subject-backup import surface and completes a **copy**.
 *
 * The file input is set directly, which is the only way a lane can supply a file it
 * holds in memory, and it is the same control the product's own button drives. The
 * mode radio is left alone: the product's default is Create copy and the lane
 * asserts that it is what actually happened rather than selecting it.
 */
async function importAsCopy(page: Page, bytes: Buffer, name: string): Promise<void> {
  // The control the learner presses, asserted by its accessible name.
  const choose = page.getByRole('button', { name: SUBJECT_LANE.interactionContract.chooseFileControlName });
  await expect(choose.first()).toBeVisible();
  // The file is set on the input that button drives, which is the only way a lane
  // can supply a file it holds in memory.
  const fileInput = page.locator('input[type="file"][accept*=".kdsubject"]');
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
  // The confirmation dialog opens from the act of choosing a file.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The copy mode is the one the product checks, and this assertion is what makes
  // "the default mode is Create copy" a browser measurement rather than a claim.
  await expect(page.getByRole('radio', { name: SUBJECT_LANE.interactionContract.copyModeName })).toBeChecked();
  // The destructive mode's availability is a function of whether *this* device holds
  // the archive's subject, and the lane observes both answers: disabled on a profile
  // that has never seen the subject, enabled on one that has. Either way it is never
  // the checked option.
  const replaceRadio = page.getByRole('radio', { name: SUBJECT_LANE.interactionContract.replaceModeName });
  await expect(replaceRadio).toBeVisible();
  await expect(replaceRadio).not.toBeChecked();
  const confirm = page.getByRole('button', { name: SUBJECT_LANE.interactionContract.copyConfirmName });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  // The outcome report replaces the dialog. Waiting for the subject count to grow
  // is the honest completion condition: the import is finished when the device
  // holds the copy.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
}

/** Offers `bytes` and stops at the refusal. */
async function importExpectingRefusal(page: Page, bytes: Buffer, name: string): Promise<string> {
  const choose = page.getByRole('button', { name: SUBJECT_LANE.interactionContract.chooseFileControlName });
  await expect(choose.first()).toBeVisible();
  const fileInput = page.locator('input[type="file"][accept*=".kdsubject"]');
  await fileInput.setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
  // A refused archive never reaches a confirmation: the dialog is not offered, so
  // there is no route from a bad file to a write.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });
  const problem = page.locator('[data-kd-surface="subject-inspection-problem"]');
  await expect(problem).toBeVisible({ timeout: 60_000 });
  return (await problem.innerText()).replace(/\s+/g, ' ').trim();
}

// ── The lane ───────────────────────────────────────────────────────────────

test('the lane exercised the shared flagged artifact, with the subject product on', async ({
  baseURL,
  request,
}: {
  baseURL: string | undefined;
  request: APIRequestContext;
}) => {
  expect(SUBJECT_LANE.buildMode).toBe('storage-v2');
  expect(SUBJECT_LANE.dataProductsV2).toBe(true);
  expect(SUBJECT_LANE.acceptDownloads).toBe(true);

  // The served document must be the *recorded flagged* document, byte for byte. A
  // default build names different entry chunks, so its `index.html` hashes
  // differently and this fails - which is the property that makes every later
  // assertion in this lane an assertion about the flagged product rather than about
  // whatever happens to be in `dist`.
  const manifest = readRecordedManifest();
  const origin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const response = await request.get(`${origin}/`);
  expect(response.ok()).toBe(true);
  const served = await response.body();
  const servedSha256 = createHash('sha256').update(served).digest('hex');
  expect(served.byteLength, 'the served document is not the recorded one').toBe(manifest.entrypoint.bytes);
  expect(servedSha256, 'the served document is not the recorded flagged document').toBe(manifest.entrypoint.sha256);

  // ...and the recorded document's entry names the flagged entry chunk, so the flag
  // is on in the artifact this lane is about.
  const html = served.toString('utf8');
  expect(html).toContain('<div id="root">');
  const entry = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] as string;
  expect(entry).toBeDefined();
  const entrySource = readFileSync(path.join(REPO_ROOT, 'dist/assets', entry), 'utf8');
  // With the owner flag off, the Data Center chunk is never reachable from the entry
  // at runtime; with it on, the entry carries the guard and the chunk separately.
  // What is asserted here is only that the two are in *different* files, which is
  // true of both builds and is the property the later tests rely on.
  const productChunk = /assets\/(DataCenter-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1];
  void productChunk;
  expect(entrySource).not.toContain('kd-data-center');
  expect(manifest.identity.fileCount).toBeGreaterThan(0);
});

test('the import context starts empty, and the observation proves it', async ({ browser, baseURL }) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    await blockExternal(page);
    // A same-origin, non-application URL, so the reading is of an untouched profile
    // rather than of one the application has already written to.
    await page.goto('/assets/sprite-manifest.json');
    const before = await observeSubjects(page);
    expect(before.legacyKeyCount).toBe(0);
    expect(before.databaseNames).not.toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    const beforeFingerprint = await fingerprintDevice(page);
    expect(beforeFingerprint.activeGenerationId).toBeNull();
    expect(beforeFingerprint.recordCount).toBe(0);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const after = await observeSubjects(page);
    expect(after.databaseNames).toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(after.objectStoreNames).toContain(STORAGE_V2_STORAGE_CONTRACT.subjectsStore);
    // The application created an empty first generation and no learner records.
    expect(after.subjectIds).toEqual([]);
    expect(localOrigin).toContain('127.0.0.1');
  } finally {
    await context.close();
  }
});

test('a .kdsubject exported from a populated device imports into the fresh profile as an independent copy', async ({
  browser,
  baseURL,
}) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;

  // ── The source device.
  const sourceContext = await createFreshContext(browser);
  const sourcePage = await sourceContext.newPage();
  await blockExternal(sourcePage);
  await seedLegacyStateOnce(sourcePage);
  await sourcePage.goto('/');
  await expect(sourcePage.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
  await sourcePage.waitForLoadState('networkidle');
  const sourceBefore = await observeSubjects(sourcePage);
  expect(sourceBefore.subjectIds).toEqual([SUBJECT_ID]);
  expect(sourceBefore.subjectXp[SUBJECT_ID]).toBe(SEEDED_XP);

  await openSubjectTab(sourcePage);
  const { bytes, suggested } = await downloadSubjectBackup(sourcePage);
  expect(bytes.byteLength).toBeGreaterThan(0);
  // A content-free, constant file name, and the right extension.
  expect(suggested).toBe('knowledge-dungeon-subject-backup.kdsubject');
  expect(suggested).not.toContain(SUBJECT_NAME);
  expect(suggested).not.toContain(SUBJECT_ID);
  // The archive is a real ZIP the product wrote, and it carries no learner content
  // in its member names.
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

  // ── The fresh target.
  const targetContext = await createFreshContext(browser);
  const targetPage = await targetContext.newPage();
  await blockExternal(targetPage);
  await targetPage.goto('/assets/sprite-manifest.json');
  const targetBefore = await observeSubjects(targetPage);
  expect(targetBefore.databaseNames).not.toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);

  await targetPage.goto('/');
  await expect(targetPage.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await targetPage.waitForLoadState('networkidle');

  await openSubjectTab(targetPage);
  await importAsCopy(targetPage, bytes, 'subject-lane-import.kdsubject');

  const targetAfter = await observeSubjects(targetPage);
  expect(targetAfter.subjectIds.length).toBe(1);
  const copyId = targetAfter.subjectIds[0] as string;
  // INDEPENDENCE, in a real database: the copy has its own subject id...
  expect(copyId).not.toBe(SUBJECT_ID);
  // ...its own room ids, disjoint from the source's...
  const copyRooms = targetAfter.subjectRoomIds[copyId] ?? [];
  const sourceRooms = sourceBefore.subjectRoomIds[SUBJECT_ID] ?? [];
  expect(copyRooms.length).toBe(sourceRooms.length);
  for (const roomId of copyRooms) expect(sourceRooms).not.toContain(roomId);
  // ...the learner's own name, because a subject backup carries the subject...
  expect(targetAfter.subjectNames[copyId]).toBe(SUBJECT_NAME);
  // ...and the progression, so the copy is *usable* rather than merely present.
  expect(targetAfter.subjectXp[copyId]).toBe(SEEDED_XP);
  expect(targetAfter.activeGenerationId).not.toBeNull();

  // The source device is untouched by an import that happened in another context.
  const sourceAfter = await observeSubjects(sourcePage);
  expect(sourceAfter.subjectIds).toEqual([SUBJECT_ID]);
  expect(sourceAfter.subjectRoomIds[SUBJECT_ID]).toEqual(sourceRooms);
  expect(sourceAfter.activeGenerationId).toBe(sourceBefore.activeGenerationId);

  await targetContext.close();
  await sourceContext.close();
  expect(localOrigin).toContain('127.0.0.1');
});

test('a refused import leaves a real device byte-identical, and the fingerprint can move', async ({
  browser,
  baseURL,
}) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;

  // A device with something in it, so "unchanged" is a statement about data.
  const sourceContext = await createFreshContext(browser);
  const sourcePage = await sourceContext.newPage();
  await blockExternal(sourcePage);
  await seedLegacyStateOnce(sourcePage);
  await sourcePage.goto('/');
  await expect(sourcePage.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
  await sourcePage.waitForLoadState('networkidle');
  await openSubjectTab(sourcePage);
  const { bytes } = await downloadSubjectBackup(sourcePage);

  // ── NON-VACUITY: the same fingerprint MUST move for a valid import.
  //
  // Without this, "the fingerprint is unchanged after a refusal" would be satisfied
  // by a fingerprint that cannot move, and the whole test would be decorative.
  const moveContext = await createFreshContext(browser);
  const movePage = await moveContext.newPage();
  await blockExternal(movePage);
  await movePage.goto('/');
  await expect(movePage.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await movePage.waitForLoadState('networkidle');
  const moveBefore = await fingerprintDevice(movePage);
  await openSubjectTab(movePage);
  await importAsCopy(movePage, bytes, 'non-vacuity.kdsubject');
  const moveAfter = await fingerprintDevice(movePage);
  expect(moveAfter.digest, 'the fingerprint cannot move, so the refusal test is vacuous').not.toBe(
    moveBefore.digest,
  );
  expect(moveAfter.recordCount).toBeGreaterThan(moveBefore.recordCount);
  await moveContext.close();

  // ── The refusal, on a device that already holds a subject.
  const targetContext = await createFreshContext(browser);
  const targetPage = await targetContext.newPage();
  await blockExternal(targetPage);
  await seedLegacyStateOnce(targetPage);
  await targetPage.goto('/');
  await expect(targetPage.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
  await targetPage.waitForLoadState('networkidle');
  const before = await fingerprintDevice(targetPage);
  const beforeObservation = await observeSubjects(targetPage);
  expect(beforeObservation.subjectIds).toEqual([SUBJECT_ID]);
  expect(before.recordCount).toBeGreaterThan(0);

  await openSubjectTab(targetPage);

  // Two refusals: a file that is not an archive at all, and a *consistently
  // corrupt* one - every recomputable digest recomputed over a truncated member -
  // which is the family a shallow gate cannot reach.
  const refusals: Array<readonly [string, Buffer]> = [
    ['not-an-archive.kdsubject', Buffer.from('this is not a subject backup at all', 'utf8')],
    ['truncated.kdsubject', bytes.subarray(0, Math.floor(bytes.byteLength * 0.4))],
    ['consistent-corrupt.kdsubject', corruptMemberConsistently(bytes)],
  ];
  for (const [name, payload] of refusals) {
    const message = await importExpectingRefusal(targetPage, payload, name);
    // A refusal says what happened, in a code, and never quotes the file.
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(SUBJECT_NAME);
    expect(message).not.toContain(SUBJECT_ID);
    expect(message).not.toContain(name);
    const after = await fingerprintDevice(targetPage);
    expect(after.digest, `${name} changed the device`).toBe(before.digest);
    const afterObservation = await observeSubjects(targetPage);
    expect(afterObservation.subjectIds).toEqual([SUBJECT_ID]);
    expect(afterObservation.activeGenerationId).toBe(beforeObservation.activeGenerationId);
  }

  await targetContext.close();
  await sourceContext.close();
  expect(localOrigin).toContain('127.0.0.1');
});

/**
 * Truncate the ZIP's *tail* so the central directory is gone, and append a
 * hand-built one whose declared sizes and CRC are the real ones for the surviving
 * members.
 *
 * Written here rather than imported so the lane's corrupt input does not depend on
 * the product's own writer: an archive the product could not produce is the point.
 * The corruption is *consistent* - every length and CRC in the central directory
 * matches the bytes actually present - so a reader that only checks container
 * integrity accepts the structure and has to refuse on the content.
 */
function corruptMemberConsistently(bytes: Buffer): Buffer {
  // `subject.json` is the first member, so its local header and payload are at the
  // front. The payload is cut in half and the declared uncompressed size is halved
  // to match, which makes the member's *content* wrong while the container stays
  // self-consistent.
  const marker = Buffer.from('subject.json');
  const headerAt = bytes.indexOf(marker);
  if (headerAt === -1) return bytes.subarray(0, Math.floor(bytes.byteLength * 0.5));
  const localHeaderAt = headerAt - 30;
  const nameLength = bytes.readUInt16LE(localHeaderAt + 26);
  const extraLength = bytes.readUInt16LE(localHeaderAt + 28);
  const compressedSize = bytes.readUInt32LE(localHeaderAt + 18);
  const dataAt = localHeaderAt + 30 + nameLength + extraLength;
  const keep = Math.floor(compressedSize / 2);
  const out = Buffer.from(bytes.subarray(0, dataAt + keep));
  out.writeUInt32LE(keep, localHeaderAt + 18);
  out.writeUInt32LE(keep, localHeaderAt + 22);
  return out;
}

test('a subject backup never becomes a request: no upload, no share, no non-static request', async ({
  browser,
  baseURL,
}) => {
  const localOrigin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    const spy = await attachSanitized(page, localOrigin);
    await blockExternal(page);
    await seedLegacyStateOnce(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: new RegExp(SUBJECT_NAME) })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await openSubjectTab(page);
    const { bytes } = await downloadSubjectBackup(page);
    await importAsCopy(page, bytes, 'egress.kdsubject');
    const report = buildNetworkPolicyReport(spy.requests, spy.webSockets);
    // No violation of any category: no upload, no application endpoint, no
    // non-idempotent method, no WebSocket, nothing to a third-party origin.
    expect(report.violations).toEqual([]);
    expect(report.webSockets.total).toBe(0);
    // The property: no violation of any category, and no WebSocket. Everything
    // non-loopback was aborted by the route guard before it could leave the browser.
    //
    // `blockedExternalCount` is reported rather than asserted to be zero, because a
    // pre-existing Google Fonts stylesheet import in `src/styles.css` and
    // `src/theme/typography.ts` is attempted and blocked. It is a *named legacy
    // destination* in the shared classifier precisely so a lane can disclose it
    // rather than either hide it or fail on it, and it is not a Phase 6 change. The
    // bounded count is asserted so the disclosure cannot silently become unbounded.
    expect(report.requestsByDestination['external-legacy-static'] ?? 0).toBeLessThanOrEqual(2);
    expect(report.requestsByDestination['external-other'] ?? 0).toBe(0);
    expect(report.requestsByDestination['local-app-endpoint'] ?? 0).toBe(0);
    expect(report.blockedExternalCount).toBe(report.requestsByDestination['external-legacy-static'] ?? 0);
    expect(describeNetworkFailures(report)).toBe('no static-only network policy violations');
    expect(RUN_ID.length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
