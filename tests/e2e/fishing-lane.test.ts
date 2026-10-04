/**
 * Fishing lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered the first
 * time somebody runs it. The properties below are the ones whose absence would make the lane
 * report something other than what it claims:
 *
 * 1. **The declaration is internally consistent and bounded.** Both lanes state a claim and a
 *    `doesNotProve` list, and the boundaries a reader of this gate most needs are asserted *by
 *    content* rather than by count, because a list of plausible sentences can omit the one that
 *    matters.
 * 2. **The flag is the plan's flag, its production default is still off, and the build script
 *    turns on nothing else.** `build:web:pixi-fishing` sets only `VITE_PIXI_FISHING`, which is
 *    what makes the chunk check in `vite.config.ts` the only one that could catch a missing pond
 *    chunk.
 * 3. **The Playwright configs bind exactly one project to exactly one spec**, preview an existing
 *    build on its own port, never decide to rebuild, and record no raw failure artifact.
 * 4. **Every release path stays disjoint.** The default config and the five older flagged configs
 *    each bind their own spec, so `npm run test:e2e` cannot reach either fishing spec and no
 *    existing lane is widened.
 * 5. **The npm scripts are the three shapes the repository uses**, the two preview-only scripts
 *    never build, and `:full` is the only place either artifact is produced.
 * 6. **The two artifacts cannot be confused.** Each lane has its own recorded identity and its
 *    own preflight invocation, and the rollback lane's preflight names the *production* manifest.
 * 7. **The specs measure what they say.** The keyboard-only and pointer-only flows, the
 *    keep-without-recall branch, the release branch, the Fish Stand counts, the recall route,
 *    and the privacy spy are each asserted mechanically, so a spec that quietly stopped driving
 *    one of them cannot pass this gate.
 * 8. **No skip.** There is no `test.skip` and no `test.fixme` in either spec: a lane that passes
 *    by not measuring is the failure both specs' headers say they exist to prevent.
 * 9. **Privacy.** Synthetic identifiers only, no learner-shaped field named anywhere, no external
 *    URL or request body in either spec, and every non-loopback request aborted by the guard.
 *
 * Hermeticity: reads repository files and the flag tables only. No `dist/`, no build, no browser,
 * no network.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { PlaywrightTestConfig } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import fishingConfig from './playwright.fishing.config';
import fishingRollbackConfig from './playwright.fishing-rollback.config';
import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import dataProductsConfig from '../../playwright.data-products.config';
import subjectConfig from '../../playwright.subject-product.config';
import reloadConfig from '../../playwright.reload-persistence.config';
import pixiMemoryConfig from './playwright.pixi-memory.config';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX, NON_CUTOVER_FLAG_KEYS } from '@/config/featureFlags';
import {
  PLAYER_SPEED,
  STRUCTURE_APPROACH_RADIUS,
  VILLAGE_MAP,
} from '@/data/villageLayout';
import {
  DEFAULT_VILLAGE_PLAYER_SAMPLE_MS,
  VILLAGE_PLAYER_ATTRIBUTE as PRODUCT_VILLAGE_PLAYER_ATTRIBUTE,
} from '@/ui/village/villagePlayerPosition';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX } from './support-matrix';
import { PIXI_MEMORY_TEST_FILE } from './pixi-memory-lane';
import {
  approachBursts,
  approachKey,
  burstMsFor,
  classifyChunkNames,
  parseVillagePlayerGrid,
  VILLAGE_PLAYER_ATTRIBUTE,
  VILLAGE_PLAYER_ROOT_SELECTOR,
  VILLAGE_PLAYER_SPEED,
  VILLAGE_SPAWN_GRID,
  VILLAGE_STRUCTURE_APPROACH_RADIUS,
  VILLAGE_TILE_SIZE,
  WALK_BURST_MS,
  WALK_BURST_TRAVEL_PX,
  WALK_BURST_TRAVEL_TILES,
  WALK_BURST_NEAR_MS,
  WALK_CONFIRM_SETTLE_MS,
  WALK_FISH_STAND_TO_SW_POND,
  WALK_MEASURED_BURST_TRAVEL_TILES,
  WALK_MODEL_MAX_BURSTS,
  WALK_NEAR_APPROACH_TILES,
  WALK_POLL_MS,
  WALK_RINGING_READINGS,
  WALK_SPAWN_TO_SW_POND,
  WALK_STALL_READINGS,
  WALK_SW_POND_TO_FISH_STAND,
  type WalkArrowKey,
} from './fishing-harness';
import {
  RECALL_FIXTURE_ROOM_ID,
  RECALL_FIXTURE_SUBJECT_ID,
  recallFixturePremiseFailures,
  recallFixtureSnapshot,
  recallFixtureStorageSeed,
} from './fishing-recall-fixture';
import {
  FISHING_CHUNK_PREFIX,
  FISHING_FLAG,
  FISHING_FLAG_VALUE,
  FISHING_LANE,
  FISHING_LANES,
  FISHING_MANIFEST_PATH,
  FISHING_PHASER_FALLBACK_CLASS,
  FISHING_PLAYWRIGHT_COMMAND,
  FISHING_PREVIEW_PORT,
  FISHING_PREVIEW_SCRIPT,
  FISHING_ROLLBACK_CONFIG_FILE,
  FISHING_ROLLBACK_LANE,
  FISHING_ROLLBACK_MANIFEST_PATH,
  FISHING_ROLLBACK_PREVIEW_PORT,
  FISHING_ROLLBACK_PREVIEW_SCRIPT,
  FISHING_ROLLBACK_TEST_FILE,
  FISHING_ROLLBACK_TEST_PATH,
  FISHING_TEST_FILE,
  FISHING_TEST_PATH,
  validateFishingLane,
} from './fishing-lane';

const REPO_ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const PREFLIGHT_PATH = path.join(REPO_ROOT, 'scripts/require-fishing-lane-artifact.mjs');
const MANIFEST_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/web-artifact-manifest.mjs');
const VITE_CONFIG_PATH = path.join(REPO_ROOT, 'vite.config.ts');

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

const pondSpec = readFileSync(path.join(REPO_ROOT, FISHING_TEST_PATH), 'utf8');
const rollbackSpec = readFileSync(path.join(REPO_ROOT, FISHING_ROLLBACK_TEST_PATH), 'utf8');
const harness = readFileSync(path.join(REPO_ROOT, 'tests/e2e/fishing-harness.ts'), 'utf8');

describe('fishing lane declaration', () => {
  it('both lanes are internally consistent and each claims a bounded scope', () => {
    expect(validateFishingLane(FISHING_LANE)).toEqual([]);
    expect(validateFishingLane(FISHING_ROLLBACK_LANE)).toEqual([]);
    expect(FISHING_LANES).toHaveLength(2);
    expect(FISHING_LANE.expectedRendererMode).toBe('pixi-fishing-pond');
    expect(FISHING_LANE.expectsPixiChunk).toBe(true);
    expect(FISHING_ROLLBACK_LANE.expectedRendererMode).toBe('phaser-fishing-scene');
    expect(FISHING_ROLLBACK_LANE.expectsPixiChunk).toBe(false);
    expect(FISHING_LANE.claim.length).toBeGreaterThan(200);
    expect(FISHING_ROLLBACK_LANE.claim.length).toBeGreaterThan(200);
  });

  it('states the boundaries a reader of this gate most needs, by content', () => {
    const notProven = [...FISHING_LANE.doesNotProve, ...FISHING_ROLLBACK_LANE.doesNotProve].join(' ');
    // Nothing here is a performance, layout, or accessibility result. These are the claims a
    // reader of a passing lane is most likely to over-read.
    expect(notProven).toMatch(/frame-time/i);
    expect(notProven).toMatch(/GPU-memory/i);
    expect(notProven).toMatch(/touch-target/i);
    expect(notProven).toMatch(/contrast/i);
    expect(notProven).toMatch(/320 CSS-pixel/i);
    expect(notProven).toMatch(/200 % zoom/);
    expect(notProven).toMatch(/axe/i);
    expect(notProven).toMatch(/physical device/i);
    expect(notProven).toMatch(/cross-engine/i);
    expect(notProven).toMatch(/software rasteriser/i);
    expect(notProven).toMatch(/Not Electron/i);
    // And the two claims that are *specific* to this pair.
    expect(FISHING_ROLLBACK_LANE.doesNotProve.join(' ')).toMatch(/VITE_PIXI_FISHING=true build/);
    expect(FISHING_LANE.doesNotProve.join(' ')).toMatch(/data-integrity/i);
  });

  it('records the dimensions plan section 10.4 requires of every lane', () => {
    for (const lane of FISHING_LANES) {
      expect(lane.viewport.width).toBeGreaterThan(0);
      expect(lane.viewport.height).toBeGreaterThan(0);
      expect(lane.deviceScaleFactor).toBeGreaterThan(0);
      expect(lane.engine).toBe('chromium');
      expect(lane.runnerLabels.length).toBeGreaterThan(0);
      expect(lane.installTargets).toEqual(['chromium']);
      expect(lane.evidenceClass).toBe('emulated-viewport');
      // The input modes are the parity pair plus the navigation mode, and the keyboard mode is
      // the one Phase 17's exit criterion names first.
      expect(lane.inputModes).toContain('keyboard-only');
      expect(lane.inputModes).toContain('pointer-only');
      expect(lane.inputModes).not.toContain('touch-emulated');
    }
    // ...and the spec records all of them with every test, from the same declaration.
    for (const lane of FISHING_LANES) {
      const spec = lane === FISHING_LANE ? pondSpec : rollbackSpec;
      for (const field of [
        'hostOperatingSystem',
        'architecture',
        'browserVersion',
        'browserChannel',
        'viewport',
        'deviceScaleFactor',
        'rendererMode',
        'inputMode',
      ]) {
        expect(spec, `${field} is not recorded by the spec`).toContain(field);
      }
      // The evidence lands under the allowlisted root, which is the only directory the CI job
      // uploads, so a recorded run cannot be lost and cannot smuggle a raw artifact out.
      expect(spec).toContain('recordFishingEvidence');
      expect(FISHING_TEST_PATH.startsWith('tests/e2e/')).toBe(true);
      expect(FISHING_ROLLBACK_TEST_PATH.startsWith('tests/e2e/')).toBe(true);
    }
  });

  it('the flag is the plan flag, its production default is still off, and this lane turns it on', () => {
    expect(FISHING_FLAG).toBe('VITE_PIXI_FISHING');
    expect(RUNTIME_FLAG_ENV_KEYS.pixiFishing).toBe(FISHING_FLAG);
    expect(DEFAULT_RUNTIME_CONFIG.pixiFishing).toBe(false);
    expect(FEATURE_FLAG_MATRIX.pixiFishing.productionDefault).toBe(false);
    expect(FEATURE_FLAG_MATRIX.pixiFishing.ownerPhase).toBe(17);
    expect(FEATURE_FLAG_MATRIX.pixiFishing.valueKind).toBe('boolean');
    expect(FEATURE_FLAG_MATRIX.pixiFishing.rollback).toContain('VITE_PIXI_FISHING=false');
    // A cutover gate, so it may not be on the one list permitted to default on.
    expect(NON_CUTOVER_FLAG_KEYS).not.toContain('pixiFishing');
    expect(NON_CUTOVER_FLAG_KEYS).toEqual(['audioEnabled']);
    expect(FISHING_FLAG_VALUE).toBe('true');
  });

  it('the chunk prefix and the Phaser fallback class are the two selectors the lane reads', () => {
    // Both are read off the artifact or the DOM rather than off a constant, so a rename that
    // broke either would fail every test in the lane at once rather than quietly pass. The gate
    // holds them against the sources that own them.
    const laneSource = readFileSync(path.join(REPO_ROOT, FISHING_LANE.configFile), 'utf8');
    const rollbackConfigSource = readFileSync(
      path.join(REPO_ROOT, FISHING_ROLLBACK_CONFIG_FILE),
      'utf8',
    );
    for (const source of [laneSource, rollbackConfigSource]) {
      expect(source).toContain('KD_FISHING_REPO_ROOT');
    }
    // The chunk prefix is the lazy chunk's own emitted name, so it is asserted against the
    // application module that imports it rather than against a fixture.
    const lane = readFileSync(
      path.join(REPO_ROOT, 'src/ui/screens/PixiFishingLane.tsx'),
      'utf8',
    );
    expect(lane).toContain(`import('@/renderers/pixi/fishing/FishingWorld')`);
    expect(FISHING_CHUNK_PREFIX).toBe('FishingWorld-');
    // The Phaser fallback class is the village canvas host, which the Phase 1 current-build
    // suite already selects on, and both specs read it through the one declaration.
    expect(FISHING_PHASER_FALLBACK_CLASS).toBe('village-canvas');
    expect(pondSpec).toContain('FISHING_PHASER_FALLBACK_CLASS');
    expect(rollbackSpec).toContain('FISHING_PHASER_FALLBACK_CLASS');
  });
});

describe('fishing lane npm scripts', () => {
  it('exposes both lanes under the repository\'s own test:e2e naming', () => {
    for (const lane of FISHING_LANES) {
      for (const script of [lane.script, lane.fullScript, lane.ciRunScript]) {
        expect(npmScripts[script], `package.json has no ${script} script`).toBeDefined();
      }
      expect(lane.ciRunScript).toBe(`${lane.script}:recorded`);
      expect(lane.fullScript).toBe(`${lane.script}:full`);
    }
    // And the six names are six, not four: the rollback half of a cutover is evidence too.
    const fishingScripts = Object.keys(npmScripts).filter((name) => name.startsWith('test:e2e:fishing'));
    expect(fishingScripts.sort()).toEqual([
      'test:e2e:fishing',
      'test:e2e:fishing:full',
      'test:e2e:fishing:recorded',
      'test:e2e:fishing:rollback',
      'test:e2e:fishing:rollback:full',
      'test:e2e:fishing:rollback:recorded',
    ]);
  });

  it('the build script sets the fishing flag and nothing else', () => {
    expect(npmScripts[FISHING_LANE.buildScript]).toBe('VITE_PIXI_FISHING=true npm run build:web');
    // `VITE_WORLD_RENDERER` deliberately stays `phaser`, which is exactly what makes the Phase 17
    // chunk check its own: the Phase 9 renderer check cannot see this switch.
    expect(npmScripts[FISHING_LANE.buildScript]).not.toContain('VITE_WORLD_RENDERER');
    expect(npmScripts[FISHING_LANE.buildScript]).not.toContain('VITE_PIXI_VILLAGE');
    expect(npmScripts[FISHING_LANE.buildScript]).not.toContain('VITE_PIXI_DUNGEON');
    // The rollback lane previews the production build, which is the plain production script.
    expect(npmScripts[FISHING_ROLLBACK_LANE.buildScript]).toBe('npm run build');
    expect(npmScripts[FISHING_ROLLBACK_LANE.buildScript]).not.toContain('VITE_PIXI_FISHING');
  });

  it('runs exactly the Playwright invocation each lane declares, and cannot widen it', () => {
    for (const lane of FISHING_LANES) {
      const command = `playwright test --config=${lane.configFile}`;
      for (const script of [lane.script, lane.ciRunScript]) {
        expect(npmScripts[script]).toBe(`${lane.preflightCommand} && ${command}`);
        expect(npmScripts[script].split('&&')).toHaveLength(2);
      }
      // No `--project` override: the config binds exactly one project, so there is nothing to
      // select, and an override would be a way to reach another project's spec.
      for (const script of [lane.script, lane.fullScript, lane.ciRunScript]) {
        for (const forbidden of ['--project', 'currentBuild', 'compatibility.spec', 'storageV2']) {
          expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });

  it('never rebuilds from the two preview-only scripts', () => {
    // In CI the production viewport suite runs first against the production artifact and this
    // lane's download replaces `dist` after it. A preview-only script that built would make the
    // artifact under test depend on the step that ran it.
    for (const lane of FISHING_LANES) {
      for (const script of [lane.script, lane.ciRunScript]) {
        for (const forbidden of ['build:web', 'vite build', 'record:web-artifact', 'npm ci']) {
          expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });

  it('puts the build, the record and the identity check in the :full script', () => {
    expect(npmScripts[FISHING_LANE.fullScript]).toBe(
      `npm run ${FISHING_LANE.buildScript} && npm run ${FISHING_LANE.recordScript} && ` +
        `npm run ${FISHING_LANE.verifyScript} && ${FISHING_LANE.preflightCommand} && ` +
        `playwright test --config=${FISHING_LANE.configFile}`,
    );
    expect(npmScripts[FISHING_LANE.fullScript].split('&&')).toHaveLength(5);
    expect(npmScripts[FISHING_ROLLBACK_LANE.fullScript]).toBe(
      `npm run ${FISHING_ROLLBACK_LANE.buildScript} && npm run ${FISHING_ROLLBACK_LANE.recordScript} && ` +
        `npm run ${FISHING_ROLLBACK_LANE.verifyScript} && ${FISHING_ROLLBACK_LANE.preflightCommand} && ` +
        `playwright test --config=${FISHING_ROLLBACK_LANE.configFile}`,
    );
    expect(npmScripts[FISHING_ROLLBACK_LANE.fullScript].split('&&')).toHaveLength(5);
  });

  it('records each artifact to its own identity, and the two identities cannot collide', () => {
    expect(npmScripts[FISHING_LANE.recordScript]).toBe(
      `node scripts/web-artifact-manifest.mjs write --out=${FISHING_MANIFEST_PATH}`,
    );
    expect(npmScripts[FISHING_LANE.verifyScript]).toBe(
      `node scripts/web-artifact-manifest.mjs verify --manifest=${FISHING_MANIFEST_PATH}`,
    );
    expect(npmScripts[FISHING_ROLLBACK_LANE.recordScript]).toBe('node scripts/web-artifact-manifest.mjs write');
    expect(npmScripts[FISHING_ROLLBACK_LANE.verifyScript]).toBe(
      'node scripts/web-artifact-manifest.mjs verify',
    );
    // The whole point of two manifests: a rollback claim verified against an artifact that still
    // contains the pond would pass on the wrong bytes.
    expect(FISHING_MANIFEST_PATH).toBe('artifacts/web-artifact-manifest-pixi-fishing.json');
    expect(FISHING_ROLLBACK_MANIFEST_PATH).toBe('artifacts/web-artifact-manifest.json');
    expect(FISHING_MANIFEST_PATH).not.toBe(FISHING_ROLLBACK_MANIFEST_PATH);
    expect(FISHING_MANIFEST_PATH).not.toBe('artifacts/web-artifact-manifest-pixi.json');
    // And the script they name really takes those flags and really has both modes.
    const manifestScript = readFileSync(MANIFEST_SCRIPT_PATH, 'utf8');
    expect(manifestScript).toContain('--out=');
    expect(manifestScript).toContain('--manifest=');
    expect(manifestScript).toMatch(/const MODES = new Set\(\['write', 'verify'\]\)/);
    for (const lane of FISHING_LANES) {
      for (const script of [lane.recordScript, lane.verifyScript]) {
        for (const forbidden of ['build', 'rm -rf', 'playwright']) {
          expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });
});

describe('fishing lane preflight', () => {
  const preflight = readFileSync(PREFLIGHT_PATH, 'utf8');

  it('is one script behind two lanes, selected by a flag, and names the right manifest', () => {
    expect(FISHING_LANE.preflightCommand).toBe('node scripts/require-fishing-lane-artifact.mjs');
    expect(FISHING_ROLLBACK_LANE.preflightCommand).toBe(
      'node scripts/require-fishing-lane-artifact.mjs --rollback',
    );
    expect(preflight).toContain("process.argv.includes('--rollback')");
    expect(preflight).toContain(FISHING_MANIFEST_PATH);
    expect(preflight).toContain(FISHING_ROLLBACK_MANIFEST_PATH);
  });

  it('cannot build and cannot record, so it cannot become a second rebuild path', () => {
    /*
     * The property, stated correctly: the preflight **names** build and record scripts so its
     * error message can tell a reader what to run, and it must not **execute** anything. So the
     * assertion is on the absence of a child-process spawn rather than on the absence of the
     * words - `expect(preflight).not.toContain('build:web')` would have failed on the very table
     * that makes the message useful.
     */
    for (const forbidden of [
      'execFileSync',
      'execSync',
      'spawnSync',
      'spawn(',
      'vite build',
    ]) {
      expect(preflight, `preflight: ${forbidden}`).not.toContain(forbidden);
    }
    // The `npm run <script>` strings it does contain are inside its own error messages, telling a
    // reader what to run; what must not exist is a command it executes. Asserted as a count so a
    // future "and here is the command" line is a deliberate edit rather than an accident.
    expect([...preflight.matchAll(/npm run /g)].length).toBeGreaterThan(0);
    // It prints repository-relative paths only, and takes no network.
    expect(preflight).toContain("REPO_ROOT = path.resolve(__dirname, '..')");
    expect(preflight).not.toMatch(/fetch\(|https?:\/\//);
    // ...and the only filesystem calls it makes are existence checks.
    expect([...preflight.matchAll(/\bfrom 'node:fs'/g)]).toHaveLength(1);
    expect(preflight).toContain("import { existsSync } from 'node:fs';");
  });

  it('fails rather than warns when the artifact is missing', () => {
    // The whole reason this check is a command and not a module-scope guard in the config: a
    // warning let the run reach a `vite preview` of a directory that is not there, and Playwright
    // reported that as a 180-second webServer timeout rather than as the missing build.
    expect(preflight).toContain('process.exit(1)');
    expect(existsSync(PREFLIGHT_PATH)).toBe(true);
    for (const lane of FISHING_LANES) {
      expect(preflight).toContain(`'${lane.buildScript}'`);
      expect(preflight).toContain(`'${lane.recordScript}'`);
      expect(preflight).toContain(`'${lane.verifyScript}'`);
    }
  });
});

describe('fishing lane Playwright configs', () => {
  it('each binds exactly one project to exactly its own spec', () => {
    const pond = (fishingConfig.projects ?? []).flat();
    expect(pond).toHaveLength(1);
    expect(pond[0]?.name).toBe(FISHING_LANE.project);
    expect(pond[0]?.use?.browserName).toBe('chromium');
    expect(pond[0]?.use?.viewport).toEqual({ ...FISHING_LANE.viewport });
    expect(pond[0]?.use?.deviceScaleFactor).toBe(1);
    // Chromium only, so the project must not carry emulated touch it does not exercise.
    expect(pond[0]?.use?.hasTouch).toBe(false);
    expect(fishingConfig.testMatch).toBe(FISHING_TEST_FILE);

    const rollback = (fishingRollbackConfig.projects ?? []).flat();
    expect(rollback).toHaveLength(1);
    expect(rollback[0]?.name).toBe(`${FISHING_LANE.project}-rollback`);
    expect(rollback[0]?.use?.browserName).toBe('chromium');
    expect(rollback[0]?.use?.viewport).toEqual({ ...FISHING_ROLLBACK_LANE.viewport });
    expect(fishingRollbackConfig.testMatch).toBe(FISHING_ROLLBACK_TEST_FILE);

    // Both specs exist on disk, or `testMatch` would bind to nothing and every run would report
    // "no tests found" as though it were a pass.
    for (const relative of [FISHING_TEST_PATH, FISHING_ROLLBACK_TEST_PATH]) {
      expect(existsSync(path.join(REPO_ROOT, relative))).toBe(true);
    }
  });

  it('records no raw failure artifact, and previews on a port of its own', () => {
    for (const config of [fishingConfig, fishingRollbackConfig] as const) {
      for (const key of ['trace', 'screenshot', 'video'] as const) {
        expect(config.use?.[key], key).toBe('off');
      }
      expect(config.use?.acceptDownloads).toBe(false);
      expect(config.use?.serviceWorkers).toBe('block');
      expect(config.workers).toBe(1);
      expect(config.fullyParallel).toBe(false);
    }
    // Two distinct ports, and both distinct from the five older lanes, so no two can collide in
    // one worktree and a `--strictPort` collision is an error rather than a silent second server.
    const ports = [43173, 43179, 43181, 43183, 43185, FISHING_PREVIEW_PORT, FISHING_PREVIEW_PORT + 2];
    expect(new Set(ports).size).toBe(ports.length);
    expect(FISHING_ROLLBACK_PREVIEW_PORT).toBe(FISHING_PREVIEW_PORT + 2);
    expect(FISHING_PREVIEW_SCRIPT).toContain(String(FISHING_PREVIEW_PORT));
    expect(FISHING_PREVIEW_SCRIPT).toContain('strictPort');
    expect(FISHING_ROLLBACK_PREVIEW_SCRIPT).toContain(String(FISHING_ROLLBACK_PREVIEW_PORT));
    expect(FISHING_ROLLBACK_PREVIEW_SCRIPT).toContain('strictPort');
  });

  it('previews an existing build and never decides to rebuild', () => {
    for (const config of [fishingConfig, fishingRollbackConfig] as const) {
      const webServer = Array.isArray(config.webServer) ? undefined : config.webServer;
      expect(webServer?.command).not.toContain('build');
      expect(webServer?.reuseExistingServer).toBe(false);
      // These configs are not at the repository root, so the preview's working directory has to
      // be stated; Playwright otherwise starts it beside the config and serves a `dist` that is
      // not there.
      expect(webServer?.cwd).toBe(process.cwd());
      expect(config.use?.baseURL).toBe(webServer?.url);
    }
    const pondServer = Array.isArray(fishingConfig.webServer) ? undefined : fishingConfig.webServer;
    expect(pondServer?.command).toBe(FISHING_PREVIEW_SCRIPT);
    expect(pondServer?.url).toBe(`http://127.0.0.1:${FISHING_PREVIEW_PORT}`);
    const rollbackServer = Array.isArray(fishingRollbackConfig.webServer)
      ? undefined
      : fishingRollbackConfig.webServer;
    expect(rollbackServer?.command).toBe(FISHING_ROLLBACK_PREVIEW_SCRIPT);
    expect(rollbackServer?.url).toBe(`http://127.0.0.1:${FISHING_ROLLBACK_PREVIEW_PORT}`);
  });

  it('sits inside a TypeScript project, so the ordinary gate can see it', () => {
    // The reason these two are under `tests/e2e/` and not beside the four older configs, which
    // `tsconfig.node.json` enumerates by name.
    const appTsconfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'tsconfig.app.json'), 'utf8'),
    ) as { include?: readonly string[] };
    expect(appTsconfig.include).toContain('tests');
    for (const relative of [FISHING_LANE.configFile, FISHING_ROLLBACK_CONFIG_FILE]) {
      expect(relative.startsWith('tests/')).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, relative))).toBe(true);
    }
    const nodeTsconfig = readFileSync(path.join(REPO_ROOT, 'tsconfig.node.json'), 'utf8');
    expect(nodeTsconfig).toContain('playwright.storage-v2.config.ts');
    expect(nodeTsconfig).not.toContain(FISHING_LANE.configFile);
    expect(nodeTsconfig).not.toContain(FISHING_ROLLBACK_CONFIG_FILE);
  });

  it('keeps every other release path disjoint', () => {
    const defaultProjects = (playwrightConfig.projects ?? []).flat().map((project) => project.name);
    expect(defaultProjects).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    for (const name of [FISHING_LANE.project, `${FISHING_LANE.project}-rollback`]) {
      expect(defaultProjects).not.toContain(name);
    }
    for (const project of playwrightConfig.projects ?? []) {
      expect(project.testMatch).not.toBe(FISHING_TEST_FILE);
      expect(project.testMatch).not.toBe(FISHING_ROLLBACK_TEST_FILE);
    }
    // Five older configs, each bound to its own spec, and neither fishing spec among them.
    const older: ReadonlyArray<readonly [PlaywrightTestConfig, string]> = [
      [storageV2Config, 'storageV2.spec.ts'],
      [dataProductsConfig, 'dataProductsRestore.spec.ts'],
      [subjectConfig, 'subjectProductRoundTrip.spec.ts'],
      [reloadConfig, 'reloadPersistence.spec.ts'],
      [pixiMemoryConfig, PIXI_MEMORY_TEST_FILE],
    ];
    for (const [config, spec] of older) {
      // The four older root configs bind their spec at the **config** level; the two configs
      // under `tests/e2e/` bind it per project because they declare the binding explicitly. Both
      // shapes are checked, so neither can be quietly widened.
      const projects = (config.projects ?? []).flat();
      expect(projects).toHaveLength(1);
      expect(config.testMatch ?? projects[0]?.testMatch).toBe(spec);
      expect(projects[0]?.name).not.toBe(FISHING_LANE.project);
      expect(projects[0]?.name).not.toBe(`${FISHING_LANE.project}-rollback`);
      expect(projects[0]?.testMatch).not.toBe(FISHING_TEST_FILE);
      expect(projects[0]?.testMatch).not.toBe(FISHING_ROLLBACK_TEST_FILE);
    }
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(FISHING_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(FISHING_ROLLBACK_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(FISHING_LANE.configFile);
    expect(npmScripts['test:e2e']).not.toContain(FISHING_ROLLBACK_CONFIG_FILE);
  });
});

describe('fishing lane specs', () => {
  it('both specs verify the recorded identity before they measure anything', () => {
    // A missing recorded identity is a failure, not a skip: a lane that reports success because
    // it measured nothing is the failure it exists to prevent. The verification itself lives in
    // the harness so both lanes run the same check, and the specs assert the manifest they ask
    // for is the one belonging to their own artifact.
    expect(harness).toContain('web-artifact-manifest.mjs');
    expect(harness).toContain('verify');
    expect(harness).toContain('status');
    expect(harness).toContain('The recorded artifact identity did not verify');
    expect(pondSpec).toContain('verifyRecordedArtifact');
    expect(pondSpec).toContain('FISHING_MANIFEST_PATH');
    expect(rollbackSpec).toContain('verifyRecordedArtifact');
    expect(rollbackSpec).toContain('FISHING_ROLLBACK_MANIFEST_PATH');
    expect(pondSpec).toContain('censusForDist');
    expect(rollbackSpec).toContain('censusForDist');
  });

  it('neither spec skips, and neither can pass by not measuring', () => {
    for (const [name, source] of [
      [FISHING_TEST_FILE, pondSpec],
      [FISHING_ROLLBACK_TEST_FILE, rollbackSpec],
    ] as const) {
      // Matched as a **call**, not as a word: both specs' headers explain in prose that they
      // contain no skip, and a gate that could not say so would have to choose between
      // forbidding the word and forbidding the explanation.
      expect(source, `${name} skips`).not.toMatch(/test\.(?:skip|fixme|only)\s*\(/);
      expect(source, `${name} swallows a failure`).not.toContain('.catch(');
      expect(source, `${name} ignores a failure`).not.toMatch(
        /\.catch\([\s\S]{0,120}expect\(true\)/,
      );
    }
    // The lane's tolerance for a swallowed read, and there are exactly two of them, both in the
    // harness and both in a named function with one purpose. Counted rather than pattern-matched
    // so a third tolerance is a failing edit instead of a habit: `verifyRecordedArtifact` reads the
    // manifest script's own JSON and reports an unreadable result as a failure, and
    // `readPondPhase` asks whether the HUD is on the page yet.
    expect([...harness.matchAll(/\} catch \{/g)].length).toBe(2);
    expect([...harness.matchAll(/\} catch \(error\) \{/g)].length).toBe(1);
    expect(harness).toContain('export async function readPondPhase');
    expect(harness).toContain('export function verifyRecordedArtifact');
  });

  it('the pond spec drives both input modes over the real controls', () => {
    // Parity is Phase 17's exit criterion, so the two modes have to be two *different* drives of
    // the same control rather than one drive described twice.
    expect(pondSpec).toContain('castWithKeyboard');
    expect(pondSpec).toContain('castWithPointer');
    expect(pondSpec).toContain('#fishing-charge-hold');
    expect(pondSpec).toContain('#fishing-set-hook');
    expect(pondSpec).toContain("page.keyboard.down('Space')");
    expect(pondSpec).toContain("dispatchEvent('pointerdown'");
    expect(pondSpec).toContain("dispatchEvent('pointerup'");
    // ...and each test declares which mode it drove, in its own evidence.
    expect(pondSpec).toContain("'keyboard-only'");
    expect(pondSpec).toContain("'pointer-only'");
  });

  it('the pond spec covers each Phase 17 exit criterion with its own named test', () => {
    // One test per criterion, so a report says which criteria have browser evidence and which
    // do not. Matched on the control each criterion is driven through.
    const criteria = [
      /keyboard alone/,
      /pointer input alone/,
      /keep a fish with no recall material|no recall material awards no experience/,
      /releasing a fish leaves no visible progression change/,
      /Fish Stand reports a canonical catalogue count/,
      /recall question offers a route back/,
    ];
    for (const criterion of criteria) {
      expect(pondSpec, `no test covers ${criterion}`).toMatch(criterion);
    }
    // The three-outcome sentence, and the refusal to pay for the question-less keep.
    expect(pondSpec).toContain('earned no experience');
    expect(pondSpec).toContain('not.toContainText(/gained \\d+ experience/i)');
    expect(pondSpec).toContain("'Release'");
    /*
     * The four totals the Fish Stand publishes, and **how the species one is read**.
     *
     * `data-fish-stat="species"` is published as `{caught} of {total}` while the other three are
     * bare integers, and an earlier version of the spec read all four with `Number(...)`. That made
     * the species value `NaN`, which is invisible in a passing run and lethal in one assertion:
     * `expect(NaN).toBe(NaN)` is `Object.is(NaN, NaN)` and so **passes**, which means every
     * before/after comparison of that value was a tautology that could not fail. This asserts the
     * two readers instead — the strict integer reader and the fraction reader — because a spec that
     * quietly parsed a product string into `NaN` is a gate with a hole in it, and the hole is only
     * visible if something insists the parse is total.
     */
    expect(pondSpec).toContain("readBareStat(page, 'kept')");
    expect(pondSpec).toContain("readBareStat(page, 'canonical-types')");
    expect(pondSpec).toContain("readBareStat(page, 'subjects')");
    expect(pondSpec).toContain('/^(\\d+)\\s+of\\s+(\\d+)$/');
    // Both readers throw on a shape they did not expect, rather than returning `NaN`.
    expect(pondSpec).toContain('Number.isInteger(value)');
    expect(pondSpec, 'a bare stat read must not fall back to a number it invented').not.toContain(
      "?? 'NaN'",
    );
    expect(pondSpec).toContain('#fishing-recall-room');
  });

  it('the rollback spec asserts the Phaser scene and the absence of the pond', () => {
    expect(rollbackSpec).toContain('FishingScene');
    expect(rollbackSpec).toContain('census.fishingChunks');
    expect(rollbackSpec).toContain("expect(await page.locator('.pixi-fishing-world').count()).toBe(0)");
    expect(rollbackSpec).toContain("expect(await page.locator('.fishing-hud').count()).toBe(0)");
    expect(rollbackSpec).toContain("page.keyboard.press('Escape')");
    // The way-out is a positive arrival, not a passive observation, and the fence that makes it
    // non-vacuous is asserted too.
    expect(rollbackSpec).toContain('AWAY_ITERATIONS');
    expect(rollbackSpec).toContain('.toBeNull()');
  });

  it('both specs keep the privacy discipline', () => {
    // The guard and the classifier live in the harness so both lanes get the same ones, and so
    // there is exactly one place a privacy rule could be weakened.
    expect(harness).toContain("url.hostname !== '127.0.0.1'");
    expect(harness).toContain("route.abort('blockedbyclient')");
    expect(harness).toContain('classifyRequestLike');
    expect(harness).toContain('buildNetworkPolicyReport');
    expect(harness).toContain('classifyWebSocketLike');
    expect(harness).toContain('sanitizeToolchainText');
    // ...and neither spec can install its own, weaker, spy.
    for (const [name, source] of [
      [FISHING_TEST_FILE, pondSpec],
      [FISHING_ROLLBACK_TEST_FILE, rollbackSpec],
    ] as const) {
      expect(source, `${name} does not install the shared guard`).toContain('installNetworkSpy');
      expect(source, `${name} installs a second route guard`).not.toContain('page.route(');
      // The observations go through the classifier, which reads only a URL's scheme, host and
      // path, a method, and a resource type.
      expect(source, `${name} reads a request body`).not.toContain('postData');
      expect(source, `${name} fulfils a route`).not.toContain('route.fulfill');
      expect(source, `${name} reads an Authorization header`).not.toContain('Authorization');
      expect(source, `${name} hard-codes an external URL`).not.toContain('https://');
      // No learner-shaped field is named anywhere, because the lane drives the application's own
      // tutorial subject and reads no storage key of its own.
      for (const field of ['subjectName', 'rootTopic', 'dungeonId', 'email', 'password']) {
        expect(source, `${name} names ${field}`).not.toContain(field);
      }
    }
  });

  it('is hermetic: no commit lookups, and no absolute path literal in either spec', () => {
    // The defect class `tests/phase8/qa-hermeticity.test.ts` records: a gate whose verdict
    // depends on where the checkout lives. `process.cwd()` is fine, because every path built from
    // it in this lane is joined with a repository-relative segment.
    for (const relative of [
      FISHING_TEST_PATH,
      FISHING_ROLLBACK_TEST_PATH,
      FISHING_LANE.configFile,
      FISHING_ROLLBACK_CONFIG_FILE,
      'tests/e2e/fishing-lane.ts',
      'tests/e2e/fishing-harness.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, `${relative} resolves a commit`).not.toMatch(
        /\bgit\s+(?:show|log|diff|cat-file|rev-parse|ls-tree|rev-list)\b/,
      );
      expect(source, `${relative} embeds an absolute path literal`).not.toMatch(
        /['"`]\/(?:home|tmp|Users|var)\//,
      );
      expect(source, `${relative} reads the user's home`).not.toContain('os.homedir');
    }
  });

  it('the harness classifier behaves, exercised here rather than only in a browser', () => {
    // The pure half of the harness, so a lane whose artifact classification silently matched
    // nothing is caught by `npm test` and not by a browser run.
    expect(classifyChunkNames([]).fishingChunks).toEqual([]);
    expect(classifyChunkNames(['FishingWorld-abc.js']).fishingChunks).toEqual(['FishingWorld-abc.js']);
    expect(classifyChunkNames(['FishingWorld-legacy-abc.js']).fishingChunks).toEqual([]);
    expect(classifyChunkNames(['FishingWorld-legacy-abc.js']).legacyChunks).toEqual([
      'FishingWorld-legacy-abc.js',
    ]);
  });

it('the walk is aimed at the authored map, bounded by a deadline, and reads the product\'s own literals', () => {
    /*
     * The harness restates the village's movement numbers as literals, because a Playwright worker
     * does not resolve the `@/` alias. This is the gate that stops that restatement from drifting:
     * every one of them is asserted against `src/data/villageLayout.ts`, and both endpoints of
     * both journeys are asserted against `VILLAGE_MAP`. A moved structure or a retuned speed fails
     * `npm test` rather than a lane four minutes later.
     */
    expect(VILLAGE_TILE_SIZE).toBe(VILLAGE_MAP.tileSize);
    expect(VILLAGE_PLAYER_SPEED).toBe(PLAYER_SPEED);
    expect(VILLAGE_STRUCTURE_APPROACH_RADIUS).toBe(STRUCTURE_APPROACH_RADIUS);
    expect(VILLAGE_SPAWN_GRID).toEqual({
      gridX: VILLAGE_MAP.playerStart.x,
      gridY: VILLAGE_MAP.playerStart.y,
    });
    for (const [id, plan] of [
      ['pond-fish-sw', WALK_SPAWN_TO_SW_POND],
      ['pond-fish-sw', WALK_FISH_STAND_TO_SW_POND],
      ['fish-stand', WALK_SW_POND_TO_FISH_STAND],
    ] as const) {
      const structure = VILLAGE_MAP.structures.find((entry) => entry.id === id);
      expect(structure, `${id} is not in the authored map`).toBeDefined();
      // The target point a walk is aimed at is the structure's **centre**, which is what
      // `VillageScene.readNpcSnapshotCandidates` measures the approach radius from.
      expect(plan.to).toEqual({
        gridX: structure!.gridX + structure!.width / 2,
        gridY: structure!.gridY + structure!.height / 2,
      });
      expect(plan.targetId).toBe(id);
      expect(plan.budgetMs, `${id} walk budget`).toBeGreaterThan(0);
    }

    // The nominal travel is derived from the product's own speed and tile size, so retuning either
    // cannot leave the walk's arithmetic silently stale.
    expect(WALK_BURST_TRAVEL_TILES).toBeCloseTo(
      (WALK_BURST_MS / 1000) * (VILLAGE_PLAYER_SPEED / VILLAGE_TILE_SIZE),
      9,
    );
    expect(WALK_BURST_TRAVEL_PX).toBeCloseTo(WALK_BURST_TRAVEL_TILES * VILLAGE_TILE_SIZE, 9);
    /*
     * The burst is 400 ms, and the reason is measured rather than preferred.
     *
     * The binding constraint is that a burst must not carry the learner over the one-tile approach
     * radius between two readings, so the nominal travel is asserted against that radius below.
     * Both 400 ms and 700 ms satisfy it and cost the same wall time, because the round trip is
     * dominated by the `page.evaluate` rather than the key hold, so the shorter one is free and leaves
     * more readings inside the ring. 1000 ms was measured *worse*, timing out 4 of 4 at 90 seconds,
     * because at that length a burst carries the learner clean over the ring between readings.
     */
    expect(WALK_BURST_MS).toBe(400);
    /*
     * The binding constraint, and it is the burst's **nominal** travel rather than its measured one:
     * the village has no collision, so the walk presses the row the moment a reading shows it, and if
     * a burst carries the learner clean over the one-tile ring the row exists inside, no reading ever
     * falls inside it. Measured on this container, same journey twice per row: 400 ms (one tile) and
     * 700 ms (1.75 tiles) both arrived in about ten seconds, and 1000 ms (2.5 tiles) timed out 4 of 4
     * at 90 seconds. The shorter burst is also free — the round trip is dominated by the
     * `page.evaluate`, not the key hold — so it is the one with margin.
     */
    expect(
      (WALK_BURST_MS / 1000) * (VILLAGE_PLAYER_SPEED / VILLAGE_TILE_SIZE),
      'a burst must not carry the learner over the approach radius between two readings',
    ).toBeLessThanOrEqual(VILLAGE_STRUCTURE_APPROACH_RADIUS / VILLAGE_TILE_SIZE);

    /*
     * The attribute the walk aims from, and the element it aims from it on.
     *
     * Without this, a rename in `src/ui/village/villagePlayerPosition.ts` would leave every walk in
     * the lane reading an attribute that is always absent — and `waitForPlayerGrid` would then throw
     * on the first leg of every test, which is a loud failure but reports the wrong cause: it names
     * "the village never published it" rather than "the lane is reading the wrong name". Asserting
     * the literal against the product's own constant is what turns that into `npm test`.
     */
    expect(VILLAGE_PLAYER_ATTRIBUTE).toBe(PRODUCT_VILLAGE_PLAYER_ATTRIBUTE);
    expect(VILLAGE_PLAYER_ROOT_SELECTOR).toBe('.village-screen');
    const villageScreen = readFileSync(
      path.join(REPO_ROOT, 'src/ui/screens/VillageScreen.tsx'),
      'utf8',
    );
    // The ref the attribute is published through is on the screen's root, and the root is what the
    // selector above names. Asserted against the markup so a restructure cannot leave the harness
    // querying an element the product does not render.
    expect(villageScreen).toContain('ref={villagePlayerRef}');
    expect(villageScreen).toMatch(/className="village-screen[\s\S]{0,400}?ref=\{villagePlayerRef\}/);
    expect(villageScreen).toContain('useVillagePlayerPositionAttribute');

    /*
     * The staleness the walk is built around, as arithmetic rather than as a claim.
     *
     * The attribute is sampled on an interval, so a value the walk reads may be up to one interval
     * old. The lane's job is to *re-read*, which is why the loop aims once per burst from a fresh
     * reading; the bound is asserted here so that a retune which widened the staleness past a tile
     * would fail `npm test` instead of quietly making every aim wrong by more than the approach
     * radius.
     */
    const stalenessPx = (DEFAULT_VILLAGE_PLAYER_SAMPLE_MS / 1000) * VILLAGE_PLAYER_SPEED;
    expect(stalenessPx).toBeGreaterThan(0);
    expect(
      stalenessPx / VILLAGE_TILE_SIZE,
      'one publish interval must stay well inside a tile, or every aim the walk derives is wrong by more than the approach radius',
    ).toBeLessThanOrEqual(0.25);
    // ...and the walk's poll cannot be faster than the product's publish, or it can only re-read what
    // it already has. It is allowed to be slower: that is the whole cost of a throttled read.
    expect(WALK_POLL_MS).toBeGreaterThanOrEqual(DEFAULT_VILLAGE_PLAYER_SAMPLE_MS);

    // Every tile the publisher can emit is inside the authored map, so the parser's refusals are
    // about *shape* and never about a position the product would produce.
    for (const raw of [
      '0,0',
      '5,27',
      '20,1',
      `${VILLAGE_MAP.width - 1},${VILLAGE_MAP.height - 1}`,
    ]) {
      expect(parseVillagePlayerGrid(raw), raw).not.toBeNull();
    }
  });
it('the walk aims from the published tile, and the reversal it used to need is gone', () => {
    /*
     * The defect this replaced, stated first because the assertions below only mean something next to
     * it.
     *
     * The village used to publish a *distance* to each nearby structure and never a *position*. So a
     * walk had no idea where it was standing: it pressed along a fixed ratio computed from the map's
     * two endpoints, and each leg began up to 0.9 of a tile from the position the plan assumed
     * (measured presses at 30.8 and 41.6 pixels on a 48-pixel radius). That lateral error was then
     * carried along a twenty-five-tile journey to a target whose entire radius is one tile.
     *
     * The village now publishes the learner's own tile, so the walk derives its next key from **that**
     * tile on every burst. Two things follow, and both are asserted here rather than described:
     *
     * 1. `approachKey` is a pure function of a position and a target, and the harness **presses the key
     *    it returns** — asserted against the loop's own source below, because a re-aiming function that
     *    nothing consults is the tautology this lane has already produced once.
     * 2. **There is no reversal any more.** A heading derived from the learner's own published tile
     *    already points *back* at the target the instant the learner passes it, so "overshot" is not a
     *    state the walk can be in. The reversal control was mutation-verified and it was correct; it is
     *    now redundant, and its absence is asserted so it cannot creep back in beside an aim that does
     *    not need it.
     */
    expect(approachKey({ gridX: 5, gridY: 27 }, { gridX: 11, gridY: 24 })).toBe('ArrowRight');
    expect(approachKey({ gridX: 11, gridY: 24 }, { gridX: 5, gridY: 27 })).toBe('ArrowLeft');
    expect(approachKey({ gridX: 11, gridY: 24 }, { gridX: 20.5, gridY: 1 })).toBe('ArrowUp');
    expect(approachKey({ gridX: 20.5, gridY: 1 }, { gridX: 11, gridY: 24 })).toBe('ArrowDown');
    // The dominant axis leads, so a learner never drifts sideways while the long axis is open. The
    // spawn→pond journey is six across and three down and the stand journey is the reverse of that
    // shape, so both directions of both journeys are checked rather than one.
    expect(approachKey(WALK_SPAWN_TO_SW_POND.from, WALK_SPAWN_TO_SW_POND.to)).toBe('ArrowRight');
    expect(approachKey(WALK_SW_POND_TO_FISH_STAND.from, WALK_SW_POND_TO_FISH_STAND.to)).toBe('ArrowUp');

    /*
     * The correction, stated as a property rather than as a removal: from a position **past** the
     * target, the key points back. This is the exact case the reversal existed for — the traced run that
     * read the fish stand at 38.9 pixels, then 45, 45 and 45.2, and then held north-east for 104
     * seconds of a 120-second budget. One call is the whole fix.
     */
    const stand = WALK_SW_POND_TO_FISH_STAND;
    expect(approachKey({ gridX: 21, gridY: 0 }, stand.to), 'past the target, above it').toBe('ArrowDown');
    expect(approachKey({ gridX: 20, gridY: 2 }, stand.to), 'past the target, below it').toBe('ArrowUp');
    expect(approachKey({ gridX: 22, gridY: 1 }, stand.to), 'past the target, on the far side').toBe(
      'ArrowLeft',
    );
    expect(approachKey({ gridX: 19, gridY: 1 }, stand.to), 'short of the target, on the near side').toBe(
      'ArrowRight',
    );

    /*
     * The sub-tile half, which a tile-indexed aim cannot express and which two measured failures needed.
     *
     * `VillageScene.readNpcSnapshotCandidates` measures from `(gridX + width / 2) * tileSize` in
     * **pixels** and admits a row on `distance < range`, so the arrival test is a pixel distance from a
     * point that can sit mid-tile, while the only position published is an integer tile. A learner on
     * the target's own tile can be a tile and a half from the centre pixel — a tile "on the spot" and
     * still out of range. Both failures below were measured on this lane before this rule existed:
     *
     * - the learner reached the pond's centre tile exactly and the walk **stopped**, because the aim had
     *   no distance left to work with; the pond's centre pixel is that tile's own corner.
     * - the learner oscillated for 55 readings between the two tiles either side of the fish stand's
     *   centre, its tile distance pinned at 0.50 the whole time, and the row never appeared once.
     */
    const pond = WALK_SPAWN_TO_SW_POND.to;
    // (11, 24) is the pond's centre tile and the centre pixel is that tile's own corner, so both axes
    // must point at the *lower* neighbour — the short way round to a corner at fraction zero.
    expect(pond.gridX % 1).toBe(0);
    expect(pond.gridY % 1).toBe(0);
    expect(approachKey({ gridX: 11, gridY: 24 }, pond)).toBe('ArrowLeft');
    expect(approachKey({ gridX: 11, gridY: 24 }, pond, 'ArrowRight')).toBe('ArrowUp');
    expect(approachKey({ gridX: 11, gridY: 24 }, pond, 'ArrowDown')).toBe('ArrowLeft');
    // The stand's centre is at (20.5, 1): half a tile across and on a row boundary. From tile (20, 1)
    // both axes claim half a tile, which is the tie the `avoid` bit exists for.
    expect(stand.to.gridX % 1).toBe(0.5);
    expect(stand.to.gridY % 1).toBe(0);
    expect(approachKey({ gridX: 20, gridY: 1 }, stand.to), 'tie, nothing worked yet').toBe('ArrowRight');
    expect(approachKey({ gridX: 20, gridY: 1 }, stand.to, 'ArrowRight'), 'tie, the last burst was horizontal').toBe(
      'ArrowUp',
    );
    expect(approachKey({ gridX: 20, gridY: 1 }, stand.to, 'ArrowUp'), 'tie, the last burst was vertical').toBe(
      'ArrowRight',
    );
    // And it never says "press nothing". The learner cannot be at the centre pixel from an integer
    // tile, and the row — not the aim running out — is the arrival test, so a walk that stopped pressing
    // inside the ring would leave its best opportunity unsampled. This is what the pond hard-stop above
    // was.
    for (const target of [pond, stand.to]) {
      for (let gridX = Math.floor(target.gridX) - 2; gridX <= Math.ceil(target.gridX) + 2; gridX += 1) {
        for (let gridY = Math.floor(target.gridY) - 2; gridY <= Math.ceil(target.gridY) + 2; gridY += 1) {
          for (const avoid of [undefined, 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
            expect(approachKey({ gridX, gridY }, target, avoid)).not.toBeNull();
          }
        }
      }
    }

    /*
     * The burst shrinks with the distance, because a long burst near the target steps over the ring.
     *
     * A 400 ms burst is 48 nominal pixels and the approach radius is 48 pixels, so a full-length burst
     * aimed at a mid-tile centre lands exactly on the boundary and off it again. The measured failure
     * was the 55-reading oscillation above; the shrink is 18 nominal pixels, a third of a tile.
     */
    expect(burstMsFor(20)).toBe(WALK_BURST_MS);
    expect(burstMsFor(WALK_NEAR_APPROACH_TILES + 0.01)).toBe(WALK_BURST_MS);
    expect(burstMsFor(WALK_NEAR_APPROACH_TILES), 'the switch is inclusive at the threshold').toBe(
      WALK_BURST_NEAR_MS,
    );
    expect(burstMsFor(0)).toBe(WALK_BURST_NEAR_MS);
    const nearTravelPx = (WALK_BURST_NEAR_MS / 1000) * VILLAGE_PLAYER_SPEED;
    expect(
      nearTravelPx,
      'a near burst must not carry the learner over the approach radius',
    ).toBeLessThan(VILLAGE_STRUCTURE_APPROACH_RADIUS);
    expect(nearTravelPx / VILLAGE_TILE_SIZE).toBeLessThan(0.5);
    // ...and the switch is at a distance the walk can actually reach, so it is not dead code: the
    // approach ring is one tile across.
    expect(WALK_NEAR_APPROACH_TILES).toBeGreaterThan(VILLAGE_STRUCTURE_APPROACH_RADIUS / VILLAGE_TILE_SIZE);
    expect(WALK_NEAR_APPROACH_TILES).toBeLessThan(3);

    /*
     * The loop really consults it. Every assertion so far is arithmetic; this is the wiring.
     *
     * `WALK_OVERSHOOT_SLACK_PX`, `shouldReverse`, `reversedHeadingBursts`, `headingBursts`, `walkBursts`,
     * `HEADING_BLOCKS` and `WALK_HEADING_REPEAT` all existed to make a *fixed-ratio* heading survive a
     * walk that could not see itself. With the published tile there is nothing to survive, and their
     * absence is asserted on the **code** rather than on the whole file, because the prose in this gate
     * names several of them on purpose to record why they are gone.
     */
    expect(harness).not.toMatch(/export const WALK_OVERSHOOT_SLACK_PX/);
    expect(harness).not.toMatch(/WALK_OVERSHOOT_SLACK_PX\s*=/);
    expect(harness).not.toMatch(/shouldReverse|reversedHeadingBursts|headingBursts|walkBursts/);
    expect(harness).not.toMatch(/HEADING_BLOCKS|WALK_HEADING_REPEAT|WALK_MAX_REPEATS/);
    expect(harness).not.toMatch(/closestPx|distancePx/);
    // The aim is a direct call that carries its one bit of history, and the key it returns is the key
    // the loop presses — with the burst the distance asked for.
    expect(harness).toContain('const key = approachKey(at, plan.to, lastKey);');
    expect(harness).toContain('await holdKey(page, key, burstMsFor(distanceTiles));');
    expect(harness).not.toMatch(/await holdKey\(page, key, WALK_BURST_MS\);/);
    // And the aim is computed from the **published** tile, never from the plan's expected start.
    expect(harness).toContain('const distanceTiles = gridDistanceTiles(at, plan.to);');
    expect(harness).not.toMatch(/approachKey\(plan\.from/);
    expect(harness).not.toMatch(/approachKey\(closest/);
    expect(harness).not.toMatch(/plan\.from\.grid/);
  });

  it('the published tile is read once per burst, and its absence is never a tile', () => {
    /*
     * Two properties, both of which were impossible to get right before the attribute existed and both
     * of which fail silently when they are wrong.
     *
     * **The read precedes the aim.** The heading is derived from a tile and the arrival is decided from a
     * row, so reading them in separate round trips would let the learner move in between and hand the
     * loop a heading from one instant and an arrival decided at another. One `evaluate` carries both, so
     * the order in the source is the order in time.
     */
    const readAt = harness.indexOf('const attempt = await readVillage(page, plan.targetId, true);');
    const aimAt = harness.indexOf('const key = approachKey(at, plan.to, lastKey);');
    const holdAt = harness.indexOf('await holdKey(page, key, burstMsFor(distanceTiles));');
    expect(readAt).toBeGreaterThan(-1);
    expect(aimAt).toBeGreaterThan(readAt);
    expect(holdAt).toBeGreaterThan(aimAt);
    // The read is the single round trip that carries the rows *and* the attribute, so there is no second
    // read of the position that could disagree with the aim.
    expect(harness).toContain('const playerRaw = document.querySelector(rootSelector)?.getAttribute');
    expect(harness).toContain('attribute: VILLAGE_PLAYER_ATTRIBUTE');
    expect(harness).toContain('rootSelector: VILLAGE_PLAYER_ROOT_SELECTOR');

    /*
     * **Absence is "cannot navigate yet", never `0,0`.**
     *
     * The attribute is absent before a renderer mounts and absent on an adapter that does not implement
     * the read, so a walk that substituted a default tile would aim north-west from the map's corner and
     * walk the learner off the top-left of the village. The parser is *total* — it refuses rather than
     * guessing — and the refusal cases below are the ones that would otherwise become a `NaN` or a silent
     * zero.
     */
    for (const absent of [null, undefined, '', '   ', '0', '1,', ',1', 'a,b', '1,2,3', '1.5,2', 'NaN,NaN']) {
      expect(parseVillagePlayerGrid(absent as string | null), JSON.stringify(absent)).toBeNull();
    }
    // What it does accept, including the whitespace tolerance that still cannot yield a wrong tile.
    expect(parseVillagePlayerGrid('5,27')).toEqual({ gridX: 5, gridY: 27 });
    expect(parseVillagePlayerGrid(' 5 , 27 ')).toEqual({ gridX: 5, gridY: 27 });
    expect(parseVillagePlayerGrid('0,0')).toEqual({ gridX: 0, gridY: 0 });
    // Every value it returns is a pair of **integers**, so no `NaN` can reach the arithmetic — which is
    // the `expect(NaN).toBe(NaN)` failure mode in its other clothing.
    for (const raw of ['5,27', ' 0 , 0 ', '-3,4']) {
      const parsed = parseVillagePlayerGrid(raw) as { gridX: number; gridY: number };
      expect(Number.isInteger(parsed.gridX), raw).toBe(true);
      expect(Number.isInteger(parsed.gridY), raw).toBe(true);
    }

    // No default tile anywhere, and the parser is never bypassed by a fallback.
    expect(harness).not.toMatch(/gridX:\s*0\s*,\s*gridY:\s*0/);
    expect(harness).not.toMatch(/parseVillagePlayerGrid\([^)]*\)\s*\?\?/);
    expect(harness).not.toMatch(/playerRaw\s*\?\?\s*'/);

    // The wait is a wait, and its failure names the attribute, the element and the capability.
    expect(harness).toContain('export async function waitForPlayerGrid');
    expect(harness).toMatch(
      /const at = parseVillagePlayerGrid\(reading\.playerRaw\);\s*\n\s*if \(at !== null\) return at;/,
    );
    expect(harness).toContain('The village screen never published');
    expect(harness).toContain('readPlayerGridPosition');
    // ...and the walk waits for it before it aims anything, exactly once per walk.
    expect(harness).toMatch(
      /const deadline = Date\.now\(\) \+ plan\.budgetMs;\s*\n\s*await waitForPlayerGrid\(page, plan\);/,
    );
    expect([...harness.matchAll(/await waitForPlayerGrid\(/g)].length).toBe(1);
  });

  it('the reference model is bounded, and the browser loop has three bounds of its own', () => {
    /*
     * `approachBursts` is the walk's pure model: the browser loop follows no schedule, so this is the
     * same rule stated without a browser, and the walk's failure diagnosis reports its length. The aim
     * **oscillates around** the target — which is what puts a learner inside a pixel-measured ring it
     * can only see through a tile-sized window — so the model has no arrival to run to and needs a plain
     * ceiling. Its first version had none and looped until it took the vitest worker down with it.
     */
    expect(WALK_MODEL_MAX_BURSTS).toBeGreaterThanOrEqual(400);
    for (const plan of [WALK_SPAWN_TO_SW_POND, WALK_SW_POND_TO_FISH_STAND, WALK_FISH_STAND_TO_SW_POND]) {
      const modelled = approachBursts(plan.from, plan.to);
      expect(modelled.length, `${plan.targetId}: the model ran to its ceiling`).toBeLessThan(
        WALK_MODEL_MAX_BURSTS,
      );
      // Every burst is one of the two hold lengths the browser loop can spend, and never a third.
      for (const burst of modelled) {
        expect([WALK_BURST_MS, WALK_BURST_NEAR_MS]).toContain(burst.ms);
      }
      // It never names a key that points **away** from the target on its own axis. That is the
      // property the reversal used to have to guarantee from outside the aim; now it falls out of it.
      const forbidden = new Set<WalkArrowKey>([
        plan.to.gridX > plan.from.gridX ? 'ArrowLeft' : 'ArrowRight',
        plan.to.gridY > plan.from.gridY ? 'ArrowUp' : 'ArrowDown',
      ]);
      for (const burst of modelled) {
        expect(forbidden.has(burst.key), `${plan.targetId} pressed ${burst.key} away from the target`).toBe(
          false,
        );
      }
      // Both axes are used, and the dominant one leads — six across and three down to the pond, and the
      // reverse of that shape on the way to the stand.
      const count = (key: WalkArrowKey): number => modelled.filter((burst) => burst.key === key).length;
      const dx = plan.to.gridX - plan.from.gridX;
      const dy = plan.to.gridY - plan.from.gridY;
      const horizontal: WalkArrowKey = dx > 0 ? 'ArrowRight' : 'ArrowLeft';
      const vertical: WalkArrowKey = dy > 0 ? 'ArrowDown' : 'ArrowUp';
      expect(count(horizontal), `${plan.targetId} never travelled on the horizontal axis`).toBeGreaterThan(0);
      expect(count(vertical), `${plan.targetId} never travelled on the vertical axis`).toBeGreaterThan(0);
      expect(modelled[0]?.key).toBe(Math.abs(dx) >= Math.abs(dy) ? horizontal : vertical);
      // And a journey that starts on its target is empty, so a run that merely stopped still fails.
      expect(approachBursts(plan.to, plan.to).length).toBe(0);
      // The count is the journey's, in whole tiles plus a short homing tail, and it is named rather than
      // left as a floor: six across and three down is nine far bursts, and the rest is the creep inside
      // the approach ring. A model that stopped early or oscillated without arriving would move these.
      expect(approachBursts(WALK_SPAWN_TO_SW_POND.from, WALK_SPAWN_TO_SW_POND.to).length).toBe(11);
      expect(
        approachBursts(WALK_SW_POND_TO_FISH_STAND.from, WALK_SW_POND_TO_FISH_STAND.to).length,
      ).toBe(32);
      expect(
        approachBursts(WALK_FISH_STAND_TO_SW_POND.from, WALK_FISH_STAND_TO_SW_POND.to).length,
      ).toBe(35);
    }

    /*
     * The browser loop's own three bounds, each tied to a measurement the walk actually takes — and each
     * asserted against the source, because a computed-and-unconsulted counter is the tautology this gate
     * exists to catch.
     */
    // 1. The deadline.
    expect(harness).toContain('const deadline = Date.now() + plan.budgetMs;');
    // 2. The stall counter, reset by progress **or** by the published tile moving. The reset on movement
    //    is the part a progress-only rule got wrong: measured, 55 readings of no progress with the tile
    //    moving on every one, which is a learner doing the right thing.
    expect(harness).toMatch(
      /if \(closestTiles === null \|\| distanceTiles < closestTiles - WALK_PROGRESS_EPSILON_TILES\) \{\s*\n\s*closestTiles = distanceTiles;\s*\n\s*stalledReadings = 0;\s*\n\s*ringingReadings = 0;/,
    );
    expect(harness).toMatch(
      /previousTile\.gridX !== at\.gridX \|\| previousTile\.gridY !== at\.gridY\);?\s*\n\s*if \(published !== null && moved\) stalledReadings = 0;/,
    );
    expect(harness).not.toMatch(/if \(closestTiles === null[\s\S]{0,200}?\} else \{\s*\n\s*stalledReadings \+= 1;/);
    // 3. The circling counter, which ignores movement on purpose.
    expect(harness).toContain('ringingReadings += 1;');
    expect(harness).toMatch(/if \(ringingReadings >= WALK_RINGING_READINGS\) \{\s*\n\s*reason = 'no-approach';/);
    // Both conclusions are checked **after** the reading, so neither can pre-empt a reading that would
    // have found the row, and both before the next burst.
    const readAt = harness.indexOf('const attempt = await readVillage(page, plan.targetId, true);');
    const stallAt = harness.indexOf('if (stalledReadings >= WALK_STALL_READINGS) {');
    const ringAt = harness.indexOf('if (ringingReadings >= WALK_RINGING_READINGS) {');
    const holdAt = harness.indexOf('await holdKey(page, key, burstMsFor(distanceTiles));');
    expect(stallAt).toBeGreaterThan(readAt);
    expect(ringAt).toBeGreaterThan(stallAt);
    expect(holdAt).toBeGreaterThan(ringAt);

    // And both counters are sized against the tile quantum, not against taste. Progress is measured in
    // whole tiles, and at the slowest rate measured here a burst covers a third of one — so several
    // consecutive bursts can leave the published tile unchanged while the learner is visibly walking.
    expect(WALK_MEASURED_BURST_TRAVEL_TILES).toBeGreaterThan(0);
    expect(WALK_MEASURED_BURST_TRAVEL_TILES).toBeLessThan(WALK_BURST_TRAVEL_TILES);
    expect(WALK_STALL_READINGS * WALK_MEASURED_BURST_TRAVEL_TILES).toBeGreaterThan(4);
    expect(WALK_STALL_READINGS * WALK_BURST_MS).toBeLessThan(WALK_SPAWN_TO_SW_POND.budgetMs / 4);
    // The circling bound is looser, because a learner oscillating around a target it cannot quite reach
    // is *working*; it has to be large enough not to fire on that and small enough to leave the diagnosis
    // inside the shortest budget.
    expect(WALK_RINGING_READINGS).toBeGreaterThan(WALK_STALL_READINGS);
    expect(WALK_RINGING_READINGS * WALK_BURST_MS).toBeLessThan(WALK_SPAWN_TO_SW_POND.budgetMs);
  });

it('a walk verifies its own press, because the nearby list is a stale sample', () => {
    /*
     * The second failure this lane found, and the one that looked like a passing test.
     *
     * The nearby-action list is a **throttled** proximity read-out: the renderer publishes a snapshot
     * on an interval and `selectVillageNearbyTargets` admits a row on `distance < range`. So a row can
     * be present while the learner's real distance has already crossed the 48-pixel approach radius.
     * Measured here: the walk's read reported the fish stand at **47.9** against that radius, the press
     * landed on the button, `structureLeft` closed the panel in the same tick, and nothing happened —
     * and the walk reported an arrival it had not made.
     *
     * So the press has to be confirmed against the thing it was supposed to open, and an unconfirmed
     * press has to be retried rather than accepted. These assertions hold the shape of that: both
     * callers supply a confirmation, the harness's signature takes one, and no caller may pass
     * `undefined` — an unverified press is the defect.
     */
    for (const source of [pondSpec, rollbackSpec]) {
      const walks = source.match(/walkToStructureAndPress\(/g) ?? [];
      expect(walks.length, 'a spec must reach at least one structure by walking').toBeGreaterThan(0);
      // Every call site supplies a confirmation as its third argument.
      const withConfirm = source.match(/walkToStructureAndPress\([^)]*async \(\) =>/g) ?? [];
      expect(withConfirm.length, `${source.slice(0, 40)}: every walk confirms its press`).toBe(
        walks.length,
      );
    }
    // The two confirmations are the product's own facts: the world attribute, and the panel the
    // press opens. Neither is a "did the click dispatch" check, which would pass on the defect.
    expect(pondSpec).toContain('[data-world="fishing"]');
    expect(pondSpec).toContain(".filter({ hasText: 'Fish Stand' })");
    expect(rollbackSpec).toContain('[data-world="fishing"]');
    // ...and the harness refuses to treat a press as an arrival on its own.
    expect(harness).toContain('confirm?: WalkConfirmation');
    expect(harness).toContain('if (confirm === undefined) return { arrived: true, row, readings };');
    expect(harness).toContain('WALK_CONFIRM_SETTLE_MS');
    // The confirmation is asked **once per burst and then the walk moves on**. An earlier version
    // re-asked in a loop while holding position, and it spent the whole budget re-pressing in place
    // — so a press lost because the learner was out of range never got the walk to move and the walk
    // timed out having never moved. The shape that works is a learner's: miss, step, look, tap again.
    expect(harness).toContain('if (pressedAt !== null && confirm !== undefined && (await confirm()))');
    expect(harness).toContain('Date.now() - pressedAt >= WALK_CONFIRM_SETTLE_MS');
    // And the settle is a bound on re-pressing, not a wait the walk is inside. It has to fit inside the
    // walk's budget many times over, so a walk that has to retry once or twice is nowhere near its
    // deadline, and it has to be short enough that a stale row cannot suppress presses for the rest
    // of the walk.
    expect(WALK_CONFIRM_SETTLE_MS).toBeLessThan(WALK_SPAWN_TO_SW_POND.budgetMs / 10);
    // ...and it has to fit inside the *stall* window many times over, or a walk that keeps arriving
    // and keeps losing its press would conclude it was stuck before it had retried once. This is the
    // second of the two ways `WALK_STALL_READINGS` could be wrong, and it is asserted rather than
    // assumed.
    expect(WALK_STALL_READINGS * WALK_BURST_MS).toBeGreaterThan(WALK_CONFIRM_SETTLE_MS * 2);
  });

  it('the Fish Stand dialog is found by role and name, as the panel publishes itself', () => {
    /*
     * `FishStandPanel` labels its dialog with `aria-labelledby` pointing at its own
     * `<h3>Fish collection</h3>`. The dialog's accessible name is therefore "Fish collection" while
     * **no `aria-label` attribute exists on it** — so `[role="dialog"][aria-label="Fish collection"]`
     * matches nothing and fails on a panel that is working. This was the spec's own bug, found when
     * the walk finally arrived: the panel opened, the count read fine, and the selector did not match.
     */
    expect(pondSpec).toContain("page.getByRole('dialog', { name: 'Fish collection' })");
    expect(pondSpec).not.toContain('[role="dialog"][aria-label="Fish collection"]');
    // ...and it is asserted against the panel's own **markup**, so a future relabelling fails here.
    // Scoped to the dialog element rather than to the whole file, because the file's header comment
    // still describes the dialog as carrying `aria-label="Fish collection"`, which it does not — see
    // the report; that is a stale sentence in `src/ui/**`, which this lane does not own.
    const panel = readFileSync(path.join(REPO_ROOT, 'src/ui/components/FishStandPanel.tsx'), 'utf8');
    expect(panel).toContain('<h3 id={titleId}>Fish collection</h3>');
    expect(panel).toContain('aria-labelledby={titleId}');
    const dialogMarkup = /role="dialog"[\s\S]{0,400}?>/.exec(panel)?.[0] ?? '';
    expect(dialogMarkup, 'the panel must publish a role="dialog" element').not.toBe('');
    expect(dialogMarkup).toContain('aria-labelledby={titleId}');
    expect(dialogMarkup).not.toContain('aria-label=');
    /*
     * The summary sentence is read **inside** `readFishStand`, before it closes the dialog.
     *
     * A third instance of the family this lane keeps finding: an assertion that reads nothing because
     * of *when* it was read rather than of what it read. The panel publishes its count in words as
     * `You have kept N fish, M of them species from the catalogue's K.` — and the spec asserted that
     * sentence with `expect(dialog).toContainText(...)` from the test body, one line *after* the helper
     * that opened the dialog had clicked "Close the fish collection". So the assertion was looking for
     * an element the test itself had removed, and no run could ever have satisfied it. It survived
     * because every earlier failure was on the walk in front of it.
     *
     * Both halves are asserted, because either alone is satisfiable by the mistake: the read must be
     * inside the helper, and it must precede the close click.
     */
    const helperStart = pondSpec.indexOf('async function readFishStand');
    const helperEnd = pondSpec.indexOf('async function evidenceFor');
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = pondSpec.slice(helperStart, helperEnd);
    expect(helper).toContain('p.fishing-recall__outcome');
    expect(helper).toContain('summary: summary.replace(/\\s+/g, \' \').trim()');
    expect(helper, 'the summary must be read before the dialog is closed').toMatch(
      /summary:[\s\S]*?await page\.getByRole\('button', \{ name: 'Close the fish collection' \}\)\.click\(\);/,
    );
    // ...and the test body asserts the **value**, not a locator over a closed dialog.
    expect(pondSpec).toContain('filled.summary');
    expect(pondSpec).toContain('empty.summary');
    expect(pondSpec).not.toMatch(
      /await expect\(page\.getByRole\('dialog', \{ name: 'Fish collection' \}\)\)\.toContainText/,
    );
    // The empty branch states a different sentence, so the filled assertion is a change rather than the
    // panel's only wording — which is what stops it passing on a panel that ignores its contents.
    expect(panel).toContain("caughtCellCount > 0\n");
    expect(panel).toContain('No fish kept yet.');
  });

  it('a walk leaves the pond before it crosses the village, because the pond owns the arrows', () => {
    /*
     * The finding three tests hit, pinned as an assertion on the harness so it cannot be undone by
     * a later edit that "simplifies" the walk. The pond binds its own `keydown` listener and calls
     * `preventDefault` on the arrow keys, so a walk issued while the pond overlay is open moves
     * the angler and leaves the village where it was.
     */
    expect(harness).toContain('export async function returnToVillage');
    expect(harness).toContain('[data-fishing-touch-target="return-to-village"]');
    expect(pondSpec).toContain('returnToVillage');
    // ...and it is the pond's own control, not a synthetic key or a call past the overlay.
    expect(pondSpec).not.toContain("page.keyboard.press('Escape')");
    // Every read of the Fish Stand goes through the one helper, so the step cannot be dropped from
    // one caller and left in another.
    expect(pondSpec).toContain('async function readFishStand');
    expect(pondSpec.match(/await returnToVillage\(page\);/g)).toHaveLength(1);
    /*
     * `reachPond` throws its own walk failure, and every call site awaits it for that reason.
     *
     * It used to return a boolean, and two of its three call sites discarded the result — the two
     * that walk back to the pond mid-test. The measured cost of that was a misleading diagnosis: a
     * walk that ran out of budget reported itself as "the village fishing-pond entry point did not
     * mount the Pixi pond", carrying a paragraph that blamed host resolution in
     * `src/ui/village/villageStudyFlow.ts` and a `useEffect` guard in `PixiFishingLane.tsx`. Neither
     * was involved; the walk's own measurements had been discarded a line earlier.
     *
     * The assertions below are what stop it coming back, and the mutation that motivated them is the
     * one where `reachPond` returns `void` without throwing: every other assertion still passes and
     * the lane reports a harness timeout as a product defect. The narrowing is on `!outcome.arrived`
     * rather than on `outcome === null` because the walk returns a **discriminated union**: "arrived,
     * and here is the row" and "did not arrive, and here is what it measured" are different answers,
     * and a nullable row is exactly the shape that let two callers forget to check.
     */
    expect(pondSpec).toMatch(
      /async function reachPond\([^)]*\): Promise<void> \{[\s\S]*?if \(!outcome\.arrived\) throw walkFailure\(plan\.targetId, plan, outcome\);/,
    );
    // No call site may treat the walk's arrival as optional. Both walk helpers narrow the union rather
    // than testing a nullable row, so "arrived" and "did not arrive" are different answers at the
    // call site instead of one answer and a null.
    expect(pondSpec).not.toMatch(/if \((?:outcome|reached) === null\) throw walkFailure/);
    expect(pondSpec).not.toMatch(/const reached = await reachPond/);
    expect(pondSpec).not.toMatch(/= await reachPond\([^)]*\);\s*\n\s*expect/);
    // Every call awaits it, and none binds its result.
    expect(pondSpec.match(/await reachPond\(/g)).toHaveLength(3);
    expect(pondSpec).not.toMatch(/=\s*await reachPond\(/);
    // The walk's own diagnosis is what a failure reports, so it must name the plan it was given
    // rather than a hard-coded one — the two mid-test walks use different endpoints.
    expect(pondSpec.match(/walkFailure\(plan\.targetId, plan, outcome\)/g)).toHaveLength(1);
    expect(pondSpec.match(/walkFailure\('fish-stand', WALK_SW_POND_TO_FISH_STAND, reached\)/g)).toHaveLength(1);
    // The one direct walk that is not behind `reachPond` narrows the union too, and it cannot bind
    // the outcome to a nullable row.
    expect(pondSpec).toMatch(
      /const reached = await walkToStructureAndPress\([\s\S]{0,400}?if \(!reached\.arrived\) throw walkFailure\('fish-stand', WALK_SW_POND_TO_FISH_STAND, reached\);/,
    );

    /*
     * The diagnosis has to carry the measurements, or it is the misleading message again.
     *
     * This is the third time this lane has produced a failure report that named something other than
     * the cause, and the shape is always the same: a helper computed a fact, a caller discarded it,
     * and the next assertion reported the symptom. The failure arm of the walk's outcome is required
     * to name the last published tile, the closest approach, the reason and the reading count, and
     * `walkFailure` is required to put three of them into the sentence.
     */
    expect(pondSpec).toMatch(/function walkFailure\([^)]*outcome: VillageWalkFailure\): Error \{/);
    expect(pondSpec).toContain('outcome.lastPlayer === null');
    expect(pondSpec).toContain('outcome.closestTiles === null');
    expect(pondSpec).toContain('outcome.reason');
    expect(pondSpec).toContain('outcome.readings');
    expect(pondSpec).toContain('plan.budgetMs');
    // And it says where the aim came from, so a reader is never left guessing whether the walk knew
    // where the learner was.
    expect(pondSpec).toContain('VILLAGE_PLAYER_ATTRIBUTE');
    expect(pondSpec).toContain('VILLAGE_TILE_SIZE');
  });

it('the walk has no arrival count, because the travel rate is not the lane\'s to assume', () => {
    /*
     * The property the old budget got wrong, pinned.
     *
     * A Phaser scene integrates movement from its frame delta and Phaser clamps that delta to the
     * frame target, so a key held for 400 ms travels 400 ms of *simulated* time rather than wall
     * time. Measured in this repository's own container: 400 ms of ArrowRight covers 0.29 tiles,
     * 700 ms covers 0.50, and 1000 ms covers 0.71 — against a nominal one tile per 400 ms. A walk
     * budgeted in steps therefore encodes one machine's frame rate, and on a slower one it stops
     * before it arrives. That is why the old lane needed four bursts of slack on the longest
     * journey it had, and it is the reason the budget is a wall-clock deadline.
     *
     * Two bounds replaced the step count, and both are asserted rather than trusted:
     *
     * - the **deadline**, which ends a walk that is making progress slowly, and
     * - the **stall window**, which ends a walk that is not making progress at all.
     *
     * They are not interchangeable. A step count would fire the first one; a deadline alone makes a
     * walk that has clearly stopped spend its whole budget before saying so; and the stall window
     * alone would fire on a slow machine. The pair is the shape that behaves on both.
     */
    for (const walk of [WALK_SPAWN_TO_SW_POND, WALK_SW_POND_TO_FISH_STAND, WALK_FISH_STAND_TO_SW_POND]) {
      expect(walk.budgetMs).toBeGreaterThanOrEqual(90_000);
      const dx = Math.abs(walk.to.gridX - walk.from.gridX);
      const dy = Math.abs(walk.to.gridY - walk.from.gridY);
      const burstsNeeded = (dx + dy) / WALK_MEASURED_BURST_TRAVEL_TILES;
      // At the measured rate, the journey fits with a large multiple to spare: the longest one here
      // needs about 112 bursts and the budget holds over 120.
      expect(
        burstsNeeded * WALK_BURST_MS,
        `${walk.targetId}: the journey must fit the budget at the measured rate`,
      ).toBeLessThan(walk.budgetMs / 2);
      // A machine **twice** as slow as the one measured still fits inside the budget. That is the
      // property a deadline has and a step count cannot: the walk takes longer rather than stopping
      // short. The margin it is checked against is deliberately large rather than tight, because a
      // budget sized to *just* fit the measured rate would fail on the first machine slower than the
      // one it was measured on — which is the whole defect this replaced.
      expect(
        burstsNeeded * 2 * WALK_BURST_MS,
        `${walk.targetId}: the journey must fit the budget at half the measured rate`,
      ).toBeLessThan(walk.budgetMs);
      // The outer bound, checked rather than assumed: a walk's budget plus the walk that reached the
      // page has to fit the lane's own test timeout, or a slow machine reports a Playwright timeout
      // instead of the walk's own diagnosis.
      const laneTimeout = fishingConfig.timeout ?? 0;
      expect(laneTimeout, 'the lane must declare a per-test timeout').toBeGreaterThan(0);
      expect(
        walk.budgetMs + 30_000,
        `${walk.targetId}: budget plus setup must fit the lane's per-test timeout`,
      ).toBeLessThanOrEqual(laneTimeout);
    }

    /*
     * The stall window, sized against the **measured** rate — and the tile quantum is what makes this
     * the first thing to get wrong.
     *
     * Progress is measured in whole tiles because the tile is the only unit the village publishes, and
     * at the slowest rate measured here a burst covers {@link WALK_MEASURED_BURST_TRAVEL_TILES} of one.
     * So a walk can be visibly travelling and still publish the same tile for several readings in a
     * row, and a stall window shorter than that would read a slow runner as a stuck learner.
     */
    expect(WALK_MEASURED_BURST_TRAVEL_TILES).toBeGreaterThan(0);
    expect(WALK_MEASURED_BURST_TRAVEL_TILES).toBeLessThan(WALK_BURST_TRAVEL_TILES);
    // Whole tiles of guaranteed progress before the walk concludes it is stuck. Four bursts is the
    // smallest number that *guarantees* a tile change on some axis; the window has to clear that with
    // room to spare, and it clears it several times over.
    expect(WALK_STALL_READINGS * WALK_MEASURED_BURST_TRAVEL_TILES).toBeGreaterThan(4);
    // ...and it has to be short enough to end a stuck walk well inside the *shortest* budget, or the
    // stall conclusion is a claim nothing observes in practice. A quarter of the budget, measured in
    // readings rather than in seconds so it is stated against the loop that counts them.
    expect(WALK_STALL_READINGS * WALK_BURST_MS).toBeLessThan(WALK_SPAWN_TO_SW_POND.budgetMs / 4);
    // And it is checked *after* the reading, never before it, so it can never pre-empt a reading that
    // would have found the row.
    const stallAt = harness.indexOf('if (stalledReadings >= WALK_STALL_READINGS) {');
    const readAt = harness.indexOf('const attempt = await readVillage(page, plan.targetId, true);');
    const pressAt = harness.indexOf('pressedAt = Date.now();');
    expect(stallAt).toBeGreaterThan(readAt);
    expect(stallAt).toBeGreaterThan(pressAt);
    // The stall resets on improvement, so a walk that closes, plateaus for a moment, and closes again
    // is not punished for the plateau.
    expect(harness).toMatch(
      /if \(closestTiles === null \|\| distanceTiles < closestTiles - WALK_PROGRESS_EPSILON_TILES\) \{\s*\n\s*closestTiles = distanceTiles;\s*\n\s*stalledReadings = 0;/,
    );

    /*
     * The two controls the walk relies on are the DOM's, in the order that makes them work.
     */
    expect(harness).toContain('const deadline = Date.now() + plan.budgetMs;');
    // The read precedes the burst: a structure in reach is pressed before another key is spent.
    const readAtLoop = harness.indexOf('const attempt = await readVillage(page, plan.targetId, true);');
    const holdAt = harness.indexOf('await holdKey(page, key, burstMsFor(distanceTiles));');
    expect(readAtLoop).toBeGreaterThan(-1);
    expect(holdAt).toBeGreaterThan(readAtLoop);

    /*
     * There is **no press-distance gate**, and this asserts both the absence and the evidence for it.
     *
     * A gate was implemented on the theory that the nearby list is sampled, so a row can be present
     * while the learner has already crossed the radius; it refused every press inside half the radius
     * and timed out all ten tests, because the walk's closest approach to a structure was a lateral
     * offset of 32 to 45 pixels from a fixed-ratio heading and it never gets closer. The theory was
     * then checked against the measurements rather than kept on plausibility: presses at 32 and 45.1
     * pixels landed, the losses went at 38.9 and 47.9, and that is not monotonic in distance, so **no
     * cut-off separates the cases a gate is supposed to separate.**
     *
     * With the published tile the gate is not merely unnecessary but unexpressible: the walk no longer
     * has a lateral offset to compensate for, because it aims from where the learner actually is. The
     * arithmetic is still asserted, because the argument is the thing most likely to be re-derived
     * wrongly by a later reader who notices the loop presses on any row it sees.
     */
    // Matched against the **code**, not the whole file: the prose names the removed constant on
    // purpose, to record why it is gone, and an absence check over the file text would flag its own
    // explanation. What must not exist is a *declaration* and a *use in the press condition*.
    expect(harness).not.toMatch(/export const WALK_PRESS_MAX_DISTANCE_PX/);
    expect(harness).not.toMatch(/row\.distance <= /);
    expect(harness).not.toMatch(/closeEnough/);
    expect(harness).not.toMatch(/distancePx <= WALK_/);
    // The press condition is the click and the settle. There is **no** wait for the closest approach:
    // that was implemented and measured, and it cost the lane five of its ten tests, because a sampled
    // list lets the learner leave the ring between two readings and a waiting walk then has only the
    // sighting it already had. Now that the aim is derived from the learner's own tile there is no
    // lateral error to wait out either.
    expect(harness).toMatch(
      /if \(\s*\n\s*row !== null &&\s*\n\s*attempt\.pressed &&\s*\n\s*\(pressedAt === null \|\| Date\.now\(\) - pressedAt >= WALK_CONFIRM_SETTLE_MS\)\s*\n\s*\) \{/,
    );
    expect(harness).not.toMatch(/atClosest|WALK_PRESS_PATIENCE_READS|stillClosing|inRing/);
    // The four measured presses, as (distance, tookEffect) pairs from the traced runs.
    const measuredPresses: readonly (readonly [number, boolean])[] = [
      [32, true],
      [45.1, true],
      [38.9, false],
      [47.9, false],
    ];
    // The formal statement that distance does not order the outcomes: **a press that was lost at a
    // shorter distance than one that landed.** 38.9 was lost and 45.1 landed, so the failures are not
    // simply "the far ones". No threshold at any cut-off can accept 45.1 while rejecting 38.9, which
    // is the whole argument against a gate, stated as an ordering rather than as a claim.
    const lost = measuredPresses.filter(([, took]) => !took).map(([d]) => d);
    const landed = measuredPresses.filter(([, took]) => took).map(([d]) => d);
    expect(Math.min(...lost)).toBeLessThan(Math.max(...landed));
    // The four measurements are not enough to claim this for *each* loss, and the gate does not need
    // them to be: one loss at a shorter distance than one success is sufficient to rule out a monotone
    // cut-off, because any threshold low enough to accept the 32-pixel press also accepts 38.9.
    expect(Math.min(...lost)).toBeLessThan(Math.max(...landed));
    // A gate at the half-radius that this file once carried would have accepted 32 and 45.1 while
    // rejecting both 38.9 and 47.9 — so it discarded two of the four presses, one of which was the
    // closest approach the walk ever made. This is the arithmetic that the run then confirmed.
    const halfRadius = VILLAGE_STRUCTURE_APPROACH_RADIUS / 2;
    expect(measuredPresses.filter(([d]) => d <= halfRadius)).toHaveLength(0);
    // ...and every measurement is inside the approach radius, so all four were presses the walk
    // actually attempted rather than readings it would have refused.
    for (const [distance] of measuredPresses) {
      expect(distance).toBeLessThan(VILLAGE_STRUCTURE_APPROACH_RADIUS);
    }
    // The lateral error the gate existed to compensate for is gone, because the aim no longer starts
    // from the structure's centre. The measured presses are still pinned, because they are what the
    // argument is made of.
    const measuredPressDistances = [30.8, 41.6];
    for (const distance of measuredPressDistances) {
      expect(distance, 'a press outside the radius would not have been a press').toBeLessThan(
        VILLAGE_STRUCTURE_APPROACH_RADIUS,
      );
      expect(distance / VILLAGE_TILE_SIZE, 'in tiles: the error the old aim had to absorb').toBeLessThan(1);
    }
    expect(Math.max(...measuredPressDistances) / VILLAGE_TILE_SIZE).toBeGreaterThan(0.8);
    expect(harness).not.toMatch(/approachKey\(plan\.from/);

    // The rollback lane reads the same harness and has its own timeout, so the shared walk budgets
    // have to fit that one too — a budget the rollback lane could never spend would be a budget that
    // only makes the flagged lane's failures look slower.
    expect(
      Math.max(
        ...FISHING_LANES.map((lane) =>
          lane === FISHING_LANE ? WALK_FISH_STAND_TO_SW_POND.budgetMs : WALK_SPAWN_TO_SW_POND.budgetMs,
        ),
      ) + 30_000,
    ).toBeLessThanOrEqual(fishingRollbackConfig.timeout ?? 0);
  });

  it('the recall fixture is synthetic, complete, and its premise is checked', () => {
    // The recall branch needs a subject with a cleared room, and nothing the application mints
    // has one. The fixture is a module of its own rather than a block in the spec, for three
    // reasons the gate holds: the spec carries a privacy gate that forbids a learner-shaped field
    // from appearing in it, the pure half has to be exercised here rather than only in a browser,
    // and the storage keys have to be asserted against the product's own table.
    const seed = recallFixtureStorageSeed();
    expect(seed.map((entry) => entry.key).sort()).toEqual([
      STORAGE_KEYS.activeSubjectId,
      STORAGE_KEYS.subject(RECALL_FIXTURE_SUBJECT_ID),
      STORAGE_KEYS.subjectIndex,
    ]);
    // The index names the subject, the subject record exists, and the pointer names it: the three
    // reads `readAppStateFromLegacy` performs, in the order it performs them.
    const index = JSON.parse(
      seed.find((entry) => entry.key === STORAGE_KEYS.subjectIndex)?.value ?? 'null',
    ) as unknown;
    expect(index).toEqual([RECALL_FIXTURE_SUBJECT_ID]);
    const pointer = seed.find((entry) => entry.key === STORAGE_KEYS.activeSubjectId)?.value;
    expect(pointer).toBe(RECALL_FIXTURE_SUBJECT_ID);

    // And the one room is cleared in both halves `getClearedRooms` requires, or the branch is
    // unreachable and the test would be measuring nothing.
    const snapshot = recallFixtureSnapshot();
    const rooms = (snapshot['rooms'] ?? {}) as Record<string, Record<string, unknown>>;
    const room = rooms[RECALL_FIXTURE_ROOM_ID];
    expect(room, 'the fixture has no room').toBeDefined();
    expect(['EncounterDefeated', 'ArtifactCollected', 'NeedsRevalidation']).toContain(room!['state']);
    expect(
      (room!['validationState'] as Record<string, unknown>)['finalPass'],
      'getClearedRooms admits a room only when validation passed',
    ).toBe(true);
    expect((snapshot['dungeon'] as Record<string, unknown>)['dungeonId']).toBe(
      RECALL_FIXTURE_SUBJECT_ID,
    );

    // The two preconditions, asserted rather than hoped for: the branch reads the **active**
    // subject, and the pond's eligibility reads whichever subject fills the nearest portal slot.
    expect(recallFixturePremiseFailures({ activeSubjectId: RECALL_FIXTURE_SUBJECT_ID, subjectIds: [RECALL_FIXTURE_SUBJECT_ID] })).toEqual([]);
    expect(
      recallFixturePremiseFailures({ activeSubjectId: 'something-else', subjectIds: [RECALL_FIXTURE_SUBJECT_ID] }),
      'a different active subject must be reported',
    ).not.toEqual([]);
    expect(
      recallFixturePremiseFailures({
        activeSubjectId: RECALL_FIXTURE_SUBJECT_ID,
        subjectIds: [RECALL_FIXTURE_SUBJECT_ID, 'a-second-subject'],
      }),
      'a second subject can fill the pond portal slot, so it must be reported',
    ).not.toEqual([]);
    // And the spec checks it before it walks.
    expect(pondSpec).toContain('recallFixturePremiseFailures');
    expect(pondSpec).toContain("setUp(page, 'seeded-recall')");
  });
});

describe('the chunk boundary the flagged build depends on', () => {
  it('vite.config.ts is handed the parsed fishing flag and names it in the message', () => {
    const viteConfig = readFileSync(VITE_CONFIG_PATH, 'utf8');
    expect(viteConfig).toContain('pixiFishing: runtimeConfig.pixiFishing');
    expect(viteConfig).toContain('readonly pixiFishing?: boolean;');
    expect(viteConfig).toContain('VITE_PIXI_FISHING=true, but this build contains no Pixi chunk.');
    // And it is additive: a caller that does not pass it keeps the old behaviour, which is what
    // lets the Phase 9 switch tests construct options with `worldRenderer` alone.
    expect(viteConfig).toContain('options.pixiFishing === true');
  });
});

/* ── Reading `ci.yml` for the Phase 17 wiring ───────────────────────────────── */

const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const COMPATIBILITY_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/compatibility.yml');
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');

/** The CI jobs, by id. The same shape every sibling wiring gate in this repository uses. */
function parseCiJobs(text: string): ReadonlyMap<string, string> {
  const lines = text.split('\n');
  const jobsIndex = lines.indexOf('jobs:');
  if (jobsIndex === -1) return new Map();
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current !== null) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

/** One job's steps: the `- name:`/`- run:`/`- uses:` blocks under its own indentation. */
function ciStepsOf(jobBody: string): ReadonlyArray<{ readonly name: string; readonly text: string }> {
  const starts: number[] = [];
  const pattern = /^ {6}- /gm;
  for (let match = pattern.exec(jobBody); match !== null; match = pattern.exec(jobBody)) {
    starts.push(match.index);
  }
  return starts.map((start, index) => {
    const body = jobBody.slice(start, starts[index + 1] ?? jobBody.length);
    return { name: /^ {6}- name: (.+)$/m.exec(body)?.[1] ?? '', text: body };
  });
}

/** One named step's own block, comments included, or `''` when the job has no such step. */
function ciStepFor(jobBody: string, name: string): string {
  return ciStepsOf(jobBody).find((step) => step.name === name)?.text ?? '';
}

/**
 * Enough steps in `browser-smoke` that "nothing runs between two of them" is a statement about a
 * window and not about a parser that matched nothing.
 *
 * The job carries this lane's four steps plus the Phase 1 suite, the Phase 10 lane, the two Pixi
 * lanes and their downloads and discards. A floor this far below the real count survives a future
 * step and is still high enough that a broken parse cannot satisfy an ordering check.
 */
const MINIMUM_BROWSER_SMOKE_STEPS = 20;

const CI_BUILD_JOB = 'web-build';
const CI_BROWSER_JOB = 'browser-smoke';

const PHASE17_BUILD_STEP = 'Build the Phase 17 Pixi-fishing-flagged artifact';
const PHASE17_RECORD_STEP = 'Record the Pixi-fishing-flagged artifact identity';
const PHASE17_VERIFY_BUILD_STEP = 'Verify the Pixi-fishing-flagged artifact identity';
const PHASE17_UPLOAD_STEP = 'Upload the Pixi-fishing-flagged web artifact';
const PHASE17_DISCARD_STEP = 'Discard the Pixi-flagged dist before the fishing download';
const PHASE17_DOWNLOAD_STEP = 'Download the Pixi-fishing-flagged artifact';
const PHASE17_VERIFY_STEP = 'Verify the Pixi-fishing-flagged artifact identity';
const PHASE17_RUN_STEP = 'Run the Pixi fishing lane';
/** The artifact name both jobs use, so a download cannot reach a different upload. */
const PHASE17_ARTIFACT_NAME = 'pixi-fishing-web-artifact';
/** The two steps this lane's own placement is forced to come after. */
const PHASE17_AFTER_STEPS = [
  'Run the Pixi world mount/unmount memory lane',
  'Run the Pixi canvas-pointer DOM mirror lane',
];
/** The step that replaces the tree this lane's download merges into, if it did not discard. */
const PIXI_DISCARD_STEP = 'Discard the production dist before the flagged download';

describe('fishing lane CI wiring (ci.yml)', () => {
  const ciJobs = parseCiJobs(ciWorkflow);
  const buildJob = ciJobs.get(CI_BUILD_JOB) ?? '';
  const smokeJob = ciJobs.get(CI_BROWSER_JOB) ?? '';

  it('parses both jobs, and the browser job has enough steps for a window to mean something', () => {
    expect(ciJobs.has(CI_BUILD_JOB), `ci.yml has no ${CI_BUILD_JOB} job`).toBe(true);
    expect(ciJobs.has(CI_BROWSER_JOB), `ci.yml has no ${CI_BROWSER_JOB} job`).toBe(true);
    expect(ciStepsOf(smokeJob).length).toBeGreaterThanOrEqual(MINIMUM_BROWSER_SMOKE_STEPS);
    // The Phase 17 steps are all found by name, so none of the ordering below is satisfied by a
    // step block that is really some other step's.
    for (const name of [PHASE17_RUN_STEP, PHASE17_DOWNLOAD_STEP, PHASE17_DISCARD_STEP, PHASE17_VERIFY_STEP]) {
      expect(ciStepFor(smokeJob, name), `${CI_BROWSER_JOB} has no step named "${name}"`).not.toBe('');
    }
    for (const name of [PHASE17_BUILD_STEP, PHASE17_RECORD_STEP, PHASE17_VERIFY_BUILD_STEP, PHASE17_UPLOAD_STEP]) {
      expect(ciStepFor(buildJob, name), `${CI_BUILD_JOB} has no step named "${name}"`).not.toBe('');
    }
  });

  it('builds the flagged artifact in the one job allowed to build, and uploads it by its own name', () => {
    /*
     * `VITE_PIXI_FISHING` is a build-time flag, so the flagged pond can only be produced by
     * building with it — and eleven sibling gates assert that no job other than `web-build` runs
     * any `build:web*` script. So this step is here by arithmetic, not by preference.
     */
    expect(ciStepFor(buildJob, PHASE17_BUILD_STEP)).toContain(`run: npm run ${FISHING_LANE.buildScript}`);
    expect(npmScripts[FISHING_LANE.buildScript]).toBe('VITE_PIXI_FISHING=true npm run build:web');
    expect(ciStepFor(buildJob, PHASE17_RECORD_STEP)).toContain(
      `run: npm run ${FISHING_LANE.recordScript}`,
    );
    expect(ciStepFor(buildJob, PHASE17_VERIFY_BUILD_STEP)).toContain(
      `run: npm run ${FISHING_LANE.verifyScript}`,
    );
    // Recorded and verified in the job that built it, so the identity is satisfiable there — the
    // same reason the production and Pixi artifacts record in place.
    expect(ciStepFor(buildJob, PHASE17_UPLOAD_STEP)).toContain(`name: ${PHASE17_ARTIFACT_NAME}`);
    // With **its own** manifest, so a rollback claim can never be verified against the pond and the
    // release identity can never be read as this build's.
    expect(ciStepFor(buildJob, PHASE17_UPLOAD_STEP)).toContain(FISHING_MANIFEST_PATH);
    expect(ciStepFor(buildJob, PHASE17_UPLOAD_STEP)).toContain('dist');
    expect(ciStepFor(buildJob, PHASE17_UPLOAD_STEP)).toContain('if-no-files-found: error');
    // The upload name is shared with the download below, which is what makes "downloads the
    // artifact this job uploaded" an assertion rather than a hope. A dead comparison against a
    // string that is not in the workflow is the failure this replaces.
    expect(ciStepFor(smokeJob, PHASE17_DOWNLOAD_STEP)).toContain(`name: ${PHASE17_ARTIFACT_NAME}`);
    expect(ciStepFor(smokeJob, PHASE17_DOWNLOAD_STEP)).toMatch(/^\s*uses: actions\/download-artifact@v4$/m);
    // ...and this job is the only one that may build, still.
    for (const [name, body] of ciJobs) {
      if (name === CI_BUILD_JOB) continue;
      expect(body, `${name} builds a second artifact`).not.toContain('npm run build:web');
    }
  });

  it('downloads, verifies and runs the lane in the browser job, in that order, after the Pixi lanes', () => {
    /*
     * The ordering is the whole of the property. The lane must not measure a stale tree, so its
     * step comes after both the download and the identity check; and it must not steal the artifact
     * the two Pixi lanes were given, so it comes after them.
     */
    const order = [
      ...PHASE17_AFTER_STEPS,
      PHASE17_DISCARD_STEP,
      PHASE17_DOWNLOAD_STEP,
      PHASE17_VERIFY_STEP,
      PHASE17_RUN_STEP,
    ].map((name) => smokeJob.indexOf(`name: ${name}`));
    expect(order.every((index) => index > -1), 'all six Phase 17 steps are in this job').toBe(true);
    expect([...order].sort((a, b) => a - b), 'the six steps are not in that order').toEqual(order);
    // The step runs the **npm script**, not a raw Playwright command, so the command CI executes and
    // the command this gate asserts are one string rather than two.
    expect(ciStepFor(smokeJob, PHASE17_RUN_STEP)).toContain(`run: npm run ${FISHING_LANE.ciRunScript}`);
    expect(ciStepFor(smokeJob, PHASE17_VERIFY_STEP)).toContain(
      `run: npm run ${FISHING_LANE.verifyScript}`,
    );
    // ...and that script is the preview-only one: it cannot rebuild, so the artifact the lane
    // measures is the artifact the build job uploaded.
    expect(npmScripts[FISHING_LANE.ciRunScript]).toBe(
      `${FISHING_LANE.preflightCommand} && ${FISHING_PLAYWRIGHT_COMMAND}`,
    );
  });

  it('replaces the tree before the download rather than merging a third build into it', () => {
    /*
     * Found the hard way once already, on the first CI run of Phase 9: `actions/download-artifact`
     * extracts *into* the working directory, so the first flagged download merged into the
     * production tree the earlier download left behind. The identity check caught that, which is the
     * right place for it to be caught, but a red run is a worse outcome than a correct one — so the
     * tree is replaced explicitly. A third artifact makes the same mistake available again, so the
     * invariant is asserted for the new step rather than assumed to follow from the first.
     */
    expect(ciStepFor(smokeJob, PHASE17_DISCARD_STEP)).toMatch(/rm -rf dist/);
    const after = smokeJob.slice(smokeJob.indexOf(`name: ${PHASE17_DISCARD_STEP}`));
    const beforeDownload = after.slice(0, after.indexOf(`name: ${PHASE17_DOWNLOAD_STEP}`));
    expect(
      [...beforeDownload.matchAll(/^\s*-\s+(?:run|uses):[^\n]*$/gm)].map((match) => match[0]),
      'nothing runs between this lane\'s discard and its download',
    ).toHaveLength(0);
    // ...and this lane's discard is itself *after* the Pixi lanes' discard and download, so it
    // replaces the Pixi-flagged tree rather than the production one.
    expect(smokeJob.indexOf(`name: ${PHASE17_DISCARD_STEP}`)).toBeGreaterThan(
      smokeJob.indexOf(`name: ${PIXI_DISCARD_STEP}`),
    );
  });

  it('GATES: neither job is exempt from failing, and the lane steps add nothing of their own', () => {
    /*
     * A step that could not fail would leave Phase 17's central exit criterion ungated, which is the
     * failure these steps exist to prevent. Matched as a YAML key at the start of a line so this
     * file's prose and the workflow's comments — which discuss the exemption deliberately — are not
     * counted as one.
     */
    for (const [jobName, jobBody] of [
      [CI_BROWSER_JOB, smokeJob],
      [CI_BUILD_JOB, buildJob],
    ] as const) {
      expect(
        [...jobBody.matchAll(/^\s*continue-on-error\s*:/gm)].length,
        `a step in ${jobName} is exempt from failing`,
      ).toBe(0);
      expect(jobBody).not.toMatch(/continue-on-error/);
      for (const stepName of [PHASE17_RUN_STEP, PHASE17_BUILD_STEP, PHASE17_UPLOAD_STEP]) {
        const step = ciStepFor(jobBody, stepName);
        expect(step, stepName).not.toContain('|| true');
        expect(step, stepName).not.toContain('exit 0');
      }
    }
    // The lane step previews and measures: no build, no record, no second download, no browser
    // install. The job already has exactly one Chromium and exactly one `npm ci`, and this lane
    // reuses both.
    const runStep = ciStepFor(smokeJob, PHASE17_RUN_STEP);
    for (const forbidden of ['npm run build:', 'record:web-artifact', 'download-artifact', 'playwright install']) {
      expect(runStep, forbidden).not.toContain(forbidden);
    }
    expect([...smokeJob.matchAll(/^\s*- run: npx playwright install[^\n]*$/gm)].length).toBe(1);
    expect([...smokeJob.matchAll(/^\s*- run: npm ci[^\n]*$/gm)].length).toBe(1);
    // And the build job still installs no browser, which is what keeps this a build-level step.
    expect(buildJob).not.toContain('playwright install');
    expect(ciStepFor(buildJob, PHASE17_BUILD_STEP)).not.toContain('playwright');
  });

  it('counts every artifact this run produces, so a fourth download or upload is a failing edit', () => {
    /*
     * The count is the assertion: every artifact arriving in `browser-smoke` and every artifact
     * leaving `web-build` is a *named step*, so no artifact can show up unannounced. Adding this
     * lane made both counts one larger — a third download and a fourth upload — and each count is
     * asserted against the names rather than against a bare number, so a count that is satisfied by
     * an unnamed download fails here.
     */
    const downloads = [...smokeJob.matchAll(/^\s*uses: actions\/download-artifact@v4[^\n]*$/gm)];
    expect(downloads.length).toBe(3);
    for (const artifact of ['web-artifact', 'pixi-web-artifact', PHASE17_ARTIFACT_NAME]) {
      expect(smokeJob, `${artifact} is not downloaded in ${CI_BROWSER_JOB}`).toContain(`name: ${artifact}`);
    }
    const uploads = [...buildJob.matchAll(/- name: ([^\n]+)\n\s+uses: actions\/upload-artifact@v4/g)].map(
      (match) => match[1]?.trim(),
    );
    expect(uploads).toEqual([
      'Upload build metadata',
      'Upload the shared production web artifact',
      'Upload the Pixi-flagged web artifact',
      PHASE17_UPLOAD_STEP,
    ]);
    // The release artifact is uploaded exactly once, so a flagged upload can never be read as it.
    expect(ciWorkflow.split('Upload the shared production web artifact').length - 1).toBe(1);
    // The bundle budget runs against the flagged build too: the pond is a lazy chunk the release
    // path does not ship, and a chunk that arrives oversized has to fail in the job that produced
    // it rather than in whichever lane looks at it first.
    expect(buildJob).toContain(`npm run ${FISHING_LANE.buildScript}`);
    expect(ciWorkflow.split(`npm run ${FISHING_LANE.buildScript}`).length - 1).toBe(1);
  });

  it('uploads the lane evidence through the existing allowlist, and nothing else leaves the runner', () => {
    /*
     * The lane writes sanitized per-run JSON under `artifacts/compatibility-evidence/`, which the
     * job's existing allowlisted upload already takes, so this lane adds an upload step of its own
     * and nothing else. It records no trace, screenshot or video, so the job's pre-existing failure
     * upload is the only other thing that could carry one — and it names neither of this lane's
     * output directories, which is asserted rather than assumed.
     */
    const upload = ciStepFor(smokeJob, 'Upload sanitized browser-smoke evidence');
    expect(upload).toContain('path: artifacts/compatibility-evidence');
    expect(upload).toContain('if: always()');
    // Scoped to the two upload steps rather than to the job text, because the job's comments discuss
    // trace, screenshot and video on purpose — and an absence check over the raw text would fail its
    // own explanation. What must not exist is a path to one.
    for (const forbidden of ['trace', 'video', 'screenshot', '.webm', '.zip']) {
      expect(upload, `${forbidden} is uploaded from ${CI_BROWSER_JOB}`).not.toContain(forbidden);
    }
    // ...and the job's pre-existing failure upload still names exactly the two directories it named
    // before this lane existed, so this lane added nothing to it. Matched as the whole `path:` block
    // in the job text rather than as a step slice, because the last step of a job runs to the end of
    // that job's body and would otherwise pick up the *next* job's leading comments.
    const failurePath = /- name: Upload browser failure evidence[\s\S]*?path: \|?\n\s+([^\n]+)\n\s+([^\n]+)\n/;
    const failureMatch = failurePath.exec(smokeJob);
    expect(failureMatch, 'the failure upload has no two-entry path block').not.toBeNull();
    expect(failureMatch?.[1]?.trim()).toBe('artifacts/playwright-report');
    expect(failureMatch?.[2]?.trim()).toBe('artifacts/test-results');
    // This lane's own output directories are named nowhere in the job, so no upload can reach them.
    // Checked over the whole job text on purpose, because a directory name is never discussed in
    // prose here — a comment naming one would be a path out of the allowlist.
    for (const forbidden of [
      'artifacts/playwright-fishing-report',
      'artifacts/fishing-test-results',
    ]) {
      expect(smokeJob, forbidden).not.toContain(forbidden);
    }
    // One evidence upload, so a lane that uploaded raw artifacts of its own would be visible here.
    expect([...smokeJob.matchAll(/path: artifacts\/compatibility-evidence/g)].length).toBe(1);
  });

  it('is deliberately absent from the scheduled release-candidate matrix', () => {
    /*
     * A decision, asserted rather than left to drift. `compatibility.yml` is the weekly
     * cross-engine matrix, and this lane declares itself Chromium-only: `installTargets` is
     * `['chromium']` and its `doesNotProve` says in words that it is not a cross-engine result.
     * Adding it there would either cost eight browser installs for one engine's evidence or imply
     * an engine claim the lane does not make, so the honest placement is here and nowhere else.
     */
    const rc = readFileSync(COMPATIBILITY_WORKFLOW_PATH, 'utf8');
    expect(rc, 'the RC workflow must not run the fishing lane').not.toContain(FISHING_LANE.ciRunScript);
    expect(rc, 'the RC workflow must not build the flagged fishing artifact').not.toContain(
      FISHING_LANE.buildScript,
    );
    // And it still builds exactly one production artifact, which is the workflow's whole contract.
    const rcBuilds = [...parseCiJobs(rc).entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(rcBuilds.map(([name]) => name)).toHaveLength(1);
  });
});