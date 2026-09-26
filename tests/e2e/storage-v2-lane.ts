/**
 * Phase 4 storage-v2 browser lane declaration.
 *
 * This module is the single machine-readable source for the Phase 4 flagged
 * build lane, imported by `playwright.storage-v2.config.ts` and checked against
 * the real storage-v2 contract, the package scripts, and `.github/workflows/ci.yml`
 * by `tests/e2e/storage-v2-lane.test.ts`.
 *
 * Why the lane exists: every storage-v2 result so far is `fake-indexeddb` under
 * jsdom. The recorded Phase 3 limitations are real-browser IndexedDB transaction
 * semantics, a real legacy migration, a real device-local attachment write, and
 * cross-reload durability. None of those can be observed on the default build,
 * because the default build never opens storage-v2 at all - the production
 * default stays `VITE_STORAGE_REPOSITORY=legacy` and Phaser (plan section 11).
 * So this lane builds a SECOND, explicitly flagged artifact, records its
 * identity with the existing `scripts/web-artifact-manifest.mjs`, and runs one
 * spec against it.
 *
 * Deliberately separate from the default build's lanes:
 *
 * - It runs from `playwright.storage-v2.config.ts`, so `npm run test:e2e` and
 *   `npm run test:e2e:compat` cannot pick this spec up and the current-build
 *   suite is not multiplied across a new project.
 * - Its recorded identity goes to its own manifest file. The default artifact's
 *   `artifacts/web-artifact-manifest.json` is never overwritten, so a flagged
 *   build can never be mistaken for the recorded production artifact.
 * - It replaces `dist`, so it is never run concurrently with another Playwright
 *   invocation in the same worktree. That is the same constraint the existing
 *   `preview:e2e` port and `reuseExistingServer: false` already impose.
 *
 * The build flag is carried by `.env.storage-v2` and applied through Vite's
 * `--mode storage-v2`, so no shell-specific environment assignment is needed and
 * the production build is untouched by the lane.
 *
 * Nothing in this module may contain learner data, request data, credentials, or
 * a private URL. The only host it names is the reserved `example.invalid`.
 */

export const STORAGE_V2_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repo. */
export const STORAGE_V2_PROJECT = 'storage-v2-chromium';

/** The only spec this lane may run. Never the current-build spec. */
export const STORAGE_V2_TEST_FILE = 'storageV2.spec.ts';
export const STORAGE_V2_TEST_PATH = `tests/e2e/${STORAGE_V2_TEST_FILE}`;

/** The Playwright config that owns the lane. */
export const STORAGE_V2_CONFIG_FILE = 'playwright.storage-v2.config.ts';

/** Build identity of the flagged artifact. */
export const STORAGE_V2_BUILD_MODE = 'storage-v2';
export const STORAGE_V2_ENV_FILE = '.env.storage-v2';
export const STORAGE_V2_FLAG = 'VITE_STORAGE_REPOSITORY';
export const STORAGE_V2_FLAG_VALUE = 'v2';
export const STORAGE_V2_BUILD_SCRIPT = 'build:storage-v2-flagged';

/**
 * The build script the `storage-v2-browser` CI job runs.
 *
 * Phase 5 added the fresh-profile restore lane, which previews the *same* flagged
 * artifact and needs the Phase 5 owner flag on to exercise the product. The job
 * therefore builds with `build:storage-v2-data-products`, which is this same
 * `--mode storage-v2` build off the same `.env.storage-v2` with one extra flag value
 * in the environment. Two consequences this declaration records:
 *
 * - The single-build property is unchanged: one artifact, built once, serves both
 *   flagged lanes. A second job or a second build step would have broken it.
 * - The product-free script stays the one `npm run test:e2e:storage` uses, so this
 *   lane is still independently verifiable against an artifact with the data
 *   products off.
 */
export const STORAGE_V2_CI_BUILD_SCRIPT = 'build:storage-v2-data-products';

/**
 * Its own recorded identity, so the flagged artifact is never confused with the
 * shared production artifact recorded in `artifacts/web-artifact-manifest.json`.
 */
export const STORAGE_V2_MANIFEST_PATH = 'artifacts/web-artifact-manifest-storage-v2.json';

/**
 * The storage-v2 contract this lane reads out of the browser.
 *
 * These must equal the constants in
 * `src/services/persistence/v2/{schema,validation}.ts`; that equality is
 * asserted by `tests/e2e/storage-v2-lane.test.ts`, which can resolve the `@/`
 * alias. Duplicating them here is deliberate: the Playwright lane must not
 * import application modules, because `schema.ts` reaches `@/core/**` and
 * transpiling the application's own module graph inside a Playwright worker is
 * a second, unrelated failure mode.
 */
export const STORAGE_V2_STORAGE_CONTRACT = {
  databaseName: 'knowledge-dungeon-storage-v2',
  schemaVersion: 1,
  metaStore: 'meta',
  activeGenerationOwner: '@active-generation',
  activeGenerationKey: 'activeGeneration',
  generationKeyPrefix: 'generation:',
  generationScopeIndex: 'byGeneration',
  subjectsStore: 'subjects',
  progressionStore: 'progression',
  sessionsStore: 'sessions',
  preferencesStore: 'preferences',
  shortcutsStore: 'shortcuts',
  attachmentsStore: 'attachments',
  migrationReceiptsStore: 'migrationReceipts',
  attachmentMetadataPrefix: 'meta:',
  attachmentBlobPrefix: 'blob:',
} as const;

export interface StorageV2LaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-4-storage-v2-flagged-build';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildMode: string;
  readonly buildScript: string;
  readonly envFile: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  /** Recorded in the evidence record for every test in the lane. */
  readonly storageRepository: 'v2';
  /** Phase 4 does not change the renderer; Phaser remains the expected host. */
  readonly worldRenderer: 'phaser';
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: 'pointer-keyboard';
  readonly evidenceClass: 'emulated-viewport';
  readonly ciLanes: readonly 'pull-request'[];
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a cross-engine result; Firefox, WebKit, and Edge lanes do not run this spec.',
  'Not the production artifact: this lane exercises a build with VITE_STORAGE_REPOSITORY=v2, which is not the default.',
  'Not evidence that the default build uses storage-v2; the production default stays legacy until a later reviewed cutover.',
] as const;

export const STORAGE_V2_LANE: StorageV2LaneDeclaration = Object.freeze({
  schemaVersion: STORAGE_V2_LANE_SCHEMA_VERSION,
  suite: 'phase-4-storage-v2-flagged-build',
  project: STORAGE_V2_PROJECT,
  testFile: STORAGE_V2_TEST_FILE,
  configFile: STORAGE_V2_CONFIG_FILE,
  buildMode: STORAGE_V2_BUILD_MODE,
  buildScript: STORAGE_V2_BUILD_SCRIPT,
  envFile: STORAGE_V2_ENV_FILE,
  flag: STORAGE_V2_FLAG,
  flagValue: STORAGE_V2_FLAG_VALUE,
  manifestPath: STORAGE_V2_MANIFEST_PATH,
  storageRepository: 'v2',
  worldRenderer: 'phaser',
  // The Phase 1 `desktop-chromium` viewport, so the flagged build is compared
  // against the same form factor the default build is verified in.
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  ciLanes: ['pull-request'] as const,
  runnerLabels: ['ubuntu-latest'],
  installTargets: ['chromium'] as const,
  claim:
    'A build with VITE_STORAGE_REPOSITORY=v2 migrates a synthetic legacy key set into real browser IndexedDB, hydrates it without data loss, does not duplicate the migration on a second load, and keeps a device-local image attachment byte-identical across a reload, while making no upload request.',
  doesNotProve: [
    ...EMULATION_LIMITATIONS,
    'Not a backup, restore, template, or rollback certification; those are Phases 5 through 7.',
    'Not a quota-exhaustion, cross-tab concurrent migration, or versionchange/blocked upgrade result.',
    'Not evidence for the accessibility or performance gates; no axe scan runs in this lane.',
  ],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validateStorageV2Lane(
  lane: StorageV2LaneDeclaration = STORAGE_V2_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (lane.project === 'desktop-chromium') {
    // The lane must not reuse a name from the approved support matrix: the two
    // suites are separate Playwright configs and must stay separately
    // identifiable in evidence.
    problems.push('the flagged-build lane must not reuse an approved support-matrix project name.');
  }
  if (lane.testFile === 'currentBuild.spec.ts' || lane.testFile === 'compatibility.spec.ts') {
    problems.push('the flagged-build lane must not bind an existing suite spec file.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (lane.storageRepository !== 'v2') problems.push('the lane must record storageRepository v2.');
  if (lane.worldRenderer !== 'phaser') {
    problems.push('Phase 4 does not change the renderer, so the lane must still expect Phaser.');
  }
  if (lane.viewport.width <= 0 || lane.viewport.height <= 0) {
    problems.push('the lane viewport must be positive.');
  }
  if (lane.viewport.width !== 1440 || lane.viewport.height !== 900) {
    problems.push('the lane must use the desktop-chromium-equivalent viewport.');
  }
  if (lane.ciLanes.length === 0) problems.push('the lane must declare an allowed CI lane.');
  if (lane.runnerLabels.length === 0) problems.push('the lane must declare a runner label.');
  if (lane.installTargets.length === 0) problems.push('the lane must declare a browser install target.');
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length === 0) problems.push('the lane must declare a does-not-prove list.');
  return problems;
}
