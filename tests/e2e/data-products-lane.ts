/**
 * Phase 5 fresh-profile restore lane declaration.
 *
 * This module is the single machine-readable source for the Phase 5 browser lane,
 * imported by `playwright.data-products.config.ts` and checked against the real
 * package scripts, the real Playwright project, and the real CI job by
 * `tests/e2e/data-products-lane.test.ts`.
 *
 * ## Why a separate config rather than a second spec in the existing lane
 *
 * The lane needs the **flagged** artifact: Phase 5's exit criterion 1 is a
 * round trip of a *populated storage-v2 state*, and the default build never opens
 * storage-v2 at all (the production default stays `VITE_STORAGE_REPOSITORY=legacy`
 * until a later reviewed cutover). So this lane previews exactly the same `dist`
 * the Phase 4 `storage-v2-browser` job built, and it must not build a second
 * artifact.
 *
 * It is a separate *config* rather than a second spec inside
 * `playwright.storage-v2.config.ts` because that config binds one project to one
 * `testMatch`, and `tests/e2e/storage-v2-lane.test.ts` asserts both facts. Widening
 * either would weaken an existing gate, which this repository does not do. A
 * separate config with its own project name, its own port, and its own recorded-only
 * script keeps the two release paths disjoint and leaves the Phase 4 lane exactly
 * as it was.
 *
 * ## Why the CI wiring is a step inside the existing job
 *
 * The flagged artifact exists only inside the `storage-v2-browser` job, and that
 * job deliberately uploads *evidence only* - never `dist`. A second job would
 * therefore have to build the artifact again, which is exactly the duplication this
 * lane must avoid. Two extra steps in the existing job keep one build, one preview
 * server, and one Chromium install, and they leave the "exactly one job runs
 * `npm run build:web`" and "exactly four pull-request compatibility lanes"
 * assertions untouched.
 *
 * The step **gates**: the product it exercises is landed and reviewed, and this
 * lane is the phase's acceptance evidence for the fresh-profile restore
 * deliverable, so a restore regression has to be a red run rather than a green one.
 * `tests/e2e/data-products-lane.test.ts` asserts the step does *not* carry
 * `continue-on-error`, so the exemption cannot creep back in unnoticed.
 *
 * ## Freshness
 *
 * The lane proves freshness rather than assuming it. A **new browser context** with
 * no `storageState` is created for the restore, and the origin is inspected on a
 * same-origin non-application URL *before* the application ever runs, so the
 * observation is of an untouched profile rather than of one the app has already
 * written to. `tests/e2e/data-productsRestore.spec.ts` records the key set, the
 * database list, and the object-store list at both points.
 *
 * ## Order independence
 *
 * A `.kdbak` state document is canonical JSON, and `canonicalJsonStringify` sorts
 * object keys at every depth, so a restored room map comes back in sorted-key order
 * rather than seed order. That sorting is what makes an export byte-deterministic,
 * and the plan depends on it. The lane therefore addresses rooms **by id** and
 * asserts the room-id *set*, never a position: asserting order would be asserting an
 * artifact of key sorting rather than a property of the restore.
 *
 * ## Generation labels
 *
 * The importer deliberately adopts the archive's own generation label when the
 * receiving device holds nothing under it, so the migration receipts the archive
 * carries keep naming the generation they belong to. Two devices can therefore share
 * a label after a restore. The lane asserts what the retention promise actually is -
 * the active generation is not the previous one, and the previous generation is still
 * readable with its records intact - rather than asserting that two devices hold
 * different labels.
 * * Privacy: nothing in this module may contain learner data, request data,
 * credentials, or a private URL. The only host it names is the reserved
 * `example.invalid`.
 */

export const DATA_PRODUCTS_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repo. */
export const DATA_PRODUCTS_PROJECT = 'data-products-restore-chromium';

/** The only spec this lane may run. */
export const DATA_PRODUCTS_TEST_FILE = 'dataProductsRestore.spec.ts';
export const DATA_PRODUCTS_TEST_PATH = `tests/e2e/${DATA_PRODUCTS_TEST_FILE}`;

/** The Playwright config that owns the lane. */
export const DATA_PRODUCTS_CONFIG_FILE = 'playwright.data-products.config.ts';

/**
 * The artifact this lane previews.
 *
 * The *same* flagged artifact the Phase 4 lane uses: same build mode, same env
 * file, same recorded identity. Stated as data so the wiring test can prove the
 * two lanes cannot drift onto different builds.
 */
export const DATA_PRODUCTS_BUILD_MODE = 'storage-v2';
export const DATA_PRODUCTS_ENV_FILE = '.env.storage-v2';
export const DATA_PRODUCTS_FLAG = 'VITE_STORAGE_REPOSITORY';
export const DATA_PRODUCTS_FLAG_VALUE = 'v2';
export const DATA_PRODUCTS_MANIFEST_PATH = 'artifacts/web-artifact-manifest-storage-v2.json';
export const DATA_PRODUCTS_BUILD_SCRIPT = 'build:storage-v2-flagged';

/**
 * The build script CI uses, and the one `test:e2e:data-products:full` uses locally.
 *
 * A strict **superset** of {@link DATA_PRODUCTS_BUILD_SCRIPT}: the same
 * `--mode storage-v2` build off the same `.env.storage-v2`, with one extra flag
 * value in the environment. That is what keeps the single-build property true -
 * one artifact, built once, serves both the Phase 4 lane and this one - while the
 * Phase 4 lane's own product-free build script stays available for
 * `npm run test:e2e:storage`, so the two phases remain independently verifiable.
 *
 * The owner flag is set in the environment rather than in `.env.storage-v2`
 * because that file is a Phase 4 committed artifact whose contents are asserted by
 * `storage-v2-lane.test.ts`. `scripts/build-flagged-data-products.mjs` explains the
 * mechanism and why it is a script rather than a shell assignment.
 */
export const DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT = 'build:storage-v2-data-products';

/** The local build-record-run convenience script. CI runs the steps separately. */
export const DATA_PRODUCTS_FULL_SCRIPT = 'test:e2e:data-products:full';

/**
 * The Phase 5 owner flag.
 *
 * The product is landed and reviewed, and this lane is the phase's acceptance
 * evidence for the fresh-profile restore deliverable, so the artifact it previews
 * carries the flag **on**. Recorded as a constant rather than inferred, so the
 * evidence file for every run says whether the product was present, and a lane that
 * silently previewed a product-free build would be caught by the wiring test
 * comparing this value against the CI build script.
 */
export const DATA_PRODUCTS_OWNER_FLAG = 'VITE_DATA_PRODUCTS_V2';
export const DATA_PRODUCTS_OWNER_FLAG_ENABLED_IN_THIS_LANE = true;

/** The fixed preview port, distinct from `preview:e2e`'s. */
export const DATA_PRODUCTS_PREVIEW_PORT = 43179;
export const DATA_PRODUCTS_PREVIEW_SCRIPT = 'preview:e2e:data-products';
export const DATA_PRODUCTS_PREVIEW_COMMAND = 'npm run preview:e2e:data-products';

/** The package scripts that own the lane. */
export const DATA_PRODUCTS_SCRIPTS = {
  full: 'test:e2e:data-products',
  recorded: 'test:e2e:data-products:recorded',
  preview: DATA_PRODUCTS_PREVIEW_SCRIPT,
} as const;

export const DATA_PRODUCTS_CI_JOB = 'storage-v2-browser';
export const DATA_PRODUCTS_CI_STEP_NAME = 'Run the fresh-profile data-product restore lane';

export interface DataProductsLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-5-fresh-profile-restore';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildMode: string;
  /** The product-free flagged build script, still used by `test:e2e:storage`. */
  readonly buildScript: string;
  /** The superset build script CI and `test:e2e:data-products:full` use. */
  readonly supersetBuildScript: string;
  readonly envFile: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  /** The same artifact identity the Phase 4 lane verifies. */
  readonly sharesArtifactWith: 'phase-4-storage-v2-flagged-build';
  readonly storageRepository: 'v2';
  readonly worldRenderer: 'phaser';
  readonly dataProductsV2: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: 'pointer-keyboard';
  readonly evidenceClass: 'emulated-viewport';
  readonly ciJob: string;
  readonly ciStepName: string;
  readonly ciLane: 'same-job-as-phase-4-flagged-build';
  /** Downloads must be enabled: a backup is a local file the learner keeps. */
  readonly acceptDownloads: true;
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  /** The interaction contract the spec drives, in the plan's own vocabulary. */
  readonly interactionContract: {
    readonly dataCenterName: RegExp;
    readonly fullBackupTabName: RegExp;
    readonly createBackupControlName: RegExp;
    readonly inspectFileControlName: RegExp;
    readonly destructiveConfirmControlName: RegExp;
  };
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a cross-engine result; Firefox, WebKit, and Edge lanes do not run this spec.',
  'Not the production artifact: this lane previews a build with VITE_STORAGE_REPOSITORY=v2, which is not the default.',
  'Not evidence that the default build uses storage-v2; the production default stays legacy until a later reviewed cutover.',
] as const;

export const DATA_PRODUCTS_LANE: DataProductsLaneDeclaration = Object.freeze({
  schemaVersion: DATA_PRODUCTS_LANE_SCHEMA_VERSION,
  suite: 'phase-5-fresh-profile-restore',
  project: DATA_PRODUCTS_PROJECT,
  testFile: DATA_PRODUCTS_TEST_FILE,
  configFile: DATA_PRODUCTS_CONFIG_FILE,
  buildMode: DATA_PRODUCTS_BUILD_MODE,
  buildScript: DATA_PRODUCTS_BUILD_SCRIPT,
  supersetBuildScript: DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT,
  envFile: DATA_PRODUCTS_ENV_FILE,
  flag: DATA_PRODUCTS_FLAG,
  flagValue: DATA_PRODUCTS_FLAG_VALUE,
  manifestPath: DATA_PRODUCTS_MANIFEST_PATH,
  sharesArtifactWith: 'phase-4-storage-v2-flagged-build',
  storageRepository: 'v2',
  worldRenderer: 'phaser',
  dataProductsV2: DATA_PRODUCTS_OWNER_FLAG_ENABLED_IN_THIS_LANE,
  // The Phase 1 `desktop-chromium` viewport, the same one the Phase 4 lane uses,
  // so the two lanes are compared on the same form factor.
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  ciJob: DATA_PRODUCTS_CI_JOB,
  ciStepName: DATA_PRODUCTS_CI_STEP_NAME,
  ciLane: 'same-job-as-phase-4-flagged-build',
  acceptDownloads: true,
  runnerLabels: ['ubuntu-latest'] as const,
  installTargets: ['chromium'] as const,
  interactionContract: {
    // The plan fixes the nouns: a "Data Center shell with a full-backup tab and
    // privacy explanation", "local download", "file inspection and an explicit
    // destructive confirmation", and an "import". These patterns are the contract
    // the spec drives, kept in one declaration so the implementer has a single
    // place to align, and deliberately loose about wording so a reasonable
    // accessible name matches.
    dataCenterName: /data\s*center/i,
    fullBackupTabName: /full[\s-]*device|full[\s-]*backup/i,
    createBackupControlName: /(create|save|export|download)[^a-z]*(backup|device backup)|backup[^a-z]*(create|save|export|download)/i,
    inspectFileControlName: /inspect|review|preview|choose file|select file|open file/i,
    destructiveConfirmControlName: /replace|confirm|import|continue|overwrite/i,
  },
  claim:
    'A full-device backup exported from a populated storage-v2 device in one browser context restores into a second, freshly created browser context whose profile was observed to be empty before the application ran, and the restored state reads back equal, with no upload, share, or non-static request at any point.',
  doesNotProve: [
    ...EMULATION_LIMITATIONS,
    'Not a template, subject-only, or rollback certification; those are Phases 6 and 7.',
    'Not a quota-exhaustion, cross-tab, or versionchange/blocked upgrade result.',
    'Not evidence for the accessibility or performance gates; no axe scan runs in this lane.',
    'Not evidence that a corrupt archive is refused; that is tests/data, and this lane restores only an archive the product itself wrote.',
  ],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validateDataProductsLane(
  lane: DataProductsLaneDeclaration = DATA_PRODUCTS_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (lane.project === 'desktop-chromium' || lane.project === 'storage-v2-chromium') {
    // The lane must not reuse a name from the approved support matrix or from the
    // Phase 4 flagged lane: three separate Playwright configs must stay
    // separately identifiable in evidence.
    problems.push('the fresh-profile lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (
    lane.testFile === 'currentBuild.spec.ts' ||
    lane.testFile === 'compatibility.spec.ts' ||
    lane.testFile === 'storageV2.spec.ts'
  ) {
    problems.push('the fresh-profile lane must not bind an existing suite spec file.');
  }
  if (lane.storageRepository !== 'v2') problems.push('the lane must record storageRepository v2.');
  if (lane.worldRenderer !== 'phaser') {
    problems.push('Phase 5 does not change the renderer, so the lane must still expect Phaser.');
  }
  if (lane.viewport.width !== 1440 || lane.viewport.height !== 900) {
    problems.push('the lane must use the desktop-chromium-equivalent viewport.');
  }
  if (lane.sharesArtifactWith !== 'phase-4-storage-v2-flagged-build') {
    problems.push('the lane must declare that it previews the Phase 4 flagged artifact.');
  }
  if (lane.acceptDownloads !== true) {
    problems.push('a local-download lane must enable downloads.');
  }
  if (lane.dataProductsV2 !== DATA_PRODUCTS_OWNER_FLAG_ENABLED_IN_THIS_LANE) {
    problems.push('the lane must record whether the Phase 5 owner flag is on in the artifact it previews.');
  }
  // The superset build script must be a *different* script from the product-free
  // one. If they collapsed into one name, the Phase 4 lane's product-free artifact
  // would be gone and the two phases would no longer be independently verifiable.
  if (lane.supersetBuildScript === lane.buildScript) {
    problems.push('the superset build script must differ from the product-free flagged build script.');
  }
  if (lane.runnerLabels.length === 0) problems.push('the lane must declare a runner label.');
  if (lane.installTargets.length === 0) problems.push('the lane must declare a browser install target.');
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length === 0) problems.push('the lane must declare a does-not-prove list.');
  // Every interaction pattern has to be able to match something. A pattern that
  // cannot match would make the spec's failure say nothing about the product.
  for (const [name, pattern] of Object.entries(lane.interactionContract)) {
    if (pattern.source.length < 5) problems.push(`interaction pattern ${name} is too short to match.`);
    if (pattern.global || pattern.sticky) problems.push(`interaction pattern ${name} must not be global.`);
  }
  return problems;
}
