/**
 * Simplified screenshot capture — avoids Phaser-heavy screens.
 * Usage: npm run dev -- --port 4173 & sleep 3 && node scripts/capture-screenshots.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4173';
const OUT_DIR = 'docs/assets/ui';
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

async function shot(name, fn) {
  const page = await context.newPage();
  try {
    await fn(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
  } finally {
    await page.close();
  }
}

// 1. Welcome screen — showing create form with biome selector
await shot('welcome-screen', async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('input[placeholder*="Subject name"]', 'Demo Subject');
  await p.fill('input[placeholder*="Root topic"]', 'Vector Spaces');
  await p.waitForTimeout(500);
});

// 2. Welcome screen — Continue to Village visible after injecting subjects
await shot('welcome-continue-to-village', async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    const id = 'screenshot-subj';
    localStorage.setItem('kd-subject-index', JSON.stringify([id]));
    localStorage.setItem(`kd-subject-${id}`, JSON.stringify({
      dungeon: { dungeonId: id, subjectName: 'Demo', rootRoomId: 'r', rooms: [{ roomId: 'r', gridX: 0, gridY: 0, width: 2, height: 2, isRoot: true }], corridors: [], schemaVersion: '1.1.0', biome: 'deepForest', tagIndex: {}, createdIso: new Date().toISOString(), updatedIso: new Date().toISOString() },
      rooms: { r: { roomId: 'r', topic: 'Root', noteText: '', validationState: { finalPass: false, manualConfirmed: false }, reviewPassCount: 0, state: 'Created', status: 'Created', attachments: [], tags: [] } },
    }));
    location.reload();
  });
  await p.waitForTimeout(800);
});

// 3. Welcome screen — template export/import in Data tab
await shot('welcome-data-tab', async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    const id = 'screenshot-subj';
    localStorage.setItem('kd-subject-index', JSON.stringify([id]));
    localStorage.setItem(`kd-subject-${id}`, JSON.stringify({
      dungeon: { dungeonId: id, subjectName: 'Demo', rootRoomId: 'r', rooms: [{ roomId: 'r', gridX: 0, gridY: 0, width: 2, height: 2, isRoot: true }], corridors: [], schemaVersion: '1.1.0', biome: 'deepForest', tagIndex: {}, createdIso: new Date().toISOString(), updatedIso: new Date().toISOString() },
      rooms: { r: { roomId: 'r', topic: 'Root', noteText: '', validationState: { finalPass: false, manualConfirmed: false }, reviewPassCount: 0, state: 'Created', status: 'Created', attachments: [], tags: [] } },
    }));
    location.reload();
  });
  await p.waitForTimeout(500);
  await p.click('button:has-text("Data")');
  await p.waitForTimeout(500);
});

console.log('Screenshots saved to', OUT_DIR);
await browser.close();
