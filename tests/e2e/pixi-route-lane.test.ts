/**
 * Phase 22 route-change teardown lane wiring and verdict teeth.
 *
 * Two claims live here. The lane's *wiring* - that the npm scripts, the config, the
 * spec, and the declaration cannot drift apart - and, more importantly, the
 * *verdict's* teeth: `evaluateRouteMemoryRun` is fed a healthy walk and a walk whose
 * worlds were left mounted, and the same function the spec calls must pass the first
 * and raise `retained-canvas` and `retained-webgl-context` on the second. A gate
 * nobody has seen fail is a gate nobody should trust, and a browser cannot be asked
 * to leak a context on demand.
 *
 * Privacy: this file reads the repository and evaluates a pure function. No browser,
 * no learner data, no network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PIXI_ROUTE_CI_BUILD_JOB,
  PIXI_ROUTE_CI_BUILD_STEP,
  PIXI_ROUTE_CI_DISCARD_STEP,
  PIXI_ROUTE_CI_DOWNLOAD_STEP,
  PIXI_ROUTE_CI_JOB,
  PIXI_ROUTE_CI_RUN_COMMAND,
  PIXI_ROUTE_CI_RUN_SCRIPT,
  PIXI_ROUTE_CI_RUN_STEP,
  PIXI_ROUTE_CI_UPLOAD_ARTIFACT,
  PIXI_ROUTE_CI_UPLOAD_STEP,
  PIXI_ROUTE_CI_VERIFY_STEP,
  PIXI_ROUTE_LANE,
  PIXI_ROUTE_LANE_FULL_SCRIPT,
  PIXI_ROUTE_LANE_RECORDED_SCRIPT,
  PIXI_ROUTE_LANE_SCRIPT,
  PIXI_ROUTE_MANIFEST_PATH,
  PIXI_ROUTE_PLAYWRIGHT_COMMAND,
  PIXI_ROUTE_PREVIEW_PORT,
  PIXI_ROUTE_RECORD_SCRIPT,
  PIXI_ROUTE_TEST_FILE,
  PIXI_ROUTE_TEST_PATH,
  PIXI_ROUTE_VERIFY_SCRIPT,
  validatePixiRouteLane,
} from './pixi-route-lane';
import {
  DOWNLOAD_DECLARATION,
  UPLOAD_DECLARATION,
  auditJobTransfers,
} from './artifact-transfer-wiring';
import { PHASE10_MEDIA_PREVIEW_PORT } from './phase10-media-lane';
import { PIXI_PERF_PREVIEW_PORT } from './pixi-perf-lane';
import { evaluateRouteMemoryRun, type RouteMemorySample } from './pixi-memory-series';

const REPO_ROOT = process.cwd();
const npmScripts = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const specSource = readFileSync(path.join(REPO_ROOT, PIXI_ROUTE_TEST_PATH), 'utf8');
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');

/** Splits the workflow into job blocks keyed by job id. The shape every sibling gate uses. */
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

/** The text of one named step in a job, up to the next step. */
function stepBlockFor(jobBody: string, stepName: string): string {
  const index = jobBody.indexOf(`name: ${stepName}`);
  if (index === -1) throw new Error(`The job has no step named ${stepName}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

const ciJobs = parseWorkflowJobs(ciWorkflow);

function sample(overrides: Partial<RouteMemorySample> = {}): RouteMemorySample {
  return {
    step: 1,
    world: 'dungeon',
    worldPresented: true,
    liveCanvasCount: 1,
    expectedLiveCanvasCount: 1,
    applicationsCreated: 2,
    applicationsReleased: 1,
    applicationsRetained: 1,
    expectsPixiApplication: true,
    liveCanvasIsNew: true,
    previous: {
      world: 'dungeon',
      canvasConnected: false,
      contextKind: 'webgl2',
      contextLost: true,
    },
    ...overrides,
  };
}

describe('pixi route lane declaration', () => {
  it('is internally consistent and claims a bounded scope', () => {
    expect(validatePixiRouteLane()).toEqual([]);
    expect(PIXI_ROUTE_LANE.flags).toEqual(['VITE_PIXI_DUNGEON', 'VITE_PIXI_FISHING']);
    expect(PIXI_ROUTE_LANE.claim.length).toBeGreaterThan(200);
    expect(PIXI_ROUTE_LANE.doesNotProve.length).toBeGreaterThanOrEqual(4);
    expect(PIXI_ROUTE_LANE.doesNotProve.join(' ')).toMatch(/village/i);
    expect(PIXI_ROUTE_LANE.doesNotProve.join(' ')).toMatch(/GPU memory/i);
  });

  it('exposes the lane under the repository test:e2e naming, preview-only in CI', () => {
    for (const script of [PIXI_ROUTE_LANE_SCRIPT, PIXI_ROUTE_LANE_FULL_SCRIPT, PIXI_ROUTE_LANE_RECORDED_SCRIPT]) {
      expect(npmScripts[script], `package.json has no ${script} script`).toBeDefined();
    }
    expect(PIXI_ROUTE_LANE_RECORDED_SCRIPT).toBe(`${PIXI_ROUTE_LANE_SCRIPT}:recorded`);
    expect(PIXI_ROUTE_LANE_FULL_SCRIPT).toBe(`${PIXI_ROUTE_LANE_SCRIPT}:full`);
    // The preview-only scripts verify a recorded identity and then measure; neither
    // rebuilds, so CI cannot re-measure a different artifact than the one recorded.
    for (const script of [PIXI_ROUTE_LANE_SCRIPT, PIXI_ROUTE_LANE_RECORDED_SCRIPT]) {
      expect(npmScripts[script]).toContain('verify:web-artifact:pixi-route');
      expect(npmScripts[script]).not.toContain('build:web');
      expect(npmScripts[script]).not.toContain('record:web-artifact');
      expect(npmScripts[script]).toContain(PIXI_ROUTE_PLAYWRIGHT_COMMAND);
    }
    expect(npmScripts[PIXI_ROUTE_LANE_FULL_SCRIPT]).toContain('build:web:pixi-route');
  });
});

describe('the route verdict is not vacuous', () => {
  it('passes a healthy two-transition walk, so the floor is not trivially red', () => {
    const healthy: RouteMemorySample[] = [
      sample({ step: 0, previous: null, liveCanvasIsNew: true }),
      sample({ step: 1, world: 'village', expectsPixiApplication: false }),
    ];
    expect(evaluateRouteMemoryRun(healthy)).toEqual([]);
  });

  it('flags a world whose canvas outlived the route', () => {
    const codes = evaluateRouteMemoryRun([
      sample({ previous: { world: 'dungeon', canvasConnected: true, contextKind: 'webgl2', contextLost: true } }),
    ]).map((entry) => entry.code);
    expect(codes).toContain('retained-canvas');
  });

  it('flags a world whose WebGL context outlived the route', () => {
    const codes = evaluateRouteMemoryRun([
      sample({ previous: { world: 'dungeon', canvasConnected: false, contextKind: 'webgl2', contextLost: false } }),
    ]).map((entry) => entry.code);
    expect(codes).toContain('retained-webgl-context');
  });

  it('flags a canvas-count mismatch, a missing renderer, and an unmeasured run', () => {
    expect(
      evaluateRouteMemoryRun([sample({ liveCanvasCount: 3, expectedLiveCanvasCount: 1 })]).map((e) => e.code),
    ).toContain('canvas-count-mismatch');
    expect(
      evaluateRouteMemoryRun([sample({ applicationsRetained: 0 })]).map((e) => e.code),
    ).toContain('no-application-retained');
    expect(evaluateRouteMemoryRun([]).map((e) => e.code)).toContain('unmeasured-route-run');
  });
});

describe('the route spec drives the walk through the shared verdict', () => {
  it('navigates the real route and reads the previous world', () => {
    expect(specSource).toContain('walkToStructureAndPress');
    expect(specSource).toContain('WALK_SPAWN_TO_SW_POND');
    expect(specSource).toContain('evaluateRouteMemoryRun');
    expect(specSource).toContain('isContextLost');
  });

  it('has seen itself fail, on a world left mounted', () => {
    expect(specSource).toContain('a world left mounted is reported as retained');
    for (const code of ['retained-canvas', 'retained-webgl-context']) {
      expect(specSource, code).toContain(code);
    }
  });

  it('verifies the recorded artifact and never skips', () => {
    expect(specSource).toContain('web-artifact-manifest.mjs');
    expect(specSource).toContain(").toBe('match')");
    expect(specSource).not.toContain('test.skip');
    expect(specSource).not.toContain('test.fixme');
  });

  it('keeps the privacy discipline: no egress, synthetic UI state only', () => {
    expect(specSource).not.toContain('http://');
    expect(specSource).not.toContain('https://');
    expect(specSource).not.toContain('request.postData');
    for (const field of ['subjectName', 'rootTopic', 'dungeonId', 'email', 'password', 'Authorization']) {
      expect(specSource, field).not.toContain(field);
    }
    expect(PIXI_ROUTE_TEST_FILE.endsWith('.spec.ts')).toBe(true);
  });
});

describe('lazy world loading feedback', () => {
  // Phase 22's "add asset and loading progress where needed", answered with evidence
  // rather than a widget. Every lazy world chunk on the flagged routes already shows an
  // accessible loading status while it is fetched, and the asset bundles those worlds
  // request are procedural (instant), so there is no user-visible gap to fill and a new
  // progress surface would be progress on something already instant. This guard pins
  // the feedback that exists, so a future change that removes one fails `npm test`.
  const screens = [
    ['src/ui/screens/GameScreen.tsx', 'Loading the dungeon…', 'dungeon'],
    ['src/ui/screens/VillageScreen.tsx', 'Loading the village…', 'village'],
    ['src/ui/screens/PixiFishingLane.tsx', 'Loading the fishing pond…', 'fishing-pond'],
  ] as const;

  for (const [file, sentence, id] of screens) {
    it(`${id} shows an accessible loading status while its chunk loads`, () => {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} no longer shows "${sentence}"`).toContain(sentence);
      // The fallback must be announced: a status role, not a bare paragraph.
      const index = source.indexOf(sentence);
      const before = source.slice(Math.max(0, index - 200), index);
      expect(before, `${sentence} is not in a role="status" fallback`).toContain('role="status"');
      // And the world itself reports its own progress in words until it is ready.
      expect(source, `${file} lost its Suspense fallback`).toContain('Suspense');
    });
  }
});

describe('the Pixi route lane is wired into CI through the shared declaration', () => {
  const job = ciJobs.get(PIXI_ROUTE_CI_JOB) ?? '';
  const buildJob = ciJobs.get(PIXI_ROUTE_CI_BUILD_JOB) ?? '';

  it('builds, records, verifies and uploads the flagged artifact once, in the build job', () => {
    expect(PIXI_ROUTE_CI_BUILD_JOB).toBe('web-build');
    expect(buildJob).toContain('npm run build:web:pixi-route');
    expect(buildJob).toContain(`npm run ${PIXI_ROUTE_RECORD_SCRIPT}`);
    expect(buildJob).toContain(`npm run ${PIXI_ROUTE_VERIFY_SCRIPT}`);
    expect(buildJob).toContain(PIXI_ROUTE_CI_BUILD_STEP);
    const upload = stepBlockFor(buildJob, PIXI_ROUTE_CI_UPLOAD_STEP);
    expect(upload).toContain(`name: ${PIXI_ROUTE_CI_UPLOAD_ARTIFACT}`);
    expect(upload).toContain(PIXI_ROUTE_MANIFEST_PATH);
    expect(upload).toContain('dist');
    expect(upload).toContain('if-no-files-found: error');
    // Build-level only: no browser is installed for a flagged build, and the lane itself
    // never runs here.
    expect(buildJob).not.toContain(PIXI_ROUTE_CI_RUN_COMMAND);
  });

  it('downloads, verifies and runs that one artifact in the browser job', () => {
    expect(PIXI_ROUTE_CI_JOB).toBe('browser-smoke');
    const download = stepBlockFor(job, PIXI_ROUTE_CI_DOWNLOAD_STEP);
    expect(download).toContain(`name: ${PIXI_ROUTE_CI_UPLOAD_ARTIFACT}`);
    expect(download).toMatch(/^\s*uses: actions\/download-artifact@v4$/m);
    expect(stepBlockFor(job, PIXI_ROUTE_CI_VERIFY_STEP)).toContain(
      `npm run ${PIXI_ROUTE_VERIFY_SCRIPT}`,
    );
    const run = stepBlockFor(job, PIXI_ROUTE_CI_RUN_STEP);
    expect(run).toContain(PIXI_ROUTE_CI_RUN_COMMAND);
    // The lane previews and measures: no build, no record, no second download.
    for (const forbidden of [
      'download-artifact',
      'npm run build:',
      'record:web-artifact',
      'continue-on-error',
    ]) {
      expect(run, `${PIXI_ROUTE_CI_RUN_STEP}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('orders the discard, download, verify and lane run correctly', () => {
    const order = [
      PIXI_ROUTE_CI_DISCARD_STEP,
      `name: ${PIXI_ROUTE_CI_DOWNLOAD_STEP}`,
      `name: ${PIXI_ROUTE_CI_VERIFY_STEP}`,
      `name: ${PIXI_ROUTE_CI_RUN_STEP}`,
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = job.indexOf(marker);
      expect(at, `${marker} is missing from ${PIXI_ROUTE_CI_JOB}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('holds both artifact movements as the shared declaration, not a count', () => {
    expect(
      auditJobTransfers(ciWorkflow, PIXI_ROUTE_CI_JOB, DOWNLOAD_DECLARATION),
      'browser-smoke moves something other than the declared downloads',
    ).toEqual([]);
    expect(
      auditJobTransfers(ciWorkflow, PIXI_ROUTE_CI_BUILD_JOB, UPLOAD_DECLARATION),
      'web-build uploads something other than the declared artifacts',
    ).toEqual([]);
  });

  it('leaves no step in the browser job exempt from failing', () => {
    expect([...job.matchAll(/^\s*continue-on-error\s*:/gm)].length, 'a step is exempt').toBe(0);
  });

  it('keeps the route artifact and its lane disjoint from every other release path', () => {
    // Exactly two mentions of the artifact name: the one upload and the one download,
    // so no other lane can be pointed at this build by accident.
    expect(ciWorkflow.split(`name: ${PIXI_ROUTE_CI_UPLOAD_ARTIFACT}`).length - 1).toBe(2);
    // The run command appears exactly once, in the lane's own step, and the build script
    // exactly once, in the one job allowed to build.
    expect(ciWorkflow.split(PIXI_ROUTE_CI_RUN_COMMAND).length - 1).toBe(1);
    expect(ciWorkflow.split('npm run build:web:pixi-route').length - 1).toBe(1);
    expect(PIXI_ROUTE_CI_RUN_SCRIPT).toBe(PIXI_ROUTE_LANE_RECORDED_SCRIPT);
    // The preview port is its own. It collided with the Phase 10 media lane's when this
    // lane was first declared, and a shared port is a shared preview server: two lanes on
    // one port is two lanes measuring each other's artifact. The perf lane's port is
    // checked too, since the two Phase 22 browser lanes are the pair most likely to run
    // back to back.
    expect(PIXI_ROUTE_PREVIEW_PORT).not.toBe(PHASE10_MEDIA_PREVIEW_PORT);
    expect(PIXI_ROUTE_PREVIEW_PORT).not.toBe(PIXI_PERF_PREVIEW_PORT);
  });
});
