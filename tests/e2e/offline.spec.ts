/**
 * Phase 22 offline static-shell proof (Chromium).
 *
 * The minimum locked scope, in one test against one artifact:
 *
 *   1. load the app online, register the worker, and create a synthetic subject
 *      through the Welcome form (a storage-v2 IndexedDB write);
 *   2. go offline and reload: the shell renders and the subject is still listed and
 *      still present in the active storage-v2 generation;
 *   3. inspect Cache Storage: every key is a build-time shell asset named by the
 *      emitted manifest, and none matches a learner-data path;
 *   4. bump the shell manifest's version, force an update, and assert the previous
 *      versioned cache is purged;
 *   5. assert that enabling the worker introduced no off-origin request.
 *
 * `serviceWorkers: 'allow'` is set for this lane's project only, in
 * `playwright.offline.config.ts`; the companion service-worker compatibility lane
 * (`tests/e2e/playwright.sw-shell.config.ts`) allows it for its own project for the
 * same reason. Every other lane, the global config, and the Phase 1 network spy
 * keep `serviceWorkers: 'block'`.
 *
 * Evidence is counts, cache names, asset paths, and booleans. No learner value is
 * recorded, and the only subject name used is synthetic and self-describing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { STORAGE_V2_STORAGE_CONTRACT } from './storage-v2-lane';
import {
  LEARNER_DATA_PATH_MARKERS,
  OFFLINE_SHELL_CACHE_PREFIX,
  OFFLINE_SHELL_MANIFEST_FILENAME,
} from './offline-lane';

const REPO_ROOT = process.cwd();
const SUBJECT_NAME = 'Offline Shell Synthetic Subject';
const ROOT_TOPIC = 'Offline Shell Synthetic Root Topic';

/** The Welcome form controls, in the application's own vocabulary. */
const CREATE_LOAD_TAB = /create\s*\/\s*load/i;
const SUBJECT_NAME_FIELD = /subject name/i;
const ROOT_TOPIC_FIELD = /root topic/i;
const CREATE_SUBJECT_CONTROL = /create new subject/i;
const SETUP_CHECKLIST = /setup checklist/i;

/** The installed shell manifest, parsed from `dist/` on the Node side. */
interface ShellManifest {
  readonly version: string;
  readonly document: string;
  readonly assets: readonly string[];
}

function readBuiltShellManifest(): ShellManifest {
  const manifestPath = path.join(REPO_ROOT, 'dist', OFFLINE_SHELL_MANIFEST_FILENAME);
  const source = readFileSync(manifestPath, 'utf8');
  const match = /Object\.freeze\(([\s\S]*)\);\s*$/.exec(source);
  if (match === null) {
    throw new Error(`Could not parse ${OFFLINE_SHELL_MANIFEST_FILENAME}.`);
  }
  return JSON.parse(match[1]) as ShellManifest;
}

interface CacheReport {
  readonly cacheNames: readonly string[];
  readonly entries: readonly { readonly cacheName: string; readonly urls: readonly string[] }[];
}

async function readCacheReport(page: Page): Promise<CacheReport> {
  return page.evaluate(async () => {
    const cacheNames = (await caches.keys()).sort();
    const entries: { cacheName: string; urls: string[] }[] = [];
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      entries.push({
        cacheName,
        urls: requests.map((request) => new URL(request.url).pathname).sort(),
      });
    }
    return { cacheNames, entries };
  });
}

interface DeviceObservation {
  readonly activeGenerationId: string | null;
  readonly activeSubjects: Readonly<Record<string, string>>;
}

/**
 * Reads the active storage-v2 generation out of the real database.
 *
 * No application module is imported and nothing is stubbed. The probe opens the
 * database the application created, follows the `activeGeneration` pointer, and
 * reads subject names from the generation it names - the same shape the reload
 * lane's probe uses, reduced to what this proof needs.
 */
async function readActiveSubjects(page: Page): Promise<DeviceObservation> {
  return page.evaluate(async (contract) => {
    const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    const databaseNames =
      typeof factory.databases === 'function'
        ? (await factory.databases()).map((entry) => entry.name ?? '')
        : [];
    if (!databaseNames.includes(contract.databaseName)) {
      return { activeGenerationId: null, activeSubjects: {} };
    }
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const request = indexedDB.open(contract.databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    if (db === null) return { activeGenerationId: null, activeSubjects: {} };

    const readAll = (storeName: string): Promise<Array<Record<string, unknown>>> => {
      if (![...db.objectStoreNames].includes(storeName)) return Promise.resolve([]);
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

    const subjectRows = await readAll(contract.subjectsStore);
    const activeSubjects: Record<string, string> = {};
    for (const row of subjectRows) {
      if (String(row.generationId) !== String(activeGenerationId)) continue;
      const value = row.value as {
        subjectId?: string;
        snapshot?: { dungeon?: { subjectName?: string } };
      };
      if (typeof value.subjectId === 'string') {
        activeSubjects[value.subjectId] = value.snapshot?.dungeon?.subjectName ?? '';
      }
    }
    db.close();
    return { activeGenerationId, activeSubjects };
  }, STORAGE_V2_STORAGE_CONTRACT);
}

/** Waits for the service worker to control the page. */
async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 30_000,
  });
}

/** Creates a subject through the application's own Welcome form. */
async function createSubjectThroughWelcomeForm(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: CREATE_LOAD_TAB });
  if ((await tab.first().getAttribute('aria-selected')) !== 'true') {
    await tab.first().click();
  }
  await page.getByPlaceholder(SUBJECT_NAME_FIELD).fill(SUBJECT_NAME);
  await page.getByPlaceholder(ROOT_TOPIC_FIELD).fill(ROOT_TOPIC);
  const create = page.getByRole('button', { name: CREATE_SUBJECT_CONTROL });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole('complementary', { name: SETUP_CHECKLIST })).toContainText(SUBJECT_NAME);
  // The form moves to the Player Setup tab when it completes; come back to the
  // list so the subject is observable the same way before and after the reload.
  await openCreateLoadTab(page);
}

async function openCreateLoadTab(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: CREATE_LOAD_TAB });
  if ((await tab.first().getAttribute('aria-selected')) !== 'true') {
    await tab.first().click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
}

/** The listed subject row locator, keyed on the synthetic name. */
function listedSubjectRow(page: Page) {
  return page.getByRole('button', { name: /^Offline Shell Synthetic Subject\b/ });
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

// The version-bump step regenerates `dist/offline-shell-manifest.js` with a forced
// token. Restore the content-derived token afterwards so the previewed `dist` still
// matches the identity that `record:web-artifact:offline` recorded for it.
test.afterAll(() => {
  try {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/generate-offline-shell.mjs')],
      { cwd: REPO_ROOT, stdio: 'pipe' },
    );
  } catch {
    // Best effort: a run that typechecks this file without a build never reaches here.
  }
});

test('a loaded app reloads offline with its storage-v2 data and a shell-only cache', async ({
  page,
  baseURL,
  context,
}, testInfo) => {
  if (!baseURL) throw new Error('Playwright baseURL is required for the offline lane.');
  const origin = new URL(baseURL).origin;

  // Off-origin observation for the "no new network requests" claim. Only the
  // origin and resource type are recorded, never a URL, query, or body.
  const offOriginRequests: Array<{ readonly origin: string; readonly resourceType: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin === origin) return;
    offOriginRequests.push({ origin: url.origin, resourceType: request.resourceType() });
  });

  const builtManifest = readBuiltShellManifest();
  const allowedAssets = new Set(builtManifest.assets);

  // ── 1. Online load, worker registration, and a real storage-v2 write ─────────
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await waitForServiceWorkerControl(page);
  await createSubjectThroughWelcomeForm(page);

  const onlineDevice = await readActiveSubjects(page);
  expect(onlineDevice.activeGenerationId, 'no active storage-v2 generation after creating a subject').not.toBeNull();
  expect(Object.values(onlineDevice.activeSubjects)).toContain(SUBJECT_NAME);

  // ── 2. Offline reload: the shell renders and the data is intact ──────────────
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    'the shell did not render offline',
  ).toBeVisible();
  await openCreateLoadTab(page);
  await expect(listedSubjectRow(page), 'the subject is not listed after an offline reload').toBeVisible();
  const offlineDevice = await readActiveSubjects(page);
  expect(offlineDevice.activeGenerationId, 'the active generation changed offline').toBe(
    onlineDevice.activeGenerationId,
  );
  expect(Object.values(offlineDevice.activeSubjects), 'IndexedDB data did not survive the offline reload').toContain(
    SUBJECT_NAME,
  );

  // ── 3. Cache inspection: shell assets only, no learner-data paths ────────────
  const cacheReport = await readCacheReport(page);
  const shellCaches = cacheReport.cacheNames.filter((name) => name.startsWith(OFFLINE_SHELL_CACHE_PREFIX));
  expect(shellCaches, 'expected exactly one versioned shell cache').toHaveLength(1);

  const cachedUrls = cacheReport.entries
    .filter((entry) => entry.cacheName.startsWith(OFFLINE_SHELL_CACHE_PREFIX))
    .flatMap((entry) => entry.urls);
  expect(cachedUrls.length, 'the shell cache is empty').toBeGreaterThan(0);
  const unexpectedAssets = cachedUrls.filter((url) => !allowedAssets.has(url));
  expect(unexpectedAssets, `cached paths not named by the shell manifest: ${unexpectedAssets.join(', ')}`).toEqual([]);

  const learnerDataPaths = cachedUrls.filter((url) =>
    LEARNER_DATA_PATH_MARKERS.some((marker) => url.toLowerCase().includes(marker)),
  );
  expect(learnerDataPaths, `learner-data paths were cached: ${learnerDataPaths.join(', ')}`).toEqual([]);

  // ── 4. A version-bump rebuild purges the stale cache ────────────────────────
  await context.setOffline(false);
  const previousCacheNames = [...shellCaches];
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts/generate-offline-shell.mjs'),
      '--build-version=kd-e2e-bump',
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
  // Wait for the *purge*, not merely for the new cache to appear: `install` creates
  // the new versioned cache before `activate` deletes the previous one, so polling
  // for "the list changed" would race the deletion. The condition is the exit
  // criterion: exactly one shell cache remains, and it is not the previous one.
  await expect
    .poll(
      async () => {
        const names = (await page.evaluate(() => caches.keys())).filter((name) =>
          name.startsWith('kd-offline-shell-'),
        );
        return names.length === 1 && !previousCacheNames.includes(names[0] as string);
      },
      { timeout: 30_000, message: 'the version-bumped shell cache never purged the previous one' },
    )
    .toBe(true);
  const bumpedCacheReport = await readCacheReport(page);
  const bumpedShellCaches = bumpedCacheReport.cacheNames.filter((name) =>
    name.startsWith(OFFLINE_SHELL_CACHE_PREFIX),
  );
  expect(bumpedShellCaches, 'more than one shell cache survived the version bump').toHaveLength(1);
  expect(previousCacheNames, 'the stale shell cache was not purged').not.toContain(bumpedShellCaches[0]);
  expect(bumpedShellCaches[0]).toContain('kd-e2e-bump');

  // ── 5. No off-origin request was introduced by enabling the worker ───────────
  expect(offOriginRequests, `off-origin requests observed: ${JSON.stringify(offOriginRequests)}`).toEqual([]);

  const evidence = {
    shellCachePrefix: OFFLINE_SHELL_CACHE_PREFIX,
    builtVersion: builtManifest.version,
    builtAssetCount: builtManifest.assets.length,
    shellCaches,
    cachedUrls,
    learnerDataPaths,
    onlineSubjectCount: Object.keys(onlineDevice.activeSubjects).length,
    offlineSubjectCount: Object.keys(offlineDevice.activeSubjects).length,
    activeGenerationStable: onlineDevice.activeGenerationId === offlineDevice.activeGenerationId,
    bumpedShellCaches,
    offOriginRequests,
  };
  // Printed as well as attached: the raw cache-inspection output is the evidence,
  // and a passing lane's attachment is not written by every reporter. The report
  // contains only build-time asset paths and counts - no learner value.
  console.log(`[offline-shell] ${JSON.stringify(evidence)}`);
  await attachJson(testInfo, 'offline-shell-evidence.json', evidence);
});
