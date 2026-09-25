import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import playwrightConfig from '../../playwright.config';
import {
  COMPATIBILITY_PROJECTS,
  COMPATIBILITY_TEST_FILE,
  CURRENT_BUILD_TEST_FILE,
  HOST_OPERATING_SYSTEMS,
  isPhase1CurrentBuildProject,
  PHYSICAL_DEVICE_GATES,
  PHASE_1_CURRENT_BUILD_PROJECTS,
  SUPPORT_CLAIM_BOUNDARY,
  SUPPORT_MATRIX,
  supportEntryForProject,
  validateSupportMatrix,
  type CiLane,
  type HostOperatingSystem,
} from './support-matrix';

/**
 * Phase 1A structural checks for the compatibility rails.
 *
 * These checks protect the infrastructure contract only: the approved support
 * matrix, the separation between the Phase 1 current-build suite and the
 * cross-engine compatibility suite, the Playwright projects generated from the
 * matrix, the preview-only web server, and the staged CI lanes in both workflows.
 * Every lane must consume the one artifact built and recorded by its workflow's
 * single build job, and no lane may rebuild.
 */

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const COMPATIBILITY_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/compatibility.yml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const BUILD_JOB_ID = 'web-build';
const COMPATIBILITY_BUILD_JOB_ID = 'build-web-artifact';
const SHARED_ARTIFACT_UPLOAD_STEP = 'Upload the shared production web artifact';
const SHARED_ARTIFACT_NAME = 'web-artifact';
const EVIDENCE_UPLOAD_PATH = 'path: artifacts/compatibility-evidence';
const CURRENT_BUILD_TEST_PATH = 'tests/e2e/currentBuild.spec.ts';
const COMPATIBILITY_TEST_PATH = 'tests/e2e/compatibility.spec.ts';
const FORBIDDEN_EVIDENCE_UPLOADS = ['artifacts/playwright-report', 'artifacts/test-results'];

interface WorkflowLane {
  readonly id: string;
  readonly lane: string;
  readonly os: string;
  readonly runsOn: string;
  readonly project: string;
  readonly expectHost: string;
  readonly install: string;
  readonly installArgs: string;
}

function readWorkflow(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8');
}

/** Splits the workflow into job blocks keyed by job id. */
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

/** Reads the `matrix.include` lane entries used by the compatibility jobs. */
function parseWorkflowLanes(text: string): readonly WorkflowLane[] {
  const lanes: WorkflowLane[] = [];
  const blockPattern = /- id: ([a-z0-9_-]+)\n((?:\s+[a-z_]+: .*\n)+)/g;
  let match = blockPattern.exec(text);

  while (match) {
    const fields = new Map<string, string>();
    for (const line of match[2].split('\n')) {
      const field = /^\s+([a-z_]+):\s*(.*?)\s*$/.exec(line);
      if (field) fields.set(field[1], field[2].replace(/^'(.*)'$/, '$1'));
    }
    lanes.push({
      id: match[1],
      lane: fields.get('lane') ?? '',
      os: fields.get('os') ?? '',
      runsOn: fields.get('runs_on') ?? '',
      project: fields.get('project') ?? '',
      expectHost: fields.get('expect_host') ?? '',
      install: fields.get('install') ?? '',
      installArgs: fields.get('install_args') ?? '',
    });
    match = blockPattern.exec(text);
  }

  return lanes;
}

function triggersOf(text: string): readonly string[] {
  const lines = text.split('\n');
  const onIndex = lines.indexOf('on:');
  if (onIndex === -1) return [];
  const triggers: string[] = [];
  for (const line of lines.slice(onIndex + 1)) {
    if (/^\S/.test(line) && line.trim().length > 0) break;
    const trigger = /^ {2}([a-z_]+):/.exec(line);
    if (trigger) triggers.push(trigger[1]);
  }
  return triggers;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const ciWorkflow = readWorkflow(CI_WORKFLOW_PATH);
const compatibilityWorkflow = readWorkflow(COMPATIBILITY_WORKFLOW_PATH);
const ciJobs = parseWorkflowJobs(ciWorkflow);
const compatibilityJobs = parseWorkflowJobs(compatibilityWorkflow);
const ciLanes = parseWorkflowLanes(ciWorkflow);
const compatibilityLanes = parseWorkflowLanes(compatibilityWorkflow);
const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

const REQUIRED_PULL_REQUEST_LANES: readonly (readonly [HostOperatingSystem, string])[] = [
  ['linux', 'compat-chromium'],
  ['linux', 'compat-firefox'],
  ['macos', 'compat-webkit'],
  ['windows', 'compat-edge'],
];

const REQUIRED_RELEASE_LANES: readonly (readonly [HostOperatingSystem, string])[] = [
  ['linux', 'compat-chromium'],
  ['linux', 'compat-firefox'],
  ['macos', 'compat-chromium'],
  ['macos', 'compat-firefox'],
  ['macos', 'compat-webkit'],
  ['windows', 'compat-chromium'],
  ['windows', 'compat-firefox'],
  ['windows', 'compat-edge'],
];

function expectLaneConsistency(lanes: readonly WorkflowLane[], laneName: CiLane): void {
  for (const lane of lanes) {
    const entry = supportEntryForProject(lane.project);
    expect(entry.suite, lane.id).toBe('cross-engine-compatibility');
    expect(lane.lane, lane.id).toBe(laneName);
    expect(entry.ciLanes, lane.id).toContain(lane.lane as CiLane);
    expect(entry.hostOperatingSystems, lane.id).toContain(lane.os as HostOperatingSystem);
    expect(HOST_OPERATING_SYSTEMS, lane.id).toContain(lane.os as HostOperatingSystem);
    expect(entry.runnerLabels, lane.id).toContain(lane.runsOn);
    expect(entry.installTargets, lane.id).toContain(lane.install);
    expect(lane.expectHost, lane.id).toBe(lane.os);
  }
}

function expectLaneJobConsumesSharedArtifact(jobName: string, job: string | undefined, buildJobId: string): void {
  expect(job, jobName).toBeDefined();
  const body = job ?? '';
  expect(body, jobName).toMatch(new RegExp(`needs:\\s*\\[?${buildJobId}\\]?`));
  expect(body, jobName).toContain('actions/download-artifact@v4');
  expect(body, jobName).toContain(`name: ${SHARED_ARTIFACT_NAME}`);
  expect(body, jobName).toContain('npm run verify:web-artifact');
  expect(body, jobName).not.toContain('npm run build:web');
  expect(body, jobName).not.toContain('electron-builder');
  expect(body, jobName).not.toContain('package:electron');
  expect(body, jobName).toContain('ImageOS');
  expect(body, jobName).toContain('ImageVersion');
}

describe('Phase 1A web support matrix', () => {
  it('declares every lane without contradictions', () => {
    expect(validateSupportMatrix()).toEqual([]);
  });

  it('preserves the verified Phase 1 viewport projects unchanged', () => {
    const expectedPhase1Viewports: Readonly<Record<string, { width: number; height: number }>> = {
      'desktop-chromium': { width: 1440, height: 900 },
      chromebook: { width: 1366, height: 768 },
      tablet: { width: 834, height: 1112 },
      'tablet-landscape': { width: 1112, height: 834 },
    };

    for (const project of PHASE_1_CURRENT_BUILD_PROJECTS) {
      const entry = supportEntryForProject(project);
      expect(entry.suite, project).toBe('phase-1-current-build');
      expect(entry.engine, project).toBe('chromium');
      expect(entry.channel, project).toBe('playwright-bundled');
      expect(entry.viewport, project).toEqual(expectedPhase1Viewports[project]);
      expect(entry.deviceScaleFactor, project).toBe(1);
      expect(entry.evidenceClass, project).toBe('emulated-viewport');
      expect(entry.hostOperatingSystems, project).toEqual(['linux']);
    }

    expect(supportEntryForProject('tablet').hasTouch).toBe(true);
    expect(supportEntryForProject('tablet-landscape').hasTouch).toBe(true);
    expect(supportEntryForProject('desktop-chromium').hasTouch).toBe(false);
  });

  it('keeps the current-build and compatibility suites disjoint', () => {
    for (const project of PHASE_1_CURRENT_BUILD_PROJECTS) {
      expect(isPhase1CurrentBuildProject(project)).toBe(true);
      expect(COMPATIBILITY_PROJECTS as readonly string[]).not.toContain(project);
    }
    for (const project of COMPATIBILITY_PROJECTS) {
      expect(supportEntryForProject(project).suite).toBe('cross-engine-compatibility');
    }
    expect(CURRENT_BUILD_TEST_FILE).not.toBe(COMPATIBILITY_TEST_FILE);
  });

  it('labels engine, channel, and emulation evidence explicitly', () => {
    const webkit = supportEntryForProject('compat-webkit');
    expect(webkit.engine).toBe('webkit');
    expect(webkit.channel).toBe('playwright-bundled');
    expect(webkit.channelOption).toBeUndefined();
    expect(webkit.evidenceClass).toBe('engine-automation');
    expect(webkit.doesNotProve.join(' ')).toMatch(/not a safari/i);

    const edge = supportEntryForProject('compat-edge');
    expect(edge.engine).toBe('chromium');
    expect(edge.channel).toBe('microsoft-edge-stable');
    expect(edge.channelOption).toBe('msedge');
    expect(edge.evidenceClass).toBe('branded-channel-automation');
    expect(edge.hostOperatingSystems).toEqual(['windows']);
  });

  it('keeps physical-device gates manual and bounded', () => {
    expect(PHYSICAL_DEVICE_GATES.length).toBeGreaterThanOrEqual(5);
    for (const gate of PHYSICAL_DEVICE_GATES) {
      expect(gate.automated).toBe(false);
      expect(gate.targetPhase).toMatch(/^Phase \d/);
      expect(gate.requirement.length).toBeGreaterThan(20);
      expect(gate.reason.length).toBeGreaterThan(20);
      expect(
        SUPPORT_MATRIX.some((entry) => entry.evidenceClass === 'physical-device-manual'),
      ).toBe(false);
    }
    expect(SUPPORT_CLAIM_BOUNDARY.join(' ')).toMatch(/not Safari release/i);
    expect(SUPPORT_CLAIM_BOUNDARY.join(' ')).toMatch(/not physical-device/i);
  });
});

describe('Playwright projects generated from the support matrix', () => {
  const projects = (playwrightConfig.projects ?? []).filter(
    (project): project is typeof project & { name: string } => typeof project.name === 'string',
  );

  it('declares exactly one project per matrix entry, in matrix order', () => {
    expect(projects.map((project) => project.name)).toEqual(
      SUPPORT_MATRIX.map((entry) => entry.project),
    );
  });

  it('keeps each project bound to the suite that owns it', () => {
    for (const project of projects) {
      const entry = supportEntryForProject(project.name);
      expect(project.testMatch, project.name).toBe(
        isPhase1CurrentBuildProject(project.name) ? CURRENT_BUILD_TEST_FILE : COMPATIBILITY_TEST_FILE,
      );
      expect(project.use?.browserName, project.name).toBe(entry.engine);
      expect(project.use?.viewport, project.name).toEqual({ ...entry.viewport });
      expect(project.use?.deviceScaleFactor, project.name).toBe(entry.deviceScaleFactor);
      expect(project.use?.hasTouch, project.name).toBe(entry.hasTouch);
      expect(project.use?.channel, project.name).toBe(entry.channelOption);
      expect(project.use?.isMobile ?? false, project.name).toBe(entry.isMobileEmulation);
    }
  });

  it('disables raw failure artifacts only for compatibility projects', () => {
    for (const project of projects) {
      const isCompatibility = !isPhase1CurrentBuildProject(project.name);
      if (isCompatibility) {
        expect(project.use?.trace, project.name).toBe('off');
        expect(project.use?.screenshot, project.name).toBe('off');
        expect(project.use?.video, project.name).toBe('off');
      } else {
        expect(project.use?.trace, project.name).not.toBe('off');
        expect(project.use?.screenshot, project.name).not.toBe('off');
      }
    }
  });

  it('always previews an existing build instead of deciding whether to rebuild', () => {
    const webServer = playwrightConfig.webServer;
    expect(Array.isArray(webServer)).toBe(false);
    const command = Array.isArray(webServer) ? undefined : webServer?.command;
    expect(command).toBe('npm run preview:e2e');
    expect(command).not.toContain('build:web');
  });

  it('lets package scripts own the build and record steps', () => {
    expect(npmScripts['test:e2e']).toContain('npm run build:web');
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e:recorded']).toBe(`playwright test ${CURRENT_BUILD_TEST_PATH}`);
    expect(npmScripts['test:e2e:compat']).toContain('npm run build:web');
    expect(npmScripts['test:e2e:compat']).toContain('npm run record:web-artifact');
    expect(npmScripts['test:e2e:compat']).toContain(COMPATIBILITY_TEST_FILE);
    expect(npmScripts['test:e2e:compat:recorded']).toBe(`playwright test ${COMPATIBILITY_TEST_PATH}`);
    for (const script of ['test:e2e:recorded', 'test:e2e:compat:recorded']) {
      expect(npmScripts[script], script).not.toContain('build:web');
      expect(npmScripts[script], script).not.toContain('record:web-artifact');
    }
  });
});

describe('staged pull-request compatibility lanes (ci.yml)', () => {
  it('runs on pull requests and keeps the Phase 1 current-build browser smoke', () => {
    expect(triggersOf(ciWorkflow)).toContain('pull_request');
    expect(ciJobs.has('browser-smoke')).toBe(true);
    const browserSmoke = ciJobs.get('browser-smoke') ?? '';
    expect(browserSmoke).toContain('npm run test:e2e:recorded');
    expect(browserSmoke).not.toContain('compat-chromium');
  });

  it('declares the four representative pull-request lanes', () => {
    const covered = new Set(ciLanes.map((lane) => `${lane.os}:${lane.project}`));
    expect(ciLanes).toHaveLength(REQUIRED_PULL_REQUEST_LANES.length);
    for (const [os, project] of REQUIRED_PULL_REQUEST_LANES) {
      expect(covered.has(`${os}:${project}`), `pull-request ${os}/${project}`).toBe(true);
    }
    expectLaneConsistency(ciLanes, 'pull-request');
  });

  it('makes both suites consume the one artifact built by the CI build job', () => {
    const buildJob = ciJobs.get(BUILD_JOB_ID);
    expect(buildJob).toBeDefined();
    expect(buildJob).toContain('npm run build:web');
    expect(buildJob).toContain('npm run record:web-artifact');
    expect(buildJob).toContain(SHARED_ARTIFACT_UPLOAD_STEP);
    expect(buildJob).toContain(`name: ${SHARED_ARTIFACT_NAME}`);
    expect(occurrences(ciWorkflow, SHARED_ARTIFACT_UPLOAD_STEP)).toBe(1);

    expectLaneJobConsumesSharedArtifact('browser-smoke', browserSmokeText(), BUILD_JOB_ID);
    const compatibilityJob = ciJobs.get('compatibility-pr') ?? '';
    expect(compatibilityJob).toContain('runs-on: ${{ matrix.runs_on }}');
    expectLaneJobConsumesSharedArtifact(
      'compatibility-pr',
      compatibilityJob,
      BUILD_JOB_ID,
    );

    // Only the build job may produce the production bundle.
    for (const [name, body] of ciJobs) {
      if (name === BUILD_JOB_ID) continue;
      expect(body, name).not.toContain('npm run build:web');
    }
  });

  it('uploads only allowlisted sanitized compatibility evidence', () => {
    const compatibilityJob = ciJobs.get('compatibility-pr') ?? '';
    expect(compatibilityJob).toContain(EVIDENCE_UPLOAD_PATH);
    for (const forbidden of FORBIDDEN_EVIDENCE_UPLOADS) {
      expect(compatibilityJob, forbidden).not.toContain(forbidden);
    }
  });

  function browserSmokeText(): string {
    return ciJobs.get('browser-smoke') ?? '';
  }
});

describe('staged release-candidate compatibility lanes (compatibility.yml)', () => {
  it('runs only on a schedule or on demand, never on pull requests', () => {
    const triggers = triggersOf(compatibilityWorkflow);
    expect(triggers).toContain('schedule');
    expect(triggers).toContain('workflow_dispatch');
    expect(triggers).not.toContain('pull_request');
  });

  it('declares the full release matrix', () => {
    const covered = new Set(compatibilityLanes.map((lane) => `${lane.os}:${lane.project}`));
    expect(compatibilityLanes).toHaveLength(REQUIRED_RELEASE_LANES.length);
    for (const [os, project] of REQUIRED_RELEASE_LANES) {
      expect(covered.has(`${os}:${project}`), `release ${os}/${project}`).toBe(true);
    }
    expectLaneConsistency(compatibilityLanes, 'scheduled-release');
  });

  it('makes every release cell consume the one artifact built by its build job', () => {
    const buildJob = compatibilityJobs.get(COMPATIBILITY_BUILD_JOB_ID);
    expect(buildJob).toBeDefined();
    expect(buildJob).toContain('npm run build:web');
    expect(buildJob).toContain('npm run record:web-artifact');
    expect(buildJob).toContain(SHARED_ARTIFACT_UPLOAD_STEP);
    expect(buildJob).toContain(`name: ${SHARED_ARTIFACT_NAME}`);
    expect(occurrences(compatibilityWorkflow, SHARED_ARTIFACT_UPLOAD_STEP)).toBe(1);

    expectLaneJobConsumesSharedArtifact(
      'release-candidate-compatibility',
      compatibilityJobs.get('release-candidate-compatibility'),
      COMPATIBILITY_BUILD_JOB_ID,
    );

    for (const [name, body] of compatibilityJobs) {
      if (name === COMPATIBILITY_BUILD_JOB_ID) continue;
      expect(body, name).not.toContain('npm run build:web');
    }
  });

  it('uploads only allowlisted sanitized compatibility evidence', () => {
    const laneJob = compatibilityJobs.get('release-candidate-compatibility') ?? '';
    expect(laneJob).toContain(EVIDENCE_UPLOAD_PATH);
    for (const forbidden of FORBIDDEN_EVIDENCE_UPLOADS) {
      expect(laneJob, forbidden).not.toContain(forbidden);
    }
  });
});
