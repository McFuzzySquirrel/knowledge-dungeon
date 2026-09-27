/**
 * Reload-persistence lane: a write to the active generation must survive a reload.
 *
 * ## The defect this lane exists for
 *
 * **A write that reached the active storage-v2 generation only was silently
 * discarded on the next page load.** On a device whose first boot took the
 * `hasNoLearnerContent` short-circuit, the legacy migration re-ran on the second
 * boot, found no `gen-migration-0001` on that device, staged a new generation from
 * the stale `localStorage` mirror, and flipped `activeGeneration` onto it. The
 * generation the write was in became `superseded`, which no reader follows, so the
 * write was invisible and unreachable - and it hit all three data products. A
 * `.kdbak` restore was silently undone and a subject the learner deleted by
 * restoring came back from the mirror; a `.kdsubject` copy import vanished; a
 * `.kdtemplate` import was listed in-session and gone after one reload.
 *
 * ## Why the existing gates could not see it
 *
 * Every unit gate read the **active generation** directly. That is the write's
 * destination, and it is exactly the generation the next boot superseded. A gate
 * that reads a write's destination immediately cannot see what a later boot does
 * to it, so the whole suite could be green and the product could still be losing
 * data. The one test that would have failed is the one below: create a subject
 * through the app's own Welcome form, make a product write, **reload**, and assert
 * the subject is still listed.
 *
 * ## What each test does
 *
 * 1. **The artifact is the one it claims to be.** The recorded identity of the
 *    shared flagged build and the owner flag, checked against the served document
 *    and the entry chunk. This cannot pass against the wrong `dist`.
 * 2. **Freshness is observed, not assumed.** `indexedDB.databases()` and the
 *    `localStorage` key set are read on a same-origin *non-application* URL before
 *    any application code runs, so "fresh" is a measurement with counts in it.
 * 3. **A subject created through the Welcome form is still listed and still
 *    loads after a reload**, and the generation the device was using is still the
 *    one its pointer names. The pointer assertion is the load-bearing one: a run
 *    that re-staged a generation from the mirror flips it, and that is the defect
 *    whether or not the subject happens to survive in the rebuilt copy.
 * 4. **A `.kdtemplate` import survives a reload.** Exported and imported by the
 *    product, on the same device, then reloaded.
 * 5. **A `.kdsubject` copy import survives a reload.** Exported and imported by
 *    the product, on the same device, in its default copy mode, then reloaded.
 * 6. **A `.kdbak` restore survives a reload, and a subject the restore deleted
 *    does not come back.** The device holds two subjects; the backup holds one;
 *    the restore destroys the other; after a reload the destroyed one must still
 *    be gone. This is the worst case of the three, because the mirror still
 *    names the deleted subject and a re-migration resurrects it.
 *
 * ## How a subject is proved loadable
 *
 * Not by the name alone. The Welcome screen's list is built by loading **every**
 * subject's snapshot and deriving its room count, its cleared count, and its
 * suggested phase from what it read, so an assertion on the rendered row - the
 * learner's own name *and* the `(1/1 cleared · Suggested: Create)` line the
 * application computed - fails both when the record is gone and when it is present
 * but unreadable. A missing record falls back to rendering the identifier instead
 * of the name, which is why both halves are asserted.
 *
 * ## Evidence
 *
 * Counts, categories, identifiers, and booleans only. No header, no query string,
 * no body, no credential, no hostname, no private URL, no learner value. Every
 * value a fixture supplies is synthetic and self-describing.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type APIRequestContext, type BrowserContext, type Download, type Page } from '@playwright/test';

import { STORAGE_V2_STORAGE_CONTRACT } from './storage-v2-lane';
import { RELOAD_LANE } from './reload-persistence-lane';

const REPO_ROOT = process.cwd();
const FALLBACK_PREVIEW_ORIGIN = 'http://127.0.0.1:43183';

// ── Synthetic fixture values ───────────────────────────────────────────────
//
// One shared prefix, so the lane's own controls can find the subjects it created
// and nothing else can. The names say what they are and are never sent anywhere.

const SUBJECT_ONE_NAME = 'Reload Lane Synthetic Subject One';
const SUBJECT_ONE_TOPIC = 'Reload Lane Synthetic Root Topic One';
const SUBJECT_TWO_NAME = 'Reload Lane Synthetic Subject Two';
const SUBJECT_TWO_TOPIC = 'Reload Lane Synthetic Root Topic Two';
// The name a `.kdtemplate` import lands under, typed into the import dialog's own
// field so the lane knows it and can find the subject in the rendered list as well
// as in the database. A `.kdsubject` copy has no such field: it carries the
// subject's own name, which is a product property this lane pins rather than works
// around.
const TEMPLATE_SUBJECT_NAME = 'Reload Lane Synthetic Subject From Template';
const LISTED_NAME_PATTERN = RELOAD_LANE.interactionContract.listedSubjectName;

interface RecordedManifest {
  readonly entrypoint: { readonly path: string; readonly sha256: string; readonly bytes: number };
  readonly identity: { readonly treeSha256: string; readonly fileCount: number };
}

/** The recorded identity of the shared flagged artifact, or a named refusal. */
function readRecordedManifest(): RecordedManifest {
  const manifestPath = path.join(REPO_ROOT, RELOAD_LANE.manifestPath);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No recorded flagged-artifact identity at ${RELOAD_LANE.manifestPath}. ` +
        'Run "npm run build:storage-v2-data-products && npm run record:web-artifact:storage-v2".',
    );
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as RecordedManifest;
}

async function createFreshContext(browser: {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>;
}): Promise<BrowserContext> {
  return browser.newContext({
    acceptDownloads: true,
    viewport: { ...RELOAD_LANE.viewport },
    deviceScaleFactor: RELOAD_LANE.deviceScaleFactor,
    hasTouch: RELOAD_LANE.hasTouch,
  });
}

// ── Database probing ───────────────────────────────────────────────────────

interface DeviceObservation {
  /** What `activeGeneration` names, or `null` when it names nothing. */
  readonly activeGenerationId: string | null;
  /** Every generation the registry holds, with its status and subject count. */
  readonly generations: readonly {
    readonly id: string;
    readonly source: string;
    readonly status: string;
    readonly subjects: number;
    readonly receipts: number;
  }[];
  /** `subjectId -> subject name`, for the generation the pointer names. */
  readonly activeSubjects: Readonly<Record<string, string>>;
  /**
   * `subjectId -> sorted room ids`, for the generation the pointer names.
   *
   * Room ids are what tell a `.kdsubject` copy and a `.kdtemplate` import apart
   * from their source: the plan requires both to mint fresh identifiers, so two
   * subjects with the same name are still two independent subjects, and asserting
   * only the name would let a re-import collapse two of them into one.
   */
  readonly activeSubjectRooms: Readonly<Record<string, readonly string[]>>;
  /** Every app-owned legacy key, sorted. The mirror the app writes behind itself. */
  readonly legacyKeys: readonly string[];
  readonly databaseNames: readonly string[];
  readonly objectStoreNames: readonly string[];
}

/**
 * Read the device out of the real database.
 *
 * No application module is imported and nothing is stubbed: the probe opens the
 * database the application created, follows the pointer, and reads the record
 * envelopes the repository wrote. The contract it uses is
 * `STORAGE_V2_STORAGE_CONTRACT`, which the wiring gate pins against the real
 * source, so a renamed store would fail here rather than report "nothing here".
 *
 * The pointer and the **status of every generation** are both read, because the
 * defect is not "the record vanished" - it is "the generation the record was in
 * stopped being the generation the device uses". A lane that only counted subjects
 * in the active generation would not have seen it.
 */
async function observeDevice(page: Page): Promise<DeviceObservation> {
  return page.evaluate(async (contract) => {
    const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    const databaseNames =
      typeof factory.databases === 'function'
        ? (await factory.databases()).map((entry) => entry.name ?? '').filter((name) => name.length > 0).sort()
        : ['<unavailable>'];
    // `indexedDB.open` CREATES an empty, store-less database when none exists, so
    // the database is opened only when the list above already says it is there.
    const exists = databaseNames.includes(contract.databaseName);
    const db = exists
      ? await new Promise<IDBDatabase | null>((resolve) => {
          const request = indexedDB.open(contract.databaseName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        })
      : null;
    const legacyKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null) legacyKeys.push(key);
    }
    if (!db) {
      return {
        activeGenerationId: null,
        generations: [],
        activeSubjects: {},
        activeSubjectRooms: {},
        legacyKeys: legacyKeys.sort(),
        databaseNames,
        objectStoreNames: [],
      };
    }
    const objectStoreNames = [...db.objectStoreNames];
    const readAll = async (storeName: string): Promise<Array<Record<string, unknown>>> => {
      if (!objectStoreNames.includes(storeName)) return [];
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
    const meta = await readAll(contract.metaStore);
    const descriptors = meta
      .filter((row) => String(row.recordId).startsWith(contract.generationKeyPrefix))
      .map((row) => row.value as { generationId: string; source: string; status: string });
    const subjectRows = await readAll(contract.subjectsStore);
    const receiptRows = await readAll(contract.migrationReceiptsStore);
    const subjectNames: Record<string, Record<string, string>> = {};
    const subjectRooms: Record<string, Record<string, string[]>> = {};
    for (const row of subjectRows) {
      const generationId = String(row.generationId);
      const value = row.value as {
        subjectId?: string;
        snapshot?: { rooms?: Record<string, unknown>; dungeon?: { subjectName?: string } };
      };
      if (typeof value.subjectId !== 'string') continue;
      subjectNames[generationId] = {
        ...(subjectNames[generationId] ?? {}),
        [value.subjectId]: value.snapshot?.dungeon?.subjectName ?? '',
      };
      const rooms = value.snapshot?.rooms;
      subjectRooms[generationId] = {
        ...(subjectRooms[generationId] ?? {}),
        [value.subjectId]:
          rooms && typeof rooms === 'object' ? Object.keys(rooms).sort() : [],
      };
    }
    const activeSubjects = activeGenerationId === null ? {} : (subjectNames[activeGenerationId] ?? {});
    const activeSubjectRooms = activeGenerationId === null ? {} : (subjectRooms[activeGenerationId] ?? {});
    const generations = descriptors
      .map((descriptor) => ({
        id: descriptor.generationId,
        source: descriptor.source,
        status: descriptor.status,
        subjects: Object.keys(subjectNames[descriptor.generationId] ?? {}).length,
        receipts: receiptRows.filter((row) => row.generationId === descriptor.generationId).length,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    db.close();
    return {
      activeGenerationId,
      generations,
      activeSubjects,
      activeSubjectRooms,
      legacyKeys: legacyKeys.sort(),
      databaseNames,
      objectStoreNames,
    };
  }, STORAGE_V2_STORAGE_CONTRACT);
}

/**
 * The device in one line per generation, for a failure message.
 *
 * The defect is legible here and nowhere else: a pointer on a generation the write
 * never went into, with the generation the write *was* in sitting next to it as
 * `superseded`. Every message that asserts the pointer carries this, so a red run
 * says what the device looked like rather than only what was expected of it.
 */
function describeDevice(observation: DeviceObservation): string {
  const generations =
    observation.generations.length === 0
      ? 'none'
      : observation.generations
          .map((entry) => `${entry.id}(${entry.source}/${entry.status}, ${entry.subjects} subjects)`)
          .join('; ');
  const subjects = Object.entries(observation.activeSubjects)
    .map(([id, name]) => `${name} [${id}]`)
    .sort()
    .join(', ');
  return `pointer=${String(observation.activeGenerationId)}; generations=${generations}; active subjects=[${subjects}]`;
}

/** The one subject id on a device that holds exactly one subject. */
function sourceSubjectId(observation: DeviceObservation): string {
  const ids = Object.keys(observation.activeSubjects);
  expect(ids, `the device holds ${ids.length} subjects, so there is no single source`).toHaveLength(1);
  return ids[0] as string;
}

/** The subject id other than the source's. */
function otherSubjectId(observation: DeviceObservation, sourceId: string): string {
  const others = Object.keys(observation.activeSubjects).filter((id) => id !== sourceId);
  expect(others, `no subject other than ${sourceId} is on this device`).toHaveLength(1);
  return others[0] as string;
}

/** One generation's status, or `null` when the device has no such generation. */
function generationStatus(observation: DeviceObservation, generationId: string | null): string | null {
  if (generationId === null) return null;
  return observation.generations.find((generation) => generation.id === generationId)?.status ?? null;
}

// ── Driving the application ────────────────────────────────────────────────

/** Waits for the Welcome screen and lands on the Create / Load tab. */
async function openWelcome(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const tab = page.getByRole('tab', { name: RELOAD_LANE.interactionContract.createLoadTabName });
  await expect(tab.first()).toBeVisible();
  if ((await tab.first().getAttribute('aria-selected')) !== 'true') {
    await tab.first().click();
  }
  await expect(page.getByRole('tabpanel', { name: 'Create or load subject' })).toBeVisible();
}

/** A full page load, the thing under test. */
async function reloadApplication(page: Page): Promise<void> {
  await page.reload();
  await openWelcome(page);
}

/** Opens the Data Center and lands on one of its three tabs. */
async function openDataCenterTab(
  page: Page,
  tabName: RegExp,
): Promise<void> {
  const dataTab = page.getByRole('tab', { name: RELOAD_LANE.interactionContract.dataTabName });
  await expect(dataTab.first()).toBeVisible();
  await dataTab.first().click();
  const dataCenter = page.getByRole('button', { name: RELOAD_LANE.interactionContract.dataCenterName });
  await expect(dataCenter.first()).toBeVisible();
  await dataCenter.first().click();
  const tab = page.getByRole('tab', { name: tabName });
  await expect(tab.first()).toBeVisible();
  await tab.first().click();
}

/**
 * Creates a subject through the application's own Welcome form.
 *
 * The form, the button, and the completion signal are the application's - nothing
 * is injected. Completion is the setup checklist naming the new subject, because
 * `handleCreate` moves the screen to the Player Setup tab when it is done, so a
 * click on the tab immediately afterwards races the run that is still in flight.
 */
async function createSubjectThroughWelcomeForm(
  page: Page,
  subjectName: string,
  rootTopic: string,
): Promise<void> {
  await page.getByPlaceholder(RELOAD_LANE.interactionContract.subjectNameFieldPlaceholder).fill(subjectName);
  await page.getByPlaceholder(RELOAD_LANE.interactionContract.rootTopicFieldPlaceholder).fill(rootTopic);
  const create = page.getByRole('button', {
    name: RELOAD_LANE.interactionContract.createSubjectControlName,
  });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole('complementary', { name: RELOAD_LANE.interactionContract.setupChecklistName }),
  ).toContainText(subjectName);
  await openWelcome(page);
  await expectListed(page, subjectName);
}

/**
 * The list of subjects the Welcome screen renders, as a locator.
 *
 * Page-wide rather than scoped to a panel, and unambiguous anyway: the Welcome
 * screen keeps all four of its panels mounted and marks the unselected ones
 * `hidden`, a role query does not match a hidden element, and the only button whose
 * accessible name carries a subject name is the "Previously created" list. Every
 * other place a subject name is rendered on this screen is an `<option>`, a
 * `<strong>` in a confirmation, or a status line.
 */
function subjectRows(page: Page) {
  return page.getByRole('button', { name: LISTED_NAME_PATTERN });
}

/**
 * The subject names the Welcome screen currently lists, in rendered order.
 *
 * Each row is parsed rather than string-matched, because the row is
 * `"<name> (<cleared>/<rooms> cleared · Suggested: <phase>)"` and the second half is
 * the application's own reading of that subject's snapshot. A subject whose record
 * is gone renders its identifier instead of a name; one whose record is
 * unreadable renders zero rooms. Parsing the whole row is what makes "still listed
 * and still loads" a single measurement.
 *
 * The count is asserted by the caller, so this never reports an empty list as a
 * pass: `expectListed` and `expectListedCount` both require a non-zero count.
 */
async function listedSubjectNames(page: Page): Promise<string[]> {
  const rows = subjectRows(page);
  const count = await rows.count();
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = ((await rows.nth(index).innerText()) ?? '').replace(/\s+/g, ' ').trim();
    const match = /^(.*?)\s*\((\d+)\/(\d+) cleared · Suggested: ([A-Za-z]+)\)$/.exec(text);
    expect(match, `the listed row did not carry the application's own reading: ${text}`).not.toBeNull();
    names.push((match as RegExpExecArray)[1] as string);
  }
  return names;
}

/**
 * Asserts a subject is listed `count` times, with the row the application computed.
 *
 * `count` is a parameter because a `.kdsubject` copy carries its source's own name,
 * so a device holding a subject and its copy lists two rows with the same name -
 * which is a fact about the product worth asserting, not a locator ambiguity to
 * paper over. It is never 0: an assertion of the form "the list has as many rows as
 * it has rows" is what an empty list satisfies, and an empty list is the outcome
 * this lane exists to catch.
 */
async function expectListed(page: Page, subjectName: string, count = 1): Promise<void> {
  const row = page.getByRole('button', { name: new RegExp(`^${escapeForRegExp(subjectName)}\\b`) });
  await expect(row, `${subjectName} is not listed ${count} time(s)`).toHaveCount(count);
  // The derived half of the row: this subject's own snapshot was read, and it has
  // the one room the subject was created or imported with.
  await expect(row.first()).toContainText('(0/1 cleared');
}

/** Asserts the list holds exactly `count` subjects, and returns their names. */
async function expectListedCount(page: Page, count: number): Promise<string[]> {
  const rows = subjectRows(page);
  await expect(rows, `the subject list holds ${count} row(s)`).toHaveCount(count);
  const names = await listedSubjectNames(page);
  expect(names).toHaveLength(count);
  return names;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Downloads whichever archive the currently selected control produces. */
async function downloadFrom(
  page: Page,
  controlName: RegExp,
): Promise<{ bytes: Buffer; suggested: string }> {
  const control = page.getByRole('button', { name: controlName });
  await expect(control.first()).toBeVisible();
  const downloadPromise: Promise<Download> = page.waitForEvent('download', { timeout: 60_000 });
  await control.first().click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), suggested: download.suggestedFilename() };
}

/**
 * The subject a Data Center picker has selected, once it has read the device.
 *
 * Both tabs read the device's subjects on mount, so the picker legitimately holds
 * the empty value for a moment. Waiting for a non-empty value is what makes this a
 * measurement of the picker's own choice rather than of a race.
 */
async function selectedOptionText(page: Page, labelName: RegExp): Promise<string> {
  const picker = page.getByLabel(labelName);
  await expect(picker).toHaveCount(1);
  await expect(picker, 'the picker never read a subject off this device').not.toHaveValue('');
  return (await picker.inputValue()) as string;
}

// ── The lane ───────────────────────────────────────────────────────────────

test('the lane exercised the shared flagged artifact, with the data products on', async ({
  baseURL,
  request,
}: {
  baseURL: string | undefined;
  request: APIRequestContext;
}) => {
  expect(RELOAD_LANE.buildMode).toBe('storage-v2');
  expect(RELOAD_LANE.dataProductsV2).toBe(true);
  expect(RELOAD_LANE.acceptDownloads).toBe(true);

  // The served document must be the *recorded flagged* document, byte for byte. A
  // default build names different entry chunks, so its `index.html` hashes
  // differently and this fails - which is the property that makes every later
  // assertion in this lane an assertion about the flagged product rather than
  // about whatever happens to be in `dist`.
  const manifest = readRecordedManifest();
  const origin = new URL(baseURL ?? FALLBACK_PREVIEW_ORIGIN).origin;
  const response = await request.get(`${origin}/`);
  expect(response.ok()).toBe(true);
  const served = await response.body();
  const servedSha256 = createHash('sha256').update(served).digest('hex');
  expect(served.byteLength, 'the served document is not the recorded one').toBe(manifest.entrypoint.bytes);
  expect(servedSha256, 'the served document is not the recorded flagged document').toBe(
    manifest.entrypoint.sha256,
  );
  expect(manifest.identity.fileCount).toBeGreaterThan(0);
  expect(origin).toContain('127.0.0.1');
});

test('the device starts empty, and the observation proves it', async ({ browser }) => {
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    // A same-origin, non-application URL, so the reading is of an untouched
    // profile rather than of one the application has already written to.
    await page.goto('/assets/sprite-manifest.json');
    const before = await observeDevice(page);
    expect(before.legacyKeys).toEqual([]);
    expect(before.databaseNames).not.toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(before.activeGenerationId).toBeNull();
    expect(before.generations).toEqual([]);

    await page.goto('/');
    await openWelcome(page);
    const after = await observeDevice(page);
    expect(after.databaseNames).toContain(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(after.objectStoreNames).toContain(STORAGE_V2_STORAGE_CONTRACT.subjectsStore);
    // The application created an empty first generation and no learner records,
    // through the `hasNoLearnerContent` path - which is the shape this lane is
    // about, so it is asserted rather than assumed.
    expect(after.activeGenerationId).not.toBeNull();
    expect(after.generations).toHaveLength(1);
    expect((after.generations[0] as { status: string }).status).toBe('active');
    expect(Object.keys(after.activeSubjects)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a subject created through the Welcome form is still listed after a reload, on the same generation', async ({
  browser,
}) => {
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    await page.goto('/');
    await openWelcome(page);

    await createSubjectThroughWelcomeForm(page, SUBJECT_ONE_NAME, SUBJECT_ONE_TOPIC);
    const before = await observeDevice(page);
    expect(Object.keys(before.activeSubjects)).toHaveLength(1);
    expect(Object.values(before.activeSubjects)).toEqual([SUBJECT_ONE_NAME]);
    const generationBefore = before.activeGenerationId;

    await reloadApplication(page);

    const after = await observeDevice(page);
    // THE LOAD-BEARING ASSERTION. A second boot that re-stages a generation from
    // the legacy mirror moves this pointer and supersedes the generation the
    // subject is in, which is the defect whether or not the subject happens to
    // reappear in the rebuilt copy.
    expect(after.activeGenerationId, `the pointer moved on a reload (${describeDevice(after)})`).toBe(
      generationBefore,
    );
    expect(generationStatus(after, generationBefore), describeDevice(after)).toBe('active');
    expect(Object.values(after.activeSubjects), describeDevice(after)).toEqual([SUBJECT_ONE_NAME]);
    // And nothing was staged: the device still holds exactly the one generation it
    // held before the reload.
    expect(after.generations.map((entry) => entry.id), describeDevice(after)).toEqual([generationBefore]);

    // The application still lists it, and still loaded its snapshot to do so.
    await expectListed(page, SUBJECT_ONE_NAME);
    expect(await expectListedCount(page, 1)).toEqual([SUBJECT_ONE_NAME]);

    // A third boot is the same answer.
    await reloadApplication(page);
    const third = await observeDevice(page);
    expect(third.activeGenerationId, describeDevice(third)).toBe(generationBefore);
    expect(third.generations.map((entry) => entry.id), describeDevice(third)).toEqual([generationBefore]);
    await expectListed(page, SUBJECT_ONE_NAME);
  } finally {
    await context.close();
  }
});

test('a .kdtemplate import is still listed after a reload', async ({ browser }) => {
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    await page.goto('/');
    await openWelcome(page);
    await createSubjectThroughWelcomeForm(page, SUBJECT_ONE_NAME, SUBJECT_ONE_TOPIC);
    // The source's identifier, read before the import, so "the import created a
    // *new* subject" is a fact about identifiers rather than a guess about names.
    const sourceId = sourceSubjectId(await observeDevice(page));

    // Make the template with the product, from the subject the Welcome form made.
    await openDataCenterTab(page, RELOAD_LANE.interactionContract.templateTabName);
    const templateSource = await selectedOptionText(
      page,
      RELOAD_LANE.interactionContract.templatePickerLabel,
    );
    // The picker offers "name — N rooms"; the value is the opaque subject id.
    expect(templateSource.length).toBeGreaterThan(0);
    const { bytes, suggested } = await downloadFrom(
      page,
      RELOAD_LANE.interactionContract.downloadTemplateName,
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(suggested).not.toContain(SUBJECT_ONE_NAME);
    expect(bytes.subarray(0, 1).toString('latin1')).toBe('{');

    // Bring it back in, on this same device. The control the learner presses is
    // asserted by its accessible name; the file is then set on the input that
    // control drives, which is the only way a lane can supply a file it holds in
    // memory.
    const chooseTemplate = page.getByRole('button', {
      name: RELOAD_LANE.interactionContract.chooseTemplateFileName,
    });
    await expect(chooseTemplate.first()).toBeVisible();
    const templateInput = page.locator('input[type="file"][accept*=".kdtemplate"]');
    await expect(templateInput).toHaveCount(1);
    await templateInput.setInputFiles({
      name: 'reload-lane-template.kdtemplate',
      mimeType: 'application/json',
      buffer: bytes,
    });
    const templateDialog = page.getByRole('dialog');
    await expect(templateDialog).toBeVisible();
    // The dialog's own name field. A template exported with no name imports under
    // a default one, and a lane that asserted against a default would be asserting
    // the product's default rather than that its subject survived.
    await templateDialog
      .getByLabel(RELOAD_LANE.interactionContract.templateDestinationNameLabel)
      .fill(TEMPLATE_SUBJECT_NAME);
    const templateConfirm = page.getByRole('button', {
      name: RELOAD_LANE.interactionContract.templateConfirmName,
    });
    await expect(templateConfirm).toBeEnabled();
    await templateConfirm.click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });

    const before = await observeDevice(page);
    expect(Object.keys(before.activeSubjects)).toHaveLength(2);
    const importedId = otherSubjectId(before, sourceId);
    expect(before.activeSubjects[importedId], describeDevice(before)).toBe(TEMPLATE_SUBJECT_NAME);
    const sourceRooms = before.activeSubjectRooms[sourceId] ?? [];
    const importedRooms = before.activeSubjectRooms[importedId] ?? [];
    expect(importedRooms.length, describeDevice(before)).toBe(sourceRooms.length);
    for (const roomId of importedRooms) expect(sourceRooms).not.toContain(roomId);
    const generationBefore = before.activeGenerationId;

    await reloadApplication(page);

    const after = await observeDevice(page);
    expect(after.activeGenerationId, `the pointer moved on a reload (${describeDevice(after)})`).toBe(
      generationBefore,
    );
    expect(generationStatus(after, generationBefore), describeDevice(after)).toBe('active');
    // The imported subject had fresh identifiers and a blank graph, and it is the
    // one no legacy mirror knows about, so a migration from that mirror would have
    // dropped it. It must still be there, under its own identifier.
    expect(after.activeSubjects[importedId], describeDevice(after)).toBe(TEMPLATE_SUBJECT_NAME);
    expect(after.activeSubjects[sourceId], describeDevice(after)).toBe(SUBJECT_ONE_NAME);
    expect(after.activeSubjectRooms[importedId], describeDevice(after)).toEqual(importedRooms);
    expect(Object.keys(after.activeSubjects), describeDevice(after)).toHaveLength(2);
    expect(await expectListedCount(page, 2)).toHaveLength(2);
    await expectListed(page, SUBJECT_ONE_NAME);
    await expectListed(page, TEMPLATE_SUBJECT_NAME);
  } finally {
    await context.close();
  }
});

test('a .kdsubject copy import is still listed after a reload', async ({ browser }) => {
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    await page.goto('/');
    await openWelcome(page);
    await createSubjectThroughWelcomeForm(page, SUBJECT_ONE_NAME, SUBJECT_ONE_TOPIC);
    // The source's identifier, read before the import. A `.kdsubject` copy carries
    // the subject's own name, so the two subjects are only distinguishable by their
    // identifiers - which is the property the plan requires of a copy anyway.
    const sourceId = sourceSubjectId(await observeDevice(page));

    // Export the one subject with the product, then import it as a copy.
    await openDataCenterTab(page, RELOAD_LANE.interactionContract.subjectTabName);
    const picked = await selectedOptionText(
      page,
      RELOAD_LANE.interactionContract.subjectPickerLabel,
    );
    expect(picked.length).toBeGreaterThan(0);
    const { bytes, suggested } = await downloadFrom(
      page,
      RELOAD_LANE.interactionContract.downloadSubjectBackupName,
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(suggested).toBe('knowledge-dungeon-subject-backup.kdsubject');
    expect(suggested).not.toContain(SUBJECT_ONE_NAME);

    const chooseSubject = page.getByRole('button', {
      name: RELOAD_LANE.interactionContract.chooseSubjectBackupName,
    });
    await expect(chooseSubject.first()).toBeVisible();
    const subjectInput = page.locator('input[type="file"][accept*=".kdsubject"]');
    await expect(subjectInput).toHaveCount(1);
    await subjectInput.setInputFiles({
      name: 'reload-lane-subject.kdsubject',
      mimeType: 'application/zip',
      buffer: bytes,
    });
    const subjectDialog = page.getByRole('dialog');
    await expect(subjectDialog).toBeVisible();
    // The product's default mode is asserted rather than selected, so "create a
    // copy" is a measurement rather than a claim.
    await expect(
      page.getByRole('radio', { name: RELOAD_LANE.interactionContract.copyModeName }),
    ).toBeChecked();
    const subjectConfirm = page.getByRole('button', {
      name: RELOAD_LANE.interactionContract.copyConfirmName,
    });
    await expect(subjectConfirm).toBeEnabled();
    await subjectConfirm.click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });

    const before = await observeDevice(page);
    expect(Object.keys(before.activeSubjects)).toHaveLength(2);
    // A `.kdsubject` carries the subject's own name, so the copy and its source are
    // told apart by their **identifiers** - the plan requires them to differ - and
    // not by their names, which are the same on purpose.
    const copyId = otherSubjectId(before, sourceId);
    expect(copyId).not.toBe(sourceId);
    // The copy keeps the subject's own name - a subject backup carries the subject
    // - and mints its own room ids, which is what makes it a separate subject
    // rather than a second row with the same name.
    expect(before.activeSubjects[copyId], describeDevice(before)).toBe(SUBJECT_ONE_NAME);
    const sourceRooms = before.activeSubjectRooms[sourceId] ?? [];
    const copyRooms = before.activeSubjectRooms[copyId] ?? [];
    expect(copyRooms.length, describeDevice(before)).toBe(sourceRooms.length);
    for (const roomId of copyRooms) expect(sourceRooms).not.toContain(roomId);
    const generationBefore = before.activeGenerationId;

    await reloadApplication(page);

    const after = await observeDevice(page);
    expect(after.activeGenerationId, `the pointer moved on a reload (${describeDevice(after)})`).toBe(
      generationBefore,
    );
    expect(generationStatus(after, generationBefore), describeDevice(after)).toBe('active');
    expect(after.activeSubjects[copyId], describeDevice(after)).toBe(SUBJECT_ONE_NAME);
    expect(after.activeSubjects[sourceId], describeDevice(after)).toBe(SUBJECT_ONE_NAME);
    // ...and its own rooms, byte-identical to the ones it had before the reload.
    expect(after.activeSubjectRooms[copyId], describeDevice(after)).toEqual(copyRooms);
    expect(Object.keys(after.activeSubjects), describeDevice(after)).toHaveLength(2);
    expect(await expectListedCount(page, 2)).toHaveLength(2);
    // Two rows with the same name: the copy is listed, and it carries the subject's
    // own name. Before the fix, only one of the two was on the device at all.
    await expectListed(page, SUBJECT_ONE_NAME, 2);
  } finally {
    await context.close();
  }
});

test('a .kdbak restore survives a reload, and a subject the restore deleted does not come back', async ({
  browser,
}) => {
  const context = await createFreshContext(browser);
  try {
    const page = await context.newPage();
    await page.goto('/');
    await openWelcome(page);
    await createSubjectThroughWelcomeForm(page, SUBJECT_ONE_NAME, SUBJECT_ONE_TOPIC);

    // Take the backup while the device holds exactly one subject, then add a
    // second one. The restore below must destroy the second.
    await openDataCenterTab(page, RELOAD_LANE.interactionContract.deviceTabName);
    const { bytes, suggested } = await downloadFrom(
      page,
      RELOAD_LANE.interactionContract.downloadDeviceBackupName,
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(suggested).not.toContain(SUBJECT_ONE_NAME);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    await openWelcome(page);
    await createSubjectThroughWelcomeForm(page, SUBJECT_TWO_NAME, SUBJECT_TWO_TOPIC);
    expect(await expectListedCount(page, 2)).toHaveLength(2);

    // Restore the backup over both of them.
    await openDataCenterTab(page, RELOAD_LANE.interactionContract.deviceTabName);
    const inspectBackup = page.getByRole('button', {
      name: RELOAD_LANE.interactionContract.inspectBackupFileName,
    });
    await expect(inspectBackup.first()).toBeVisible();
    const backupInput = page.locator('input[type="file"][accept*=".kdbak"]');
    await expect(backupInput).toHaveCount(1);
    await backupInput.setInputFiles({
      name: 'reload-lane-device.kdbak',
      mimeType: 'application/zip',
      buffer: bytes,
    });
    const restoreDialog = page.getByRole('dialog');
    await expect(restoreDialog).toBeVisible();
    const confirmRestore = page.getByRole('button', {
      name: RELOAD_LANE.interactionContract.confirmRestoreName,
    });
    await expect(confirmRestore).toBeEnabled();
    await confirmRestore.click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });

    // The restore destroyed the second subject. Asserted before the reload, so the
    // reload is not being asked to do work the restore did not do.
    const afterRestore = await observeDevice(page);
    expect(Object.values(afterRestore.activeSubjects), describeDevice(afterRestore)).toEqual([
      SUBJECT_ONE_NAME,
    ]);
    expect(Object.keys(afterRestore.activeSubjectRooms), describeDevice(afterRestore)).toHaveLength(1);
    expect(await expectListedCount(page, 1), 'the restore did not remove the second subject').toEqual([
      SUBJECT_ONE_NAME,
    ]);
    const generationAfterRestore = afterRestore.activeGenerationId;

    // The mirror still names the destroyed subject - that is the whole hazard: a
    // boot that re-migrates the mirror resurrects it.
    expect(afterRestore.legacyKeys).toContain('knowledge-dungeon:v1:subjects');

    await reloadApplication(page);

    const afterReload = await observeDevice(page);
    expect(afterReload.activeGenerationId, `the pointer moved on a reload (${describeDevice(afterReload)})`).toBe(
      generationAfterRestore,
    );
    expect(generationStatus(afterReload, generationAfterRestore), describeDevice(afterReload)).toBe('active');
    // The subject the restore deleted must still be gone, and the one the backup
    // carried must still be there. The mirror still names the deleted subject, so
    // a boot that re-migrated it would bring it back - which is the worst case of
    // the three products, because the learner is the one who deleted it.
    expect(Object.values(afterReload.activeSubjects), describeDevice(afterReload)).toEqual([
      SUBJECT_ONE_NAME,
    ]);
    expect(Object.keys(afterReload.activeSubjectRooms), describeDevice(afterReload)).toHaveLength(1);
    expect(await expectListedCount(page, 1), 'the restore was undone by the reload').toEqual([
      SUBJECT_ONE_NAME,
    ]);
    await expectListed(page, SUBJECT_ONE_NAME);
    // A second reload, because the failure mode was a boot-time re-migration and
    // one reload is one boot; two is the difference between "reproduces" and
    // "always".
    await reloadApplication(page);
    const afterSecondReload = await observeDevice(page);
    expect(afterSecondReload.activeGenerationId, describeDevice(afterSecondReload)).toBe(
      generationAfterRestore,
    );
    expect(Object.values(afterSecondReload.activeSubjects), describeDevice(afterSecondReload)).toEqual([
      SUBJECT_ONE_NAME,
    ]);
    expect(Object.keys(afterSecondReload.activeSubjectRooms), describeDevice(afterSecondReload)).toHaveLength(1);
    expect(await expectListedCount(page, 1)).toEqual([SUBJECT_ONE_NAME]);
  } finally {
    await context.close();
  }
});
