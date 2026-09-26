import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import {
  ACTIVE_GENERATION_META_KEY,
  ACTIVE_GENERATION_META_OWNER,
  GENERATION_META_KEY_PREFIX,
  STORAGE_V2_DATABASE_NAME,
  STORAGE_V2_SCHEMA_VERSION,
  STORAGE_V2_STORE_NAMES,
} from '@/services/persistence/v2/schema';
import {
  ATTACHMENT_BLOB_ID_PREFIX,
  ATTACHMENT_METADATA_ID_PREFIX,
} from '@/services/persistence/v2/validation';
import {
  CURRENT_BUILD_TEST_FILE,
  SUPPORT_MATRIX,
} from './support-matrix';
import {
  STORAGE_V2_BUILD_SCRIPT,
  STORAGE_V2_ENV_FILE,
  STORAGE_V2_LANE,
  STORAGE_V2_STORAGE_CONTRACT,
  STORAGE_V2_TEST_FILE,
  STORAGE_V2_TEST_PATH,
  validateStorageV2Lane,
} from './storage-v2-lane';

/**
 * Phase 4 storage-v2 lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than
 * discovered the first time a pull request runs it. Four things must hold, and
 * each is checked against the real file, not a copy of it:
 *
 * 1. The lane declaration is internally consistent.
 * 2. The Playwright config binds exactly one project to exactly the new spec,
 *    and the DEFAULT config is untouched, so `npm run test:e2e` cannot pick the
 *    storage-v2 spec up and the current-build suite is not multiplied.
 * 3. The package scripts build the flagged artifact, record its own identity,
 *    and keep the recorded-only variant free of any build or record step.
 * 4. The CI job builds the flagged artifact itself (it cannot consume the
 *    unflagged shared artifact), on one declared host, and uploads only
 *    allowlisted sanitized evidence.
 *
 * Plus the check that makes the whole lane non-vacuous: the storage constants
 * the browser probe uses must equal the constants the application uses. If
 * `schema.ts` is renamed or re-keyed, this fails loudly instead of the lane
 * silently reporting "no active generation" forever.
 */

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const STORAGE_V2_CI_JOB = 'storage-v2-browser';

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

function readWorkflow(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8');
}

/** Splits a workflow into job blocks keyed by job id. */
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

const ciWorkflow = readWorkflow(CI_WORKFLOW_PATH);
const ciJobs = parseWorkflowJobs(ciWorkflow);

describe('Phase 4 storage-v2 lane declaration', () => {
  it('is internally consistent', () => {
    expect(validateStorageV2Lane()).toEqual([]);
    expect(STORAGE_V2_LANE.storageRepository).toBe('v2');
    expect(STORAGE_V2_LANE.worldRenderer).toBe('phaser');
    expect(STORAGE_V2_LANE.claim.length).toBeGreaterThan(80);
    expect(STORAGE_V2_LANE.doesNotProve.length).toBeGreaterThanOrEqual(4);
  });

  it('reads the storage-v2 contract the application actually uses', () => {
    // If these drift, the browser probe would look in the wrong place and every
    // storage assertion in the lane would be vacuous.
    const contract = STORAGE_V2_STORAGE_CONTRACT;
    expect(contract.databaseName).toBe(STORAGE_V2_DATABASE_NAME);
    expect(contract.schemaVersion).toBe(STORAGE_V2_SCHEMA_VERSION);
    expect(contract.activeGenerationOwner).toBe(ACTIVE_GENERATION_META_OWNER);
    expect(contract.activeGenerationKey).toBe(ACTIVE_GENERATION_META_KEY);
    expect(contract.generationKeyPrefix).toBe(GENERATION_META_KEY_PREFIX);
    expect(contract.attachmentMetadataPrefix).toBe(ATTACHMENT_METADATA_ID_PREFIX);
    expect(contract.attachmentBlobPrefix).toBe(ATTACHMENT_BLOB_ID_PREFIX);

    // The lane reads exactly the plan's store list, and reads all of it.
    for (const storeName of [
      contract.subjectsStore,
      contract.progressionStore,
      contract.sessionsStore,
      contract.preferencesStore,
      contract.shortcutsStore,
      contract.attachmentsStore,
      contract.migrationReceiptsStore,
    ]) {
      expect(STORAGE_V2_STORE_NAMES as readonly string[], storeName).toContain(storeName);
    }
    // ...and `meta` plus the nine generation-scoped stores make the whole list,
    // so a probe that stopped covering a store would fail here.
    expect(STORAGE_V2_STORE_NAMES).toHaveLength(11);
  });
});

describe('Phase 4 storage-v2 Playwright config', () => {
  it('binds exactly one project to exactly the storage-v2 spec', () => {
    const projects = (storageV2Config.projects ?? []).flat();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe(STORAGE_V2_LANE.project);
    expect(project?.use?.browserName).toBe('chromium');
    expect(project?.use?.viewport).toEqual({ ...STORAGE_V2_LANE.viewport });
    expect(project?.use?.deviceScaleFactor).toBe(STORAGE_V2_LANE.deviceScaleFactor);
    expect(project?.use?.hasTouch).toBe(STORAGE_V2_LANE.hasTouch);
    // No raw failure artifact, exactly like the compatibility projects. The
    // settings live in the config-level `use`, so both levels are checked: the
    // project must not re-enable them.
    expect(storageV2Config.use?.trace).toBe('off');
    expect(storageV2Config.use?.screenshot).toBe('off');
    expect(storageV2Config.use?.video).toBe('off');
    expect(project?.use?.trace ?? 'off').toBe('off');
    expect(project?.use?.screenshot ?? 'off').toBe('off');
    expect(project?.use?.video ?? 'off').toBe('off');

    expect(storageV2Config.testMatch).toBe(STORAGE_V2_TEST_FILE);
    expect(existsSync(path.join(REPO_ROOT, STORAGE_V2_TEST_PATH))).toBe(true);
  });

  it('previews an existing build and never decides to rebuild', () => {
    const webServer = storageV2Config.webServer;
    expect(Array.isArray(webServer)).toBe(false);
    const command = Array.isArray(webServer) ? undefined : webServer?.command;
    expect(command).toBe('npm run preview:e2e');
    expect(command).not.toContain('build');
  });

  it('leaves the default config and the current-build suite untouched', () => {
    const defaultProjects = (playwrightConfig.projects ?? []).flat().map((project) => project.name);
    // The approved support matrix is unchanged: no flagged-build project was
    // added to it, so the "one project per matrix entry" contract still holds.
    expect(defaultProjects).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    expect(defaultProjects).not.toContain(STORAGE_V2_LANE.project);
    for (const project of playwrightConfig.projects ?? []) {
      // No project in the default config is bound to the storage-v2 spec.
      expect(project.testMatch).not.toBe(STORAGE_V2_TEST_FILE);
    }
    // The default suite scripts still name only the current-build spec, so
    // `npm run test:e2e` cannot reach the storage-v2 spec.
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(STORAGE_V2_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain('playwright.storage-v2.config.ts');
    expect(npmScripts['test:e2e:recorded']).toBe(`playwright test tests/e2e/${CURRENT_BUILD_TEST_FILE}`);
  });
});

describe('Phase 4 storage-v2 package scripts', () => {
  it('builds the flagged artifact, records its own identity, and runs only the new spec', () => {
    const full = npmScripts['test:e2e:storage'];
    expect(full).toContain(`npm run ${STORAGE_V2_BUILD_SCRIPT}`);
    expect(full).toContain('record:web-artifact:storage-v2');
    expect(full).toContain('playwright.storage-v2.config.ts');
    // It must not silently become a production build.
    expect(full).not.toContain('npm run build:web ');

    const build = npmScripts[STORAGE_V2_BUILD_SCRIPT];
    expect(build).toContain('vite build --mode storage-v2');
    expect(build).not.toContain('--mode profile');
    expect(build).not.toContain('--mode electron');

    // The flagged build writes its own identity file, so the shared production
    // manifest is never overwritten by the lane.
    expect(npmScripts['record:web-artifact:storage-v2']).toContain(STORAGE_V2_LANE.manifestPath);
    expect(npmScripts['record:web-artifact']).toBe('node scripts/web-artifact-manifest.mjs write');
    expect(npmScripts['verify:web-artifact']).toBe('node scripts/web-artifact-manifest.mjs verify');
    expect(npmScripts['verify:web-artifact:storage-v2']).toContain(STORAGE_V2_LANE.manifestPath);
  });

  it('keeps the recorded-only variant free of build and record steps', () => {
    const recorded = npmScripts['test:e2e:storage:recorded'];
    expect(recorded).toBe(`playwright test --config=playwright.storage-v2.config.ts`);
    expect(recorded).not.toContain('build');
    expect(recorded).not.toContain('record:web-artifact');
  });

  it('declares the build flag in a mode file the production build never reads', () => {
    const envPath = path.join(REPO_ROOT, STORAGE_V2_ENV_FILE);
    expect(existsSync(envPath)).toBe(true);
    const env = readFileSync(envPath, 'utf8');
    expect(env).toMatch(
      new RegExp(`^\\s*${STORAGE_V2_LANE.flag}=${STORAGE_V2_LANE.flagValue}\\s*$`, 'm'),
    );
    // The production build script must not select the flagged mode.
    expect(npmScripts['build']).not.toContain(STORAGE_V2_LANE.buildMode);
    expect(npmScripts['build:web']).not.toContain(STORAGE_V2_LANE.buildMode);
  });
});

describe('Phase 4 storage-v2 CI lane (ci.yml)', () => {
  it('declares one job on one representative host that builds its own flagged artifact', () => {
    const job = ciJobs.get(STORAGE_V2_CI_JOB);
    expect(job, `${STORAGE_V2_CI_JOB} job is missing from ci.yml`).toBeDefined();
    const body = job ?? '';

    expect(body).toContain('runs-on: ubuntu-latest');
    expect(body).toContain(`npm run ${STORAGE_V2_BUILD_SCRIPT}`);
    expect(body).toContain('npm run record:web-artifact:storage-v2');
    expect(body).toContain('npm run verify:web-artifact:storage-v2');
    expect(body).toContain('npm run test:e2e:storage:recorded');
    expect(body).toContain('npx playwright install --with-deps chromium');
    expect(body).toContain('ImageOS');
    expect(body).toContain('ImageVersion');

    // It cannot consume the shared artifact: that artifact is built without the
    // flag, so the flagged lane must build and record its own.
    expect(body).not.toContain('actions/download-artifact');
    expect(body).not.toContain('name: web-artifact\n');
    expect(body).not.toContain('npm run verify:web-artifact\n');
    // The production-default build script is never invoked here, which is what
    // keeps "one production artifact per CI run" true.
    expect(body).not.toContain('npm run build:web');
    expect(body).not.toContain('electron-builder');
    expect(body).not.toContain('package:electron');

    // Exactly one upload, and it is the allowlisted sanitized evidence only.
    const uploads = body.split('actions/upload-artifact@v4').length - 1;
    expect(uploads).toBe(1);
    expect(body).toContain('path: artifacts/compatibility-evidence');
    for (const forbidden of [
      'artifacts/playwright-report',
      'artifacts/test-results',
      'artifacts/storage-v2-test-results',
      'artifacts/playwright-storage-v2-report',
      'artifacts/web-artifact-manifest.json',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the single shared production build job as the only one', () => {
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(buildJobs.map(([name]) => name)).toEqual(['web-build']);
    // The shared artifact is still uploaded exactly once.
    const sharedUploadStep = 'Upload the shared production web artifact';
    expect(ciWorkflow.split(sharedUploadStep).length - 1).toBe(1);
  });

  it('does not change the pull-request compatibility lane matrix', () => {
    // The storage lane is a plain job, not a `- id:` matrix cell, so the four
    // representative compatibility lanes are unaffected.
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);
  });
});
