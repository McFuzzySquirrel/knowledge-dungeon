/**
 * Reload-persistence browser lane declaration.
 *
 * The machine-readable source for the lane that would have caught the
 * cross-phase data-loss defect Phase 7's verification found. Imported by
 * `playwright.reload-persistence.config.ts` and checked against the real package
 * scripts, the real Playwright project, and the real CI job by
 * `tests/e2e/reload-persistence-lane.test.ts`.
 *
 * ## Why this lane exists at all
 *
 * The defect, in one sentence: **a write that reached the active storage-v2
 * generation only was silently discarded on the next page load.** On the second
 * boot of a device whose first boot had taken the `hasNoLearnerContent`
 * short-circuit, the legacy migration re-ran, found no `gen-migration-0001` on
 * that device, staged a brand-new generation from the stale `localStorage`
 * mirror, and flipped `activeGeneration` onto it. The generation the write was in
 * became `superseded`, which no reader follows, so the write was invisible and
 * unreachable. It hit all three data products: a `.kdbak` restore was silently
 * undone and a subject the learner deleted by restoring came back from the
 * mirror, a `.kdsubject` copy import vanished, and a `.kdtemplate` import was
 * listed in-session and gone after one reload.
 *
 * **Why two accepted phases did not catch it.** Every unit gate read the *active
 * generation* directly. That is the write's destination - and it is exactly the
 * generation the next boot superseded. A gate that reads the destination of a
 * write, immediately, cannot see what a later boot does to it. The missing test
 * was the only one that would have: create a subject through the app's own
 * Welcome form, perform a product write, **reload**, and assert the subject is
 * still listed.
 *
 * ## What this lane is, and is not, a duplicate of
 *
 * The three existing flagged lanes each hold one product's claim, and each is
 * bound by its own wiring gate to exactly one spec file, on a device whose state
 * they control. None of them reloads: `storageV2.spec.ts` boots once,
 * `dataProductsRestore.spec.ts` restores into a *second* browser context and
 * asserts the restored state, and `subjectProductRoundTrip.spec.ts` exports from
 * one context and imports into another. A claim about **what survives a reload of
 * the device that made the write** belongs to none of them, and adding it to any
 * of them would have made that lane's `doesNotProve` list false - the subject lane
 * in particular declares that it does not drive a destructive mode, and a
 * `.kdbak` restore is the most destructive write the product has.
 *
 * So this is a fifth config, its own project, its own spec, and its own port,
 * previewing **the same `dist`** the other three flagged lanes preview. It never
 * builds: plan section 2.5 requires every automated lane to test the same
 * production artifact or an explicitly reproducible one with recorded hashes, and
 * section 10.4 requires a pull-request run never to build a second artifact.
 *
 * ## The claim
 *
 * One sentence: with a real subject created through the app's own Welcome form on
 * a real device, a `.kdtemplate` import, a `.kdsubject` copy import, and a
 * `.kdbak` restore each survive a reload - every subject is still listed, still
 * loads, and a subject the restore deleted is still gone.
 *
 * ## What it does not prove
 *
 * Stated here and asserted by the wiring gate, because a lane that overstates
 * itself is worse than no lane. It is Chromium only, one viewport, the emulated
 * 1440x900 form factor, and a build with `VITE_STORAGE_REPOSITORY=v2` and
 * `VITE_DATA_PRODUCTS_V2=true` - neither of which is the default. It says nothing
 * about egress (the other three flagged lanes hold that), about a corrupt archive
 * (that is `tests/data`), about accessibility or performance, about a
 * two-tab/concurrent-writer case, or about the replacement of a single subject by
 * the `.kdsubject` product in its destructive mode.
 *
 * Privacy: nothing here contains learner data, request data, credentials, or a
 * private URL. Every value a fixture supplies is synthetic and self-describing,
 * and the only host it names is the reserved `example.invalid`, which is never
 * dereferenced.
 */

export const RELOAD_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const RELOAD_LANE_PROJECT = 'reload-persistence-chromium';

/** The only spec this lane may run. */
export const RELOAD_LANE_TEST_FILE = 'reloadPersistence.spec.ts';
export const RELOAD_LANE_TEST_PATH = `tests/e2e/${RELOAD_LANE_TEST_FILE}`;

/** The Playwright config that owns the lane. */
export const RELOAD_LANE_CONFIG_FILE = 'playwright.reload-persistence.config.ts';

/** The artifact this lane previews: the same one the other three flagged lanes use. */
export const RELOAD_LANE_BUILD_MODE = 'storage-v2';
export const RELOAD_LANE_ENV_FILE = '.env.storage-v2';
export const RELOAD_LANE_MANIFEST_PATH = 'artifacts/web-artifact-manifest-storage-v2.json';
export const RELOAD_LANE_SUPERSET_BUILD_SCRIPT = 'build:storage-v2-data-products';
export const RELOAD_LANE_OWNER_FLAG = 'VITE_DATA_PRODUCTS_V2';
export const RELOAD_LANE_OWNER_FLAG_ENABLED = true;

/** Its own port, so no two lanes can collide in one worktree. */
export const RELOAD_LANE_PREVIEW_PORT = 43183;
export const RELOAD_LANE_PREVIEW_SCRIPT = 'preview:e2e:reload-persistence';
export const RELOAD_LANE_PREVIEW_COMMAND = `npm run ${RELOAD_LANE_PREVIEW_SCRIPT}`;

export const RELOAD_LANE_SCRIPTS = {
  recorded: 'test:e2e:reload-persistence:recorded',
  full: 'test:e2e:reload-persistence:full',
} as const;

export const RELOAD_LANE_CI_JOB = 'storage-v2-browser';
export const RELOAD_LANE_CI_STEP_NAME = 'Run the reload-persistence lane';

export interface ReloadLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'storage-v2-reload-persistence';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildMode: string;
  readonly supersetBuildScript: string;
  readonly envFile: string;
  readonly manifestPath: string;
  /** The same flagged artifact the Phase 4, 5 and 6 lanes preview. */
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
  readonly ciLane: 'same-job-as-phase-4-5-6-flagged-builds';
  readonly acceptDownloads: true;
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  /** The controls the spec drives, in the product's own vocabulary. */
  readonly interactionContract: {
    readonly createLoadTabName: RegExp;
    readonly subjectNameFieldPlaceholder: RegExp;
    readonly rootTopicFieldPlaceholder: RegExp;
    readonly createSubjectControlName: RegExp;
    readonly setupChecklistName: RegExp;
    readonly listedSubjectName: RegExp;
    readonly dataCenterName: RegExp;
    readonly dataTabName: RegExp;
    readonly deviceTabName: RegExp;
    readonly subjectTabName: RegExp;
    readonly templateTabName: RegExp;
    readonly downloadDeviceBackupName: RegExp;
    readonly inspectBackupFileName: RegExp;
    readonly confirmRestoreName: RegExp;
    readonly subjectPickerLabel: RegExp;
    readonly templatePickerLabel: RegExp;
    readonly downloadSubjectBackupName: RegExp;
    readonly chooseSubjectBackupName: RegExp;
    readonly copyModeName: RegExp;
    readonly copyConfirmName: RegExp;
    readonly downloadTemplateName: RegExp;
    readonly chooseTemplateFileName: RegExp;
    readonly templateConfirmName: RegExp;
    readonly templateDestinationNameLabel: RegExp;
  };
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a cross-engine result; Firefox, WebKit, and Edge lanes do not run this spec.',
  'Not a comparison against the pre-cutover stack: this artifact and the Phase 23 production default both use storage-v2 and have the data products on.',
  'Not evidence that the legacy rollback still reloads; the Phase 23 rollback artifact is the evidence for that.',
  'Not a two-tab or concurrent-writer result.',
] as const;

export const RELOAD_LANE: ReloadLaneDeclaration = Object.freeze({
  schemaVersion: RELOAD_LANE_SCHEMA_VERSION,
  suite: 'storage-v2-reload-persistence',
  project: RELOAD_LANE_PROJECT,
  testFile: RELOAD_LANE_TEST_FILE,
  configFile: RELOAD_LANE_CONFIG_FILE,
  buildMode: RELOAD_LANE_BUILD_MODE,
  supersetBuildScript: RELOAD_LANE_SUPERSET_BUILD_SCRIPT,
  envFile: RELOAD_LANE_ENV_FILE,
  manifestPath: RELOAD_LANE_MANIFEST_PATH,
  sharesArtifactWith: 'phase-4-storage-v2-flagged-build',
  storageRepository: 'v2',
  worldRenderer: 'phaser',
  dataProductsV2: RELOAD_LANE_OWNER_FLAG_ENABLED,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  ciJob: RELOAD_LANE_CI_JOB,
  ciStepName: RELOAD_LANE_CI_STEP_NAME,
  ciLane: 'same-job-as-phase-4-5-6-flagged-builds',
  acceptDownloads: true,
  runnerLabels: ['ubuntu-latest'] as const,
  installTargets: ['chromium'] as const,
  interactionContract: {
    createLoadTabName: /create\s*\/\s*load/i,
    subjectNameFieldPlaceholder: /subject name/i,
    rootTopicFieldPlaceholder: /root topic/i,
    createSubjectControlName: /create new subject/i,
    setupChecklistName: /setup checklist/i,
    // The list renders the learner's own name, so this both finds a subject and
    // proves its snapshot loaded: a subject whose record is gone renders its
    // identifier here instead of a name, and one whose record is unreadable
    // renders zero rooms. Spaced words, not kebab-case, because it is matched
    // against the *rendered* name; and case-insensitive, so a rename of the
    // fixture's casing cannot silently make this match nothing.
    listedSubjectName: /reload lane synthetic/i,
    dataCenterName: /data\s*center/i,
    dataTabName: /^data$/i,
    deviceTabName: /full[\s-]*device|full[\s-]*backup/i,
    subjectTabName: /one subject|subject\s*backup/i,
    templateTabName: /reusable template|blank template/i,
    downloadDeviceBackupName: /download device backup/i,
    inspectBackupFileName: /inspect a backup file/i,
    confirmRestoreName: /replace device data with this backup/i,
    subjectPickerLabel: /subject to back up/i,
    templatePickerLabel: /subject to make a template from/i,
    downloadSubjectBackupName: /download this subject/i,
    chooseSubjectBackupName: /choose a subject backup file/i,
    copyModeName: /create a copy/i,
    copyConfirmName: /add a copy of this subject/i,
    downloadTemplateName: /download this template/i,
    chooseTemplateFileName: /choose a template file/i,
    templateConfirmName: /add the blank subject/i,
    // The import dialog's own field, so the imported subject is named by the
    // application under a name the lane knows and can therefore also find in the
    // rendered list. A template exported with no name imports under a default one,
    // which the lane would then have to hard-code.
    templateDestinationNameLabel: /name for the new subject/i,
  },
  claim:
    'On a real flagged-build device with a subject created through the application\'s own Welcome form, a ' +
    '.kdtemplate import, a .kdsubject copy import, and a .kdbak restore each survive a page reload: every ' +
    'subject is still listed by the application and still loads, the generation the device was using is still ' +
    'the one its pointer names, and a subject the restore deleted does not come back.',
  doesNotProve: [
    ...EMULATION_LIMITATIONS,
    'Not an egress result; the Phase 5, 6 and 7 lanes hold "no upload, no share, no non-static request", and repeating it here would be a second copy of one claim rather than new evidence.',
    'Not a corrupt-archive or hostile-input result; that matrix is tests/data, and this lane only offers each product an archive the product itself wrote.',
    'Not a .kdsubject replace-fidelity result; the lane drives the default copy mode, and the destructive mode is covered by tests/data against a real repository.',
    'Not evidence for the accessibility or performance gates; no axe scan and no timing measurement run here.',
    'Not a claim about the migration itself; the guard\'s decision table is pinned without a browser in tests/unit/legacyMigrationDeviceGuard.test.ts, and this lane is the browser leg of it.',
  ],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validateReloadLane(lane: ReloadLaneDeclaration = RELOAD_LANE): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (
    ['desktop-chromium', 'storage-v2-chromium', 'data-products-restore-chromium', 'subject-product-chromium'].includes(
      lane.project,
    )
  ) {
    problems.push('this lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (
    [
      'currentBuild.spec.ts',
      'compatibility.spec.ts',
      'storageV2.spec.ts',
      'dataProductsRestore.spec.ts',
      'subjectProductRoundTrip.spec.ts',
    ].includes(lane.testFile)
  ) {
    problems.push('this lane must not bind an existing suite spec file.');
  }
  if (lane.storageRepository !== 'v2') problems.push('the lane must record storageRepository v2.');
  if (lane.worldRenderer !== 'phaser') {
    problems.push('the flagged artifact is a post-cutover build, whose host is still the application host (phaser); the PixiJS worlds are per-world flags.');
  }
  if (lane.viewport.width !== 1440 || lane.viewport.height !== 900) {
    problems.push('the lane must use the desktop-chromium-equivalent viewport.');
  }
  if (lane.sharesArtifactWith !== 'phase-4-storage-v2-flagged-build') {
    problems.push('the lane must declare that it previews the shared flagged artifact.');
  }
  if (lane.acceptDownloads !== true) problems.push('a local-download lane must enable downloads.');
  if (lane.dataProductsV2 !== RELOAD_LANE_OWNER_FLAG_ENABLED) {
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
