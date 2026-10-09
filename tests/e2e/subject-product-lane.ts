/**
 * Phase 6 subject-backup browser lane declaration.
 *
 * The machine-readable source for the `.kdsubject` round-trip lane, imported by
 * `playwright.subject-product.config.ts` and checked against the real package
 * scripts, the real Playwright project, and the real CI step by
 * `tests/e2e/subject-product-lane.test.ts`.
 *
 * ## Why this lane exists at all
 *
 * Phase 6's central risk is a destructive or partial write against a real device
 * and a real IndexedDB, and its primary exit criterion - "a copied subject is
 * independent and fully usable" - had **no browser evidence**: the only substrate
 * was the `fake-indexeddb` shim, whose limits Phase 5's own evidence file records.
 * A shim is a different transaction scheduler and a different durability model
 * from Chromium's, and the thing this product does that a shim cannot fully speak
 * for is a *multi-generation, read-compare-activate* transaction against a database
 * another tab may be using.
 *
 * So the lane is the same shape as Phase 5's, for the same reasons, with the
 * subject product's own claims:
 *
 * 1. a **fresh second browser context** with no `storageState`, whose emptiness is
 *    *observed* before the application runs rather than assumed;
 * 2. a `.kdsubject` written by the product's own export - never a synthesised
 *    archive, because a synthesised one would prove nothing about the product;
 * 3. a **copy** import, asserted for independence: the copy's identifiers must be
 *    disjoint from the source's, and the source must be unchanged;
 * 4. a **refused** import of a hostile archive, asserted to leave the fresh
 *    profile byte-identical - the destructive-write claim, measured rather than
 *    asserted;
 * 5. no egress at any point.
 *
 * ## Why it is a separate config and a separate spec
 *
 * The same reasoning Phase 5 recorded, and the same constraints: the default config
 * binds the support matrix, and `playwright.storage-v2.config.ts` binds exactly one
 * project to exactly one `testMatch`, both of which
 * `tests/e2e/storage-v2-lane.test.ts` asserts. Adding a project to either would
 * weaken an existing gate. This lane therefore has its own project name, its own
 * spec file, and its own port, and it previews **the same `dist`** the other two
 * flagged lanes preview - it never builds.
 *
 * ## What it does not prove
 *
 * Stated in the declaration and asserted by the wiring gate, because a lane that
 * overstates itself is worse than no lane. It is Chromium only, one viewport, the
 * emulated 1440x900 form factor, a build with `VITE_STORAGE_REPOSITORY=v2` and
 * `VITE_DATA_PRODUCTS_V2=true`, and it says nothing about the accessibility,
 * performance, corrupt-archive-matrix, or default-build gates.
 *
 * Privacy: nothing here contains learner data, request data, credentials, or a
 * private URL. Every fixture value is synthetic and self-describing, and the only
 * host it names is the reserved `example.invalid`, which is never dereferenced.
 */

export const SUBJECT_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Unique across every config in the repository. */
export const SUBJECT_LANE_PROJECT = 'subject-product-chromium';

/** The only spec this lane may run. */
export const SUBJECT_LANE_TEST_FILE = 'subjectProductRoundTrip.spec.ts';
export const SUBJECT_LANE_TEST_PATH = `tests/e2e/${SUBJECT_LANE_TEST_FILE}`;

/** The Playwright config that owns the lane. */
export const SUBJECT_LANE_CONFIG_FILE = 'playwright.subject-product.config.ts';

/** The artifact this lane previews: the same one the other two flagged lanes use. */
export const SUBJECT_LANE_BUILD_MODE = 'storage-v2';
export const SUBJECT_LANE_ENV_FILE = '.env.storage-v2';
export const SUBJECT_LANE_MANIFEST_PATH = 'artifacts/web-artifact-manifest-storage-v2.json';
export const SUBJECT_LANE_SUPERSET_BUILD_SCRIPT = 'build:storage-v2-data-products';
export const SUBJECT_LANE_OWNER_FLAG = 'VITE_DATA_PRODUCTS_V2';
export const SUBJECT_LANE_OWNER_FLAG_ENABLED = true;

/** Its own port, so no two lanes can collide in one worktree. */
export const SUBJECT_LANE_PREVIEW_PORT = 43181;
export const SUBJECT_LANE_PREVIEW_SCRIPT = 'preview:e2e:subject-product';
export const SUBJECT_LANE_PREVIEW_COMMAND = `npm run ${SUBJECT_LANE_PREVIEW_SCRIPT}`;

export const SUBJECT_LANE_SCRIPTS = {
  recorded: 'test:e2e:subject-product:recorded',
} as const;

export const SUBJECT_LANE_CI_JOB = 'storage-v2-browser';
export const SUBJECT_LANE_CI_STEP_NAME = 'Run the individual-subject backup lane';

export interface SubjectLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-6-subject-backup';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildMode: string;
  readonly supersetBuildScript: string;
  readonly envFile: string;
  readonly manifestPath: string;
  /** The same flagged artifact the Phase 4 and Phase 5 lanes preview. */
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
  readonly ciLane: 'same-job-as-phase-4-and-5-flagged-builds';
  readonly acceptDownloads: true;
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  /** The controls the spec drives, in the plan's and the product's own vocabulary. */
  readonly interactionContract: {
    readonly dataCenterName: RegExp;
    readonly subjectTabName: RegExp;
    readonly subjectPickerLabel: RegExp;
    readonly exportControlName: RegExp;
    readonly chooseFileControlName: RegExp;
    readonly copyModeName: RegExp;
    readonly replaceModeName: RegExp;
    readonly copyConfirmName: RegExp;
  };
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a cross-engine result; Firefox, WebKit, and Edge lanes do not run this spec.',
  'Not a comparison against the pre-cutover stack: this artifact and the Phase 23 production default both use storage-v2 and have the data products on.',
  'Not evidence that the legacy rollback still round-trips; the Phase 23 rollback artifact is the evidence for that.',
  'Not a two-tab or concurrent-writer result.',
] as const;

export const SUBJECT_LANE: SubjectLaneDeclaration = Object.freeze({
  schemaVersion: SUBJECT_LANE_SCHEMA_VERSION,
  suite: 'phase-6-subject-backup',
  project: SUBJECT_LANE_PROJECT,
  testFile: SUBJECT_LANE_TEST_FILE,
  configFile: SUBJECT_LANE_CONFIG_FILE,
  buildMode: SUBJECT_LANE_BUILD_MODE,
  supersetBuildScript: SUBJECT_LANE_SUPERSET_BUILD_SCRIPT,
  envFile: SUBJECT_LANE_ENV_FILE,
  manifestPath: SUBJECT_LANE_MANIFEST_PATH,
  sharesArtifactWith: 'phase-4-storage-v2-flagged-build',
  storageRepository: 'v2',
  worldRenderer: 'phaser',
  dataProductsV2: SUBJECT_LANE_OWNER_FLAG_ENABLED,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  ciJob: SUBJECT_LANE_CI_JOB,
  ciStepName: SUBJECT_LANE_CI_STEP_NAME,
  ciLane: 'same-job-as-phase-4-and-5-flagged-builds',
  acceptDownloads: true,
  runnerLabels: ['ubuntu-latest'] as const,
  installTargets: ['chromium'] as const,
  interactionContract: {
    dataCenterName: /data\s*center/i,
    subjectTabName: /one subject|subject\s*backup|subject only/i,
    subjectPickerLabel: /subject to back up/i,
    exportControlName: /download this subject/i,
    chooseFileControlName: /choose a subject backup file/i,
    copyModeName: /create a copy/i,
    replaceModeName: /replace the subject it came from/i,
    copyConfirmName: /add a copy of this subject/i,
  },
  claim:
    'A .kdsubject exported by the product from a populated storage-v2 device in one browser context imports as a copy into a second, freshly created browser context whose profile was observed to be empty before the application ran; the copy is present with its own identifiers, disjoint from the source, the source device is unchanged, and a refused import of a hostile archive leaves the fresh profile byte-identical, with no upload, share, or non-static request at any point.',
  doesNotProve: [
    ...EMULATION_LIMITATIONS,
    'Not a corrupt-archive matrix result; this lane refuses exactly one hostile archive and leaves the matrix to tests/data.',
    'Not a replace-fidelity result; the lane exercises the default copy mode and the refusal path, because replace is the destructive mode and is not driven from an unattended lane.',
    'Not evidence for the accessibility or performance gates; no axe scan runs in this lane.',
    'Not evidence that the product chunks stay out of the default build; that is tests/phase5/seam.test.ts.',
  ],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validateSubjectLane(lane: SubjectLaneDeclaration = SUBJECT_LANE): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (['desktop-chromium', 'storage-v2-chromium', 'data-products-restore-chromium'].includes(lane.project)) {
    problems.push('the subject lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (['currentBuild.spec.ts', 'compatibility.spec.ts', 'storageV2.spec.ts', 'dataProductsRestore.spec.ts'].includes(lane.testFile)) {
    problems.push('the subject lane must not bind an existing suite spec file.');
  }
  if (lane.storageRepository !== 'v2') problems.push('the lane must record storageRepository v2.');
  if (lane.worldRenderer !== 'phaser') problems.push('Phase 6 does not change the host; Phase 23 keeps the application host (phaser).');
  if (lane.viewport.width !== 1440 || lane.viewport.height !== 900) {
    problems.push('the lane must use the desktop-chromium-equivalent viewport.');
  }
  if (lane.sharesArtifactWith !== 'phase-4-storage-v2-flagged-build') {
    problems.push('the lane must declare that it previews the shared flagged artifact.');
  }
  if (lane.acceptDownloads !== true) problems.push('a local-download lane must enable downloads.');
  if (lane.dataProductsV2 !== SUBJECT_LANE_OWNER_FLAG_ENABLED) {
    problems.push('the lane must record whether the owner flag is on in the artifact it previews.');
  }
  if (lane.runnerLabels.length === 0) problems.push('the lane must declare a runner label.');
  if (lane.installTargets.length === 0) problems.push('the lane must declare a browser install target.');
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length === 0) problems.push('the lane must declare a does-not-prove list.');
  for (const [name, pattern] of Object.entries(lane.interactionContract)) {
    if (pattern.source.length < 5) problems.push(`interaction pattern ${name} is too short to match.`);
    if (pattern.global || pattern.sticky) problems.push(`interaction pattern ${name} must not be global.`);
  }
  return problems;
}
