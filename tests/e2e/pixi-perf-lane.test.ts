/**
 * Phase 22 Pixi-dungeon frame-time lane wiring and non-vacuity.
 *
 * A lane that is added but never executed is read as coverage, and a **measurement**
 * lane whose verdict cannot fail is worse than no lane: it produces a green number that
 * says nothing. This file therefore holds three families of claim, and the third is the
 * one the workstream exists for.
 *
 * 1. **Wiring.** The package scripts that build, record, verify and run the lane exist;
 *    the Playwright config previews an artifact and blocks service workers; the CI
 *    moves exactly one declared artifact through the shared transfer declaration.
 * 2. **The fixture is real.** `buildPerfSubjectSnapshot` is fed to the **application's
 *    own** `generateDungeonMap` (and its `createRootDungeon`/`addLinkedRooms`
 *    equivalent) and must produce exactly the declared room count, so the fixture the
 *    lane measures cannot drift from the production graph schema.
 * 3. **Non-vacuity (the red proofs).** `evaluatePerfRun` is driven with degenerate
 *    measurements and must raise the specific finding for each: no world, no canvas, no
 *    frames, too few frames, a stalled ticker, a fixture-size mismatch, an
 *    unacknowledged interaction, and each floor's breach. A green run is only evidence
 *    because each of these can be shown to turn red.
 *
 * This file reads `package.json`, `ci.yml`, and the lane's own modules. It needs no
 * browser and no `dist`.
 *
 * Privacy: synthetic values only; nothing here reads or writes learner data.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonMetadata } from '@/core/validation/persistence';
import perfConfig from './playwright.pixi-perf.config';
import {
  PERF_STORAGE_KEYS,
  PIXI_PERF_FIXTURE_SEED,
  PIXI_PERF_FIXTURE_TIMESTAMP,
  PIXI_PERF_ROOM_COUNTS,
  PIXI_PERF_SUBJECT_STORAGE_KEY,
  buildPerfSubjectSnapshot,
  fixtureDigest,
  perfRootRoomId,
} from './pixi-perf-fixtures';
import {
  PIXI_PERF_CI_BUILD_JOB,
  PIXI_PERF_CI_BUILD_STEP,
  PIXI_PERF_CI_DISCARD_STEP,
  PIXI_PERF_CI_DOWNLOAD_STEP,
  PIXI_PERF_CI_JOB,
  PIXI_PERF_CI_RUN_COMMAND,
  PIXI_PERF_CI_RUN_STEP,
  PIXI_PERF_CI_UPLOAD_ARTIFACT,
  PIXI_PERF_CI_UPLOAD_STEP,
  PIXI_PERF_CI_VERIFY_STEP,
  PIXI_PERF_LANE,
  PIXI_PERF_MANIFEST_PATH,
  PIXI_PERF_PREFLIGHT_COMMAND,
  PIXI_PERF_PREVIEW_PORT,
  PIXI_PERF_RECORD_SCRIPT,
  PIXI_PERF_VERIFY_SCRIPT,
  validatePixiPerfLane,
} from './pixi-perf-lane';
import {
  FRAME_TIME_P95_CI_FLOOR_MS,
  INTERACTION_ACK_CI_FLOOR_MS,
  MEAN_FPS_CI_FLOOR,
  PIXI_PERF_MIN_FRAMES,
  evaluatePerfRun,
  meanFpsOf,
  percentileOf,
  summarizePerfRun,
  type PerfMeasurement,
} from './pixi-perf-series';
import {
  DOWNLOAD_DECLARATION,
  UPLOAD_DECLARATION,
  auditJobTransfers,
} from './artifact-transfer-wiring';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

function parseWorkflowJobs(text: string): ReadonlyMap<string, string> {
  const lines = text.split('\n');
  const jobsIndex = lines.indexOf('jobs:');
  if (jobsIndex === -1) throw new Error('Workflow has no jobs: section.');
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

function stepBlockFor(jobBody: string, stepName: string): string {
  const index = jobBody.indexOf(`name: ${stepName}`);
  if (index === -1) throw new Error(`The job has no step named ${stepName}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

const ciJobs = parseWorkflowJobs(ciWorkflow);

/** A healthy measurement, as the verdict expects to receive it. */
function healthyMeasurement(overrides: Partial<PerfMeasurement> = {}): PerfMeasurement {
  return {
    roomCount: 100,
    worldPresented: true,
    canvasPresent: true,
    frameDeltasMs: Array.from({ length: 120 }, () => 16.6),
    tickerAdvancedMs: 1_992,
    domRoomCount: 100,
    interactionLatenciesMs: [18, 22, 31, 26, 19],
    interactionAcknowledged: true,
    ...overrides,
  };
}

const CODES = (measurement: PerfMeasurement): readonly string[] =>
  evaluatePerfRun(measurement).map((finding) => finding.code);

/* ── The fixture is real ───────────────────────────────────────────────────── */

describe('the fixture is a world the application can actually build', () => {
  it('is deterministic: the same size produces a byte-identical digest', () => {
    for (const rooms of PIXI_PERF_ROOM_COUNTS) {
      const first = buildPerfSubjectSnapshot(rooms);
      const second = buildPerfSubjectSnapshot(rooms);
      expect(fixtureDigest(first), `${rooms}`).toBe(fixtureDigest(second));
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });

  it('uses no clock: every timestamp is the declared constant', () => {
    const snapshot = buildPerfSubjectSnapshot(10);
    expect(snapshot.dungeon.createdAt).toBe(PIXI_PERF_FIXTURE_TIMESTAMP);
    expect(snapshot.dungeon.updatedAt).toBe(PIXI_PERF_FIXTURE_TIMESTAMP);
    for (const room of Object.values(snapshot.rooms)) {
      expect(room.createdAt).toBe(PIXI_PERF_FIXTURE_TIMESTAMP);
    }
  });

  it('produces exactly the declared room count through the real dungeon generator', () => {
    for (const rooms of PIXI_PERF_ROOM_COUNTS) {
      const snapshot = buildPerfSubjectSnapshot(rooms);
      const map = generateDungeonMap(snapshot.dungeon as unknown as DungeonMetadata, PIXI_PERF_FIXTURE_SEED);
      expect(map.rooms, `${rooms}-room fixture`).toHaveLength(rooms);
      // Root plus children is a tree, so every non-root room is reached by one corridor.
      expect(map.corridors).toHaveLength(rooms - 1);
      expect(map.rootRoomId).toBe(perfRootRoomId(rooms));
      // Every room is placed: a disconnected room would be sprinkled outside the BFS
      // tree and the fixture would not be the single connected world it claims.
      expect(new Set(map.rooms.map((room) => room.roomId)).size).toBe(rooms);
    }
  });

  it('matches the shape the application\'s own graph builders produce', () => {
    // The same construction the 100-room test in
    // `tests/phase13/dungeon-navigation-parity.test.ts` uses, so "reuse the existing
    // 100-room approach" is a checked equality rather than a claim.
    const root = createRootDungeon({
      dungeonId: 'synthetic-perf-parity',
      subjectName: 'Synthetic Perf Parity',
      rootRoomId: 'root',
      rootTopic: 'Root Topic',
      nowIso: PIXI_PERF_FIXTURE_TIMESTAMP,
    });
    if (!root.ok) throw new Error('root dungeon init failed');
    const grown = addLinkedRooms(root.value, {
      fromRoomId: 'root',
      drafts: Array.from({ length: 99 }, (_unused, index) => ({
        roomId: `room-${index}`,
        topic: `Room ${index}`,
      })),
      nowIso: PIXI_PERF_FIXTURE_TIMESTAMP,
    });
    if (!grown.ok) throw new Error('addLinkedRooms failed');

    const appMap = generateDungeonMap(grown.value.dungeon);
    const fixtureMap = generateDungeonMap(
      buildPerfSubjectSnapshot(100).dungeon as unknown as DungeonMetadata,
      PIXI_PERF_FIXTURE_SEED,
    );
    // Same topology, independent of the seed the layout uses: 100 rooms, 99 corridors.
    expect(fixtureMap.rooms).toHaveLength(appMap.rooms.length);
    expect(fixtureMap.corridors).toHaveLength(appMap.corridors.length);
  });

  it('rejects a nonsensical room count rather than building the wrong world', () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => buildPerfSubjectSnapshot(bad), String(bad)).toThrow();
    }
  });
});

/* ── Non-vacuity: the red proofs ───────────────────────────────────────────── */

describe('the verdict turns red for every way a run could be vacuous', () => {
  it('passes a healthy run, so the floor is not trivially red', () => {
    expect(CODES(healthyMeasurement())).toEqual([]);
  });

  it('flags a world that never presented', () => {
    expect(CODES(healthyMeasurement({ worldPresented: false }))).toContain('world-never-presented');
  });

  it('flags a document with no canvas', () => {
    expect(CODES(healthyMeasurement({ canvasPresent: false }))).toContain('no-canvas');
  });

  it('flags a run that rendered no frames at all', () => {
    const codes = CODES(healthyMeasurement({ frameDeltasMs: [] }));
    expect(codes).toContain('no-frames');
  });

  it('flags a run with too few frames to be a measurement', () => {
    const codes = CODES(healthyMeasurement({ frameDeltasMs: Array.from({ length: PIXI_PERF_MIN_FRAMES - 1 }, () => 16.6) }));
    expect(codes).toContain('too-few-frames');
  });

  it('flags a stalled ticker', () => {
    expect(CODES(healthyMeasurement({ tickerAdvancedMs: 0 }))).toContain('ticker-did-not-advance');
  });

  it('flags a world whose room count is not the fixture\'s', () => {
    expect(CODES(healthyMeasurement({ domRoomCount: 3 }))).toContain('fixture-size-mismatch');
  });

  it('flags an interaction the mirror never acknowledged', () => {
    const codes = CODES(healthyMeasurement({ interactionAcknowledged: false, interactionLatenciesMs: [] }));
    expect(codes).toContain('interaction-not-acknowledged');
  });

  it('flags a catastrophic frame-time regression at the CI floor, and nothing below it', () => {
    const over = healthyMeasurement({
      frameDeltasMs: Array.from({ length: 120 }, () => FRAME_TIME_P95_CI_FLOOR_MS + 1),
    });
    expect(CODES(over)).toContain('frame-time-over-floor');

    const under = healthyMeasurement({
      frameDeltasMs: Array.from({ length: 120 }, () => FRAME_TIME_P95_CI_FLOOR_MS - 1),
    });
    expect(CODES(under)).not.toContain('frame-time-over-floor');
  });

  it('flags a mean FPS under the CI floor', () => {
    const slow = healthyMeasurement({
      frameDeltasMs: Array.from({ length: 120 }, () => 1000 / (MEAN_FPS_CI_FLOOR / 2)),
    });
    expect(CODES(slow)).toContain('mean-fps-under-floor');
  });

  it('flags an interaction over the CI floor', () => {
    const codes = CODES(healthyMeasurement({ interactionLatenciesMs: [INTERACTION_ACK_CI_FLOOR_MS + 1] }));
    expect(codes).toContain('interaction-over-floor');
  });

  it('reports the reference targets separately from the CI floors, so neither is confused for the other', () => {
    // The 20 ms reference target is below the CI floor. A run at the reference target
    // must NOT fail, and a run above the reference target but below the floor must not
    // fail either — otherwise this lane would be the false gate the scope lock forbids.
    const atReference = healthyMeasurement({ frameDeltasMs: Array.from({ length: 120 }, () => 20) });
    expect(CODES(atReference)).toEqual([]);
    expect(FRAME_TIME_P95_CI_FLOOR_MS).toBeGreaterThan(20 * 2);
  });
});

describe('the measurement arithmetic is exact', () => {
  it('uses nearest-rank percentiles', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileOf(values, 0.5)).toBe(5);
    expect(percentileOf(values, 0.95)).toBe(10);
    expect(percentileOf(values, 1)).toBe(10);
    expect(percentileOf([], 0.5)).toBeNull();
  });

  it('computes mean FPS from positive deltas only', () => {
    expect(meanFpsOf([16, 16, 16, 16])).toBeCloseTo(62.5, 1);
    expect(meanFpsOf([0, 0])).toBeNull();
    expect(meanFpsOf([])).toBeNull();
  });

  it('summarizes a run without inventing a value for an empty sample', () => {
    const summary = summarizePerfRun({
      roomCount: 1,
      worldPresented: true,
      canvasPresent: true,
      frameDeltasMs: [],
      tickerAdvancedMs: null,
      domRoomCount: 1,
      interactionLatenciesMs: [],
      interactionAcknowledged: false,
    });
    expect(summary.frameCount).toBe(0);
    expect(summary.frameP95Ms).toBeNull();
    expect(summary.meanFps).toBeNull();
    expect(summary.interactionMaxMs).toBeNull();
  });
});

/* ── Lane declaration and config ───────────────────────────────────────────── */

describe('the lane is declared and bounded', () => {
  it('is structurally consistent', () => {
    expect(validatePixiPerfLane()).toEqual([]);
    expect(PIXI_PERF_LANE.roomCounts).toEqual([1, 10, 100]);
    expect(PIXI_PERF_LANE.doesNotProve.length).toBeGreaterThanOrEqual(8);
  });

  it('previews the artifact and blocks service workers', () => {
    expect(perfConfig.testMatch).toBe(PIXI_PERF_LANE.testFile);
    expect(perfConfig.use?.serviceWorkers).toBe('block');
    expect(perfConfig.projects?.[0]?.name).toBe(PIXI_PERF_LANE.project);
  });

  it('records no raw failure artifact', () => {
    for (const key of ['trace', 'screenshot', 'video'] as const) {
      expect(perfConfig.use?.[key], key).toBe('off');
    }
  });

  it('targets the Pixi-dungeon flagged build and its own recorded identity', () => {
    expect(PIXI_PERF_LANE.buildScript).toBe('build:web:pixi-dungeon');
    expect(PIXI_PERF_LANE.flag).toBe('VITE_PIXI_DUNGEON');
    expect(PIXI_PERF_MANIFEST_PATH).toBe('artifacts/web-artifact-manifest-pixi-dungeon.json');
    const webServer = perfConfig.webServer;
    const command = Array.isArray(webServer) ? webServer[0]?.command : webServer?.command;
    expect(command).toContain(`--port ${PIXI_PERF_PREVIEW_PORT}`);
    expect(command).toContain('--strictPort');
  });

  it('exposes the build, record, verify and run scripts', () => {
    for (const name of [
      'build:web:pixi-dungeon',
      PIXI_PERF_RECORD_SCRIPT,
      PIXI_PERF_VERIFY_SCRIPT,
      'test:e2e:pixi-perf',
      'test:e2e:pixi-perf:full',
      'test:e2e:pixi-perf:recorded',
      'test:perf',
    ]) {
      expect(pkg.scripts?.[name], name).toBeTruthy();
    }
    expect(PIXI_PERF_PREFLIGHT_COMMAND).toBe('node scripts/require-pixi-perf-lane-artifact.mjs');
  });

  it('keeps the fixture storage keys in one place and out of learner data', () => {
    expect(PERF_STORAGE_KEYS.subject).toBe(PIXI_PERF_SUBJECT_STORAGE_KEY);
    expect(PERF_STORAGE_KEYS.subject).toContain('knowledge-dungeon:v1:subject:');
  });
});

/* ── CI wiring ─────────────────────────────────────────────────────────────── */

describe('the Pixi-dungeon lane is wired into CI through the shared declaration', () => {
  const job = ciJobs.get(PIXI_PERF_CI_JOB) ?? '';
  const buildJob = ciJobs.get(PIXI_PERF_CI_BUILD_JOB) ?? '';

  it('builds, records, verifies and uploads the flagged artifact once, in the build job', () => {
    expect(buildJob).toContain('npm run build:web:pixi-dungeon');
    expect(buildJob).toContain(`npm run ${PIXI_PERF_RECORD_SCRIPT}`);
    expect(buildJob).toContain(`npm run ${PIXI_PERF_VERIFY_SCRIPT}`);
    const upload = stepBlockFor(buildJob, PIXI_PERF_CI_UPLOAD_STEP);
    expect(upload).toContain(`name: ${PIXI_PERF_CI_UPLOAD_ARTIFACT}`);
    expect(upload).toContain(PIXI_PERF_MANIFEST_PATH);
    expect(upload).toContain('dist');
    expect(buildJob).toContain(PIXI_PERF_CI_BUILD_STEP);
    expect(buildJob).not.toContain(PIXI_PERF_CI_RUN_COMMAND);
  });

  it('downloads, verifies and runs that one artifact in the browser job', () => {
    const download = stepBlockFor(job, PIXI_PERF_CI_DOWNLOAD_STEP);
    expect(download).toContain(`name: ${PIXI_PERF_CI_UPLOAD_ARTIFACT}`);
    expect(download).toMatch(/^\s*uses: actions\/download-artifact@v4$/m);
    expect(stepBlockFor(job, PIXI_PERF_CI_VERIFY_STEP)).toContain(`npm run ${PIXI_PERF_VERIFY_SCRIPT}`);
    const run = stepBlockFor(job, PIXI_PERF_CI_RUN_STEP);
    expect(run).toContain(PIXI_PERF_CI_RUN_COMMAND);
    for (const forbidden of ['download-artifact', 'npm run build:', 'record:web-artifact', 'continue-on-error']) {
      expect(run, `${PIXI_PERF_CI_RUN_STEP}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('orders the discard, download, verify and lane run correctly', () => {
    const order = [
      PIXI_PERF_CI_DISCARD_STEP,
      `name: ${PIXI_PERF_CI_DOWNLOAD_STEP}`,
      `name: ${PIXI_PERF_CI_VERIFY_STEP}`,
      `name: ${PIXI_PERF_CI_RUN_STEP}`,
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = job.indexOf(marker);
      expect(at, `${marker} is missing from ${PIXI_PERF_CI_JOB}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('holds both artifact movements as the shared declaration, not a count', () => {
    expect(
      auditJobTransfers(ciWorkflow, PIXI_PERF_CI_JOB, DOWNLOAD_DECLARATION),
      'browser-smoke moves something other than the declared downloads',
    ).toEqual([]);
    expect(
      auditJobTransfers(ciWorkflow, PIXI_PERF_CI_BUILD_JOB, UPLOAD_DECLARATION),
      'web-build uploads something other than the declared artifacts',
    ).toEqual([]);
  });

  it('leaves no step in the browser job exempt from failing', () => {
    expect([...job.matchAll(/^\s*continue-on-error\s*:/gm)].length, 'a step is exempt').toBe(0);
  });
});
