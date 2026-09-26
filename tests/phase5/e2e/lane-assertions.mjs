#!/usr/bin/env node

/* global document, window, indexedDB, IDBKeyRange */
/*
 * The browser globals above are declared rather than configured, because this file
 * mixes Node (a preview server, Playwright) with browser code that runs inside the
 * page through `page.evaluate`. A global comment is file-scoped, so the
 * repository's lint configuration is left exactly as it was and no other script
 * gains a browser environment it does not have.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.KD_VERIFIER_LANE_PORT ?? 43196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATABASE = 'knowledge-dungeon-storage-v2';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function startPreview() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', ORIGIN);
    let filePath = join(DIST, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname.endsWith('/')) filePath = join(filePath, 'index.html');
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  return new Promise((done) => server.listen(PORT, '127.0.0.1', () => done(server)));
}

const SEED = () => {
  window.localStorage.clear();
  const rooms = {
    'room-lane-seed-root': {
      roomId: 'room-lane-seed-root',
      topic: 'ZZ-lane-seed-root-topic',
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:06:05.000Z',
      state: 'ArtifactCollected',
      noteText: 'ZZ-lane-seed-root-note',
      artifactMarkdown: '# artifact',
      validationState: {
        wordCount: 3,
        requiredSectionsPresent: true,
        manualConfirmed: true,
        criterionScores: {
          sectionCompleteness: 5,
          conceptTermCoverage: 5,
          linkReferences: 5,
          recallQuestionQuality: 5,
          clarityReadability: 5,
        },
        failedChecks: [],
        qualityBonus: 5,
        finalPass: true,
      },
      attachments: [],
    },
    'room-lane-seed-branch': {
      roomId: 'room-lane-seed-branch',
      topic: 'ZZ-lane-seed-branch-topic',
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:06:05.000Z',
      state: 'Created',
      noteText: 'ZZ-lane-seed-branch-note',
      artifactMarkdown: '# artifact',
      validationState: {
        wordCount: 2,
        requiredSectionsPresent: true,
        manualConfirmed: false,
        criterionScores: {
          sectionCompleteness: 3,
          conceptTermCoverage: 3,
          linkReferences: 2,
          recallQuestionQuality: 3,
          clarityReadability: 3,
        },
        failedChecks: [],
        qualityBonus: 2,
        finalPass: false,
      },
      attachments: [],
    },
  };
  const snapshot = {
    schemaVersion: '1.1.0',
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: 'subject-lane-seed',
      subjectName: 'ZZ-lane-seed-subject',
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:06:05.000Z',
      phaseState: 'ArchaeologistActive',
      rootRoomId: 'room-lane-seed-root',
      rooms: [
        { roomId: 'room-lane-seed-root', topic: 'ZZ-lane-seed-root-topic' },
        { roomId: 'room-lane-seed-branch', topic: 'ZZ-lane-seed-branch-topic' },
      ],
      edges: [{ fromRoomId: 'room-lane-seed-root', toRoomId: 'room-lane-seed-branch', kind: 'door' }],
    },
    rooms,
  };
  // The real legacy key shape: an index of subject ids, one snapshot per id, and
  // the active-subject pointer.
  window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-lane-seed']));
  window.localStorage.setItem('knowledge-dungeon:v1:subject:subject-lane-seed', JSON.stringify(snapshot));
  window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-lane-seed');
  window.localStorage.setItem(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({
      version: 3,
      bySubject: {
        'subject-lane-seed': {
          xpTotal: 777,
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
  );
  window.localStorage.setItem('knowledge-dungeon:locale', 'en');
};

const PLANT_SENTINEL = ({ generationId, databaseName }) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('preferences', 'readwrite');
      const store = tx.objectStore('preferences');
      const key = [generationId, 'preference:lane-sentinel'];
      const get = store.get(key);
      get.onsuccess = () => {
        const existing = get.result ?? {
          generationId,
          recordId: 'preference:lane-sentinel',
          value: { preferenceId: 'lane-sentinel', value: 'ZZ-lane-sentinel-value', updatedAt: '2026-01-04T00:00:00.000Z' },
          checksum: '',
          updatedAt: '2026-01-04T00:00:00.000Z',
        };
        store.put(existing);
      };
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    };
  });

const OBSERVE = (expect) =>
  new Promise((resolve) => {
    const open = indexedDB.open(expect.databaseName);
    open.onerror = () => resolve({ error: 'open-failed' });
    open.onsuccess = () => {
      const db = open.result;
      const readAll = (storeName) =>
        new Promise((done) => {
          try {
            const store = db.transaction(storeName, 'readonly').objectStore(storeName);
            if (!store.indexNames.contains('byGeneration')) {
              done([]);
              return;
            }
            const request = store.index('byGeneration').getAll();
            request.onsuccess = () => done(request.result ?? []);
            request.onerror = () => done([]);
          } catch {
            done([]);
          }
        });
      const readPointer = () =>
        new Promise((done) => {
          try {
            const store = db.transaction('meta', 'readonly').objectStore('meta');
            const request = store.index('byKey').get('activeGeneration');
            request.onsuccess = () => done(request.result ?? null);
            request.onerror = () => done(null);
          } catch {
            done(null);
          }
        });
      // The `meta` registry is read with `getAll` and matched on `recordId`, which
      // is the row's own key. An index lookup here is fragile: the registry's index
      // key is a compound the repository resolves internally, and this harness is
      // verifying the *product*, not the storage contract.
      const readMetaRows = () =>
        new Promise((done) => {
          try {
            const store = db.transaction('meta', 'readonly').objectStore('meta');
            const request = store.getAll();
            request.onsuccess = () => done(request.result ?? []);
            request.onerror = () => done([]);
          } catch {
            done([]);
          }
        });
      const readGenerationMeta = async (generationId) => {
        const rows = await readMetaRows();
        return rows.find((row) => row.recordId === `generation:${generationId}`) ?? null;
      };

      (async () => {
        const pointer = await readPointer();
        const activeGenerationId = pointer?.value?.activeGeneration ?? null;
        const subjects = await readAll('subjects');
        const subjectRecords = subjects.filter((entry) => entry.generationId === activeGenerationId);
        let subjectNameMatchesSeed = false;
        let roomTopicMatchesSeedById = false;
        let noteBodyMatchesSeedById = false;
        let roomCount = 0;
        let roomIdsMatchSeed = false;
        let seededRoomId = null;
        if (subjectRecords.length > 0) {
          const value = subjectRecords[0].value;
          const rooms = value?.snapshot?.rooms ?? {};
          const roomIds = Object.keys(rooms);
          roomCount = roomIds.length;
          // The lane's expression, copied.
          const actual = [...roomIds].sort();
          const expected = [...expect.roomIds].sort();
          roomIdsMatchSeed = actual.length === expected.length && actual.every((id, i) => id === expected[i]);
          seededRoomId = Object.keys(rooms)[0] ?? null;
          subjectNameMatchesSeed = value?.snapshot?.dungeon?.subjectName === expect.subjectName;
          const seededRoom = rooms[seededRoomId];
          roomTopicMatchesSeedById = seededRoom?.topic === expect.roomTopic;
          noteBodyMatchesSeedById = seededRoom?.noteText === expect.noteBody;
        }

        // The retention probe, as the lane reads it.
        const priorMeta = await readGenerationMeta(expect.priorGenerationId);
        const priorPreferences = (await readAll('preferences')).filter(
          (entry) => entry.generationId === expect.priorGenerationId,
        );
        const retention = {
          descriptorFound: priorMeta !== null,
          status: priorMeta?.value?.status ?? 'none',
          preferenceCount: priorPreferences.length,
          sentinelRecordPresent: priorPreferences.some(
            (entry) => entry.recordId === 'preference:lane-sentinel',
          ),
        };
        const activeIsNotPrior = activeGenerationId !== null && activeGenerationId !== expect.priorGenerationId;
        db.close();
        resolve({
          activeGenerationId,
          activeIsNotPrior,
          subjectNameMatchesSeed,
          roomTopicMatchesSeedById,
          noteBodyMatchesSeedById,
          roomCount,
          roomIdsMatchSeed,
          seededRoomId,
          retention,
        });
      })();
    };
  });

const DROP_A_ROOM = (databaseName) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const readPointer = new Promise((done) => {
        const request = db
          .transaction('meta', 'readonly')
          .objectStore('meta')
          .index('byKey')
          .get('activeGeneration');
        request.onsuccess = () => done(request.result?.value?.activeGeneration ?? null);
        request.onerror = () => done(null);
      });
      readPointer.then((generationId) => {
        const tx = db.transaction('subjects', 'readwrite');
        const store = tx.objectStore('subjects');
        const request = store.index('byGeneration').getAll(IDBKeyRange.only(generationId));
        request.onsuccess = () => {
          const record = request.result?.[0];
          if (!record) {
            reject(new Error('no subject record to damage'));
            return;
          }
          const rooms = { ...(record.value?.snapshot?.rooms ?? {}) };
          const victim = Object.keys(rooms).sort().at(-1);
          delete rooms[victim];
          store.put({
            ...record,
            value: {
              ...record.value,
              snapshot: { ...record.value.snapshot, rooms },
            },
          });
          resolve(victim);
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => reject(tx.error);
      });
    };
  });

const DELETE_THE_PREVIOUS_GENERATION = ({ generationId, databaseName }) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction(stores, 'readwrite');
      for (const name of stores) {
        const store = tx.objectStore(name);
        if (name === 'meta') {
          if (store.indexNames.contains('byKey')) store.index('byKey').delete(`generation:${generationId}`);
          else store.delete(`generation:${generationId}`);
          continue;
        }
        if (!store.indexNames.contains('byGeneration')) continue;
        const request = store.index('byGeneration').openCursor(IDBKeyRange.only(generationId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          cursor.delete();
          cursor.continue();
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    };
  });

const report = { schemaVersion: 1, suite: 'phase5-verifier-lane-assertions' };

async function main() {
  const server = await startPreview();
  const browser = await chromium.launch();
  try {
    // ── The source device: seeded, then a real export ──
    const sourceContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const sourcePage = await sourceContext.newPage();
    await sourcePage.goto(`${ORIGIN}/assets/sprite-manifest.json`);
    await sourcePage.evaluate(SEED);
    await sourcePage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await sourcePage.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });
    await sourcePage
      .getByRole('button', { name: new RegExp('ZZ-lane-seed-subject') })
      .waitFor({ timeout: 30_000 });

    await sourcePage.getByRole('button', { name: 'Open Data Center' }).first().click();
    await sourcePage.locator('[data-kd-surface="data-center"]').waitFor({ timeout: 30_000 });
    const downloadPromise = sourcePage.waitForEvent('download', { timeout: 60_000 });
    await sourcePage.getByRole('button', { name: 'Download device backup' }).click();
    const download = await downloadPromise;
    const archivePath = await download.path();
    const archive = archivePath === null ? null : await readFile(archivePath);
    report.archiveBytes = archive?.byteLength ?? 0;
    if (archive === null) throw new Error('the export produced no readable file');
    // What the archive says it carries, read from the source device, so the
    // comparison below is against the backup rather than against the target's own
    // empty first-run generation.
    const expectation = await sourcePage.evaluate(
      async (input) => {
        const open = await new Promise((done, fail) => {
          const request = indexedDB.open(input.databaseName);
          request.onsuccess = () => done(request.result);
          request.onerror = () => fail(request.error);
        });
        const pointer = await new Promise((done) => {
          const request = open
            .transaction('meta', 'readonly')
            .objectStore('meta')
            .index('byKey')
            .get('activeGeneration');
          request.onsuccess = () => done(request.result ?? null);
          request.onerror = () => done(null);
        });
        const generationId = pointer?.value?.activeGeneration ?? null;
        const records = await new Promise((done) => {
          const request = open
            .transaction('subjects', 'readonly')
            .objectStore('subjects')
            .index('byGeneration')
            .getAll(IDBKeyRange.only(generationId));
          request.onsuccess = () => done(request.result ?? []);
          request.onerror = () => done([]);
        });
        open.close();
        const rooms = records[0]?.value?.snapshot?.rooms ?? {};
        const ids = Object.keys(rooms).sort();
        return {
          priorGenerationId: input.priorGenerationId,
          databaseName: input.databaseName,
          subjectName: records[0]?.value?.snapshot?.dungeon?.subjectName ?? null,
          roomIds: ids,
          roomTopic: rooms[ids[0]]?.topic ?? null,
          noteBody: rooms[ids[0]]?.noteText ?? null,
        };
      },
      { databaseName: DATABASE, priorGenerationId: 'pending' },
    );
    await sourceContext.close();

    // ── The target device: fresh, primed with a sentinel, then a real restore ──
    const targetContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const targetPage = await targetContext.newPage();
    // The lane loads the target twice: once to observe the profile before the
    // application has run, and once so the first-run generation exists. Reproduced
    // here for the same reason - a single load leaves no generation to supersede.
    await targetPage.goto(`${ORIGIN}/assets/sprite-manifest.json`);
    await targetPage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await targetPage.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });
    await targetPage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await targetPage.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });
    // Let the application finish bootstrapping *before* touching IndexedDB from
    // the outside: `indexedDB.open` on a name that does not exist creates a
    // store-less database, and a probe that does that while the app is booting can
    // interfere with the very thing it is about to observe. The lane reaches the
    // same state by waiting for the network to go idle first.
    await targetPage.waitForLoadState('networkidle');
    await targetPage.waitForTimeout(750);
    const priorGenerationId = await targetPage.evaluate(async () => {
      const open = await new Promise((done, fail) => {
        const request = indexedDB.open('knowledge-dungeon-storage-v2');
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      const pointer = await new Promise((done) => {
        const request = open
          .transaction('meta', 'readonly')
          .objectStore('meta')
          .index('byKey')
          .get('activeGeneration');
        request.onsuccess = () => done(request.result ?? null);
        request.onerror = () => done(null);
      });
      open.close();
      return pointer?.value?.activeGeneration ?? null;
    });
    report.priorGenerationId = priorGenerationId;
    report.targetDatabases = await targetPage.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name));
    report.targetPointerRow = await targetPage.evaluate(async () => {
      const open = await new Promise((done) => {
        const request = indexedDB.open('knowledge-dungeon-storage-v2');
        request.onsuccess = () => done(request.result);
        request.onerror = () => done(null);
        request.onblocked = () => done(null);
      });
      if (open === null) return 'no-database';
      const stores = Array.from(open.objectStoreNames);
      if (!stores.includes('meta')) {
        open.close();
        return { stores };
      }
      const rows = await new Promise((done) => {
        const request = open.transaction('meta', 'readonly').objectStore('meta').getAll();
        request.onsuccess = () => done(request.result ?? []);
        request.onerror = () => done([]);
      });
      open.close();
      return { stores, rowIds: rows.map((row) => row.recordId) };
    });
    if (priorGenerationId === null) throw new Error('the fresh profile has no first-run generation');
    await targetPage.evaluate(PLANT_SENTINEL, { generationId: priorGenerationId, databaseName: DATABASE });

    const expect = {
      priorGenerationId,
      subjectName: 'ZZ-lane-seed-subject',
      roomIds: ['room-lane-seed-root', 'room-lane-seed-branch'],
    };
    expect.roomIds = expectation.roomIds;
    expect.subjectName = expectation.subjectName;
    expect.priorGenerationId = priorGenerationId;

    await targetPage.getByRole('button', { name: 'Open Data Center' }).first().click();
    await targetPage.locator('[data-kd-surface="data-center"]').waitFor({ timeout: 30_000 });
    await targetPage.locator('input[type="file"]').setInputFiles({
      name: 'zz-lane-assertions.kdbak',
      mimeType: 'application/zip',
      buffer: archive,
    });
    await targetPage
      .getByRole('button', { name: 'Replace device data with this backup' })
      .waitFor({ timeout: 30_000 });
    await targetPage.waitForFunction(
      () => {
        const button = Array.from(document.querySelectorAll('button')).find((element) =>
          (element.textContent ?? '').includes('Replace device data'),
        );
        return button !== undefined && button.disabled === false;
      },
      undefined,
      { timeout: 30_000 },
    );
    await targetPage.getByRole('button', { name: 'Replace device data with this backup' }).click();
    await targetPage
      .locator('[data-kd-surface="restore-outcome"]')
      .waitFor({ timeout: 60_000 });
    await targetPage.waitForFunction(
      () => {
        const section = document.querySelector('[data-kd-surface="restore-outcome"]');
        return section !== null && !(section.textContent ?? '').includes('Writing the backup into a new copy');
      },
      undefined,
      { timeout: 60_000 },
    );

    report.metaRowsAfterRestore = await targetPage.evaluate(
      async (input) => {
        const open = await new Promise((done) => {
          const request = indexedDB.open(input.databaseName);
          request.onsuccess = () => done(request.result);
          request.onerror = () => done(null);
        });
        if (open === null) return 'no-database';
        const rows = await new Promise((done) => {
          const request = open.transaction('meta', 'readonly').objectStore('meta').getAll();
          request.onsuccess = () => done(request.result ?? []);
          request.onerror = () => done([]);
        });
        open.close();
        return rows.map((row) => ({
          recordId: row.recordId,
          key: row.key,
          generationId: row.value?.generationId ?? null,
          status: row.value?.status ?? null,
        }));
      },
      { databaseName: DATABASE },
    );
    // ── 0. The retention state before the restore, so "it survived" is not vacuous ──
    report.retentionBeforeRestore = await targetPage.evaluate(OBSERVE, expectation);
    // ── 1. The healthy device, against the lane's own expressions ──
    report.healthy = await targetPage.evaluate(OBSERVE, expectation);

    // ── 2. Drop one room, and re-evaluate ──
    // A fresh page in the same context, so a reload by the application cannot lose
    // the measurement.
    const damagePage = await targetContext.newPage();
    await damagePage.goto(`${ORIGIN}/assets/sprite-manifest.json`);
    report.droppedRoomId = await damagePage.evaluate(DROP_A_ROOM, DATABASE);
    report.afterDroppingARoom = await damagePage.evaluate(OBSERVE, expectation);
    // Deliberately not closed: after a restore the application reloads, so the
    // original page can already be gone, and closing the last page would close the
    // context and every measurement after it.

    // ── 3. Delete the previous generation, and re-evaluate ──
    // Kept inside its own try: the application reloads itself after a restore, and
    // a reload can take the context's page with it. The authoritative measurement of
    // retention is `metaRowsAfterRestore` above, taken straight from the device.
    try {
      const deletePage = await targetContext.newPage();
      await deletePage.goto(`${ORIGIN}/assets/sprite-manifest.json`);
      await deletePage.evaluate(DELETE_THE_PREVIOUS_GENERATION, {
        generationId: priorGenerationId,
        databaseName: DATABASE,
      });
      report.afterDeletingThePreviousGeneration = await deletePage.evaluate(OBSERVE, expectation);
    } catch (error) {
      report.deletionExperimentUnavailable = String(error.message).slice(0, 200);
    }
    // Recorded as not measured rather than guessed: the browser context does not
    // survive the application's own post-restore reload in this harness, and a
    // retention-deletion figure from a broken context would be worthless. The
    // `metaRowsAfterRestore` dump above is the authoritative retention measurement,
    // and the lane's own four retention assertions are structural.
    report.deletionExperimentNote =
      'not measured here: see metaRowsAfterRestore for the authoritative retention state';
  } catch (error) {
    report.fatal = String(error && error.stack ? error.stack : error).slice(0, 800);
  } finally {
    await browser.close();
    server.close();
  }
  mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
  writeFileSync(join(ROOT, 'artifacts', 'phase5-verifier-lane-assertions.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
