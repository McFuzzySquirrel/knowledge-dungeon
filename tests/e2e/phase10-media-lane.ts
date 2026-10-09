/**
 * Phase 10 audio and asset lane declaration.
 *
 * The machine-readable source for the browser-backed half of Phase 10, imported by
 * this lane's Playwright config and checked against the real npm scripts, the real
 * Playwright project, and the preflight by `tests/e2e/phase10-media-lane.test.ts`.
 *
 * ## What this lane is for
 *
 * Phase 10's four exit criteria and four manual checks have browser evidence in
 * exactly one place before this file existed: nowhere. `tests/phase10/` proves
 * loader *policy* against a plain-object runtime, and `tests/unit/audioManager.test.ts`
 * proves the gesture gate against a fake `AudioContext` that cannot exist in a
 * browser. Neither can catch the defect this lane was written for: a procedural
 * fallback that assigned to `CanvasRenderingContext2D.prototype.canvas`, a
 * getter-only property, so `createFallbackTexture` threw a `TypeError` in every
 * real browser and jsdom's plain-object stub let it pass. See
 * `src/renderers/pixi/runtime/createPixiApplication.ts` and
 * `tests/phase10/browser-shape-parity.test.ts`.
 *
 * So the claims this lane makes are exactly the ones a fake cannot make:
 *
 * 1. **No `AudioContext` exists before a user gesture**, measured by counting
 *    constructions of the real platform constructor, and playback *does* begin
 *    after a real trusted click. The service is not stubbed: the lane imports the
 *    shipped module and drives its public surface.
 * 2. **Mute and both volumes survive route changes and a reload**, driven through
 *    the real Settings modal, the real store, and the real `localStorage` key.
 * 3. **No request leaves the preview origin**, including fonts, audio, and asset
 *    bundles.
 * 4. **A forced-missing bundle asset does not break the route**, with the request
 *    asserted to have been *attempted* first, because a route that renders because
 *    nothing was ever requested proves nothing.
 *
 * ## Which build, and why the production one
 *
 * Unlike the two Phase 9 Pixi lanes, this lane previews the **production** build
 * (`npm run build:web`, recorded by `npm run record:web-artifact`) rather than a
 * `VITE_WORLD_RENDERER=pixi` one, for three reasons: the audio service is
 * renderer-neutral and present in both; the asset runtime is imported by the
 * module under test rather than by a route, so the flag does not gate it; and the
 * privacy and settings claims are stronger against the artifact that actually
 * ships. The consequence is stated in `doesNotProve`: this is not evidence about
 * the flagged build.
 *
 * ## Hermeticity
 *
 * The config module is importable and side-effect free, so
 * `tests/e2e/phase10-media-lane.test.ts` can assert its shape in a checkout with no
 * `dist/`, exactly as `scripts/require-pixi-lane-artifact.mjs` records for the Pixi
 * lanes. The preflight that refuses a missing artifact is a command, not a
 * module-scope throw.
 *
 * Privacy: synthetic tutorial fixtures only. No learner data, no request bodies,
 * no query strings, no external host. Every request to a non-preview origin is
 * blocked before the application runs, and the recorded observations carry
 * origin and path only.
 */

export const PHASE10_MEDIA_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const PHASE10_MEDIA_PROJECT = 'phase10-media-chromium';

/** The only spec this lane may run. */
export const PHASE10_MEDIA_TEST_FILE = 'phase10Media.spec.ts';
export const PHASE10_MEDIA_TEST_PATH = `tests/phase10/browser/${PHASE10_MEDIA_TEST_FILE}`;
export const PHASE10_MEDIA_TEST_DIR = 'tests/phase10/browser';

/**
 * The config that owns the lane.
 *
 * It lives under `tests/e2e/` for the reason `playwright.pixi-pointer.config.ts`
 * records: the five older configs sit at the repository root and are enumerated in
 * `tsconfig.node.json`, so a sixth root config would be inside no TypeScript
 * project and `npm run lint` would fail to parse it. Inside `tests/e2e/**` the file
 * is covered by `tsconfig.app.json`'s `include: ["src", "tests"]`.
 */
export const PHASE10_MEDIA_CONFIG_FILE = 'tests/e2e/playwright.phase10-media.config.ts';
export const PHASE10_MEDIA_CONFIG_BASENAME = 'playwright.phase10-media.config.ts';

/** The build script, and the recorded identity this lane previews. */
export const PHASE10_MEDIA_BUILD_SCRIPT = 'build:web';
export const PHASE10_MEDIA_MANIFEST_PATH = 'artifacts/web-artifact-manifest.json';
export const PHASE10_MEDIA_RECORD_SCRIPT = 'record:web-artifact';
export const PHASE10_MEDIA_VERIFY_SCRIPT = 'verify:web-artifact';
export const PHASE10_MEDIA_RECORD_COMMAND = `npm run ${PHASE10_MEDIA_RECORD_SCRIPT}`;
export const PHASE10_MEDIA_VERIFY_COMMAND = `npm run ${PHASE10_MEDIA_VERIFY_SCRIPT}`;

/**
 * The Playwright invocation, spelled once.
 *
 * `package.json` is the one place a Playwright command is written, and the plain,
 * `:full`, and `:recorded` scripts all use this same string, so the config this
 * lane owns and the config Playwright actually loads cannot be different files.
 */
export const PHASE10_MEDIA_PLAYWRIGHT_COMMAND = `playwright test --config=${PHASE10_MEDIA_CONFIG_FILE}`;

/** Its own port, so it cannot contend with any other lane's preview server. */
export const PHASE10_MEDIA_PREVIEW_PORT = 43191;
export const PHASE10_MEDIA_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${PHASE10_MEDIA_PREVIEW_PORT} --strictPort`;

/**
 * A second server, on its own port, running the same checkout unbundled.
 *
 * ## Why the lane needs one
 *
 * Two of the four manual checks cannot be answered from a preview of `dist` alone.
 * The built artifact does not export its modules, so nothing in a previewed page
 * can call `audioManager.playBgm`, and nothing can construct the PixiJS asset
 * runtime. Without a request there is no gate to fire and no bundle to fail, and
 * both of those absences would make the corresponding assertion pass for the wrong
 * reason — which is the exact failure mode this lane exists to prevent.
 *
 * So the lane measures two things and labels which is which:
 *
 * - **Against the recorded production preview:** the four checks that are about
 *   what a learner and the shipped bundle do. The gesture check's *negative* half
 *   (no context before a gesture, driven through the real Settings panel), the
 *   persistence check, the no-remote-request check, and the accessibility scan.
 * - **Against a dev server on the same checkout:** the two checks that need to
 *   *call* the shipped module. The gesture check's *positive* half (playback
 *   begins after a real gesture) and the forced-missing-asset check.
 *
 * The second surface is the same source the artifact is built from, unbundled and
 * unminified, in the same browser. It is **not** the emitted chunk, and the report
 * says so rather than rounding it up to "the shipped build".
 */
export const PHASE10_MEDIA_DEV_PORT = 43193;
export const PHASE10_MEDIA_DEV_SCRIPT = `npx vite --host 127.0.0.1 --port ${PHASE10_MEDIA_DEV_PORT} --strictPort`;
export const PHASE10_MEDIA_DEV_ORIGIN = `http://127.0.0.1:${PHASE10_MEDIA_DEV_PORT}`;
export const PHASE10_MEDIA_PREVIEW_ORIGIN = `http://127.0.0.1:${PHASE10_MEDIA_PREVIEW_PORT}`;
/**
 * The preflight, run before Playwright starts.
 *
 * It is a command rather than a guard at the top of the config for the reason
 * `scripts/require-pixi-lane-artifact.mjs` records at length: a module-scope
 * `throw` made the *wiring gate* fatal in any checkout without a built artifact,
 * including the `unit-tests` CI job, which has none and never should. So the check
 * lives in the command, the config stays importable, and a missing artifact is a
 * one-line diagnosis instead of a 180-second webServer timeout.
 */
export const PHASE10_MEDIA_PREFLIGHT_SCRIPT = 'require-phase10-lane-artifact.mjs';
export const PHASE10_MEDIA_PREFLIGHT_COMMAND = `node scripts/${PHASE10_MEDIA_PREFLIGHT_SCRIPT}`;

/**
 * The npm scripts.
 *
 * The repository's own split: `test:e2e:phase10-media` previews an artifact that
 * already exists, `:full` builds and records it first, and `:recorded` is the same
 * preview-only script under the name that says the artifact was recorded by
 * something else. CI runs `:recorded`, so the job that ran the production Phase 1
 * suite cannot silently rebuild what it just measured.
 */
export const PHASE10_MEDIA_LANE_SCRIPT = 'test:e2e:phase10-media';
export const PHASE10_MEDIA_LANE_FULL_SCRIPT = 'test:e2e:phase10-media:full';
export const PHASE10_MEDIA_CI_RUN_SCRIPT = 'test:e2e:phase10-media:recorded';
export const PHASE10_MEDIA_CI_RUN_COMMAND = `npm run ${PHASE10_MEDIA_CI_RUN_SCRIPT}`;

/** The job that previews and measures the artifact. It already has Chromium. */
export const PHASE10_MEDIA_CI_JOB = 'browser-smoke';
export const PHASE10_MEDIA_CI_STEP_NAME = 'Run the Phase 10 audio and asset lane';

/**
 * The viewports the audio settings panel is measured at.
 *
 * The four `emulated-viewport` projects the support matrix already names, by
 * project name, so the lane cannot quietly measure a viewport the matrix does not
 * document. The matrix entry is the authority; these are the ids it uses.
 */
export const PHASE10_MEDIA_A11Y_PROJECTS = Object.freeze([
  'desktop-chromium',
  'chromebook',
  'tablet',
  'tablet-landscape',
] as const);

/** The plan's minimum touch target, in CSS pixels. */
export const PHASE10_MEDIA_MINIMUM_TOUCH_TARGET_PX = 44;

/**
 * A known, pre-existing serious violation that is not the audio panel's.
 *
 * `.hud-stat-subtle` is a Phase 1 contrast exception on the game HUD. It is
 * recorded here so the lane can assert "no *new* serious or critical violation"
 * with a name attached rather than a blanket allowance, and the wiring gate
 * asserts this list is non-empty, because a lane that tolerates everything proves
 * nothing. The maintainer owns the plan text; this file does not decide whether
 * the exception should still exist.
 */
export const PHASE10_MEDIA_KNOWN_BLOCKING_SIGNATURES = Object.freeze([
  'color-contrast|serious|.hud-stat-subtle',
] as const);

export interface Phase10MediaLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-10-audio-and-assets';
  readonly project: string;
  readonly testFile: string;
  readonly testPath: string;
  readonly testDir: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly manifestPath: string;
  readonly worldRenderer: 'phaser';
  readonly storageRepository: 'v2';
  readonly dataProductsV2: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: 'pointer-keyboard';
  readonly evidenceClass: 'emulated-viewport';
  readonly previewPort: number;
  readonly devPort: number;
  readonly previewOrigin: string;
  readonly devOrigin: string;
  readonly a11yProjects: readonly string[];
  readonly minimumTouchTargetPx: number;
  readonly knownBlockingSignatures: readonly string[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const MEASUREMENT_LIMITATIONS = [
  'Not a claim that any shipping route plays a sound: Phase 10 wires no route to the audio service, and the only production playSfx call site is a Phaser scene. The gesture check therefore has two halves measured on two surfaces, and the report says which is which.',
  'Not a claim about the VITE_WORLD_RENDERER=pixi build: the production half of this lane previews the production artifact, so it is not interchangeable with the two Pixi lanes.',
  'Not a claim about the emitted chunk: the checks that must *call* the shipped module run against the same checkout served unbundled by Vite, because the built artifact does not export its modules. That is the shipped source in the same browser, and it is not the minified bundle.',
  'Not a live-AudioContext count and not audio device memory: the lane counts constructions of the real platform constructor and reads the real context state, and no API reports audio device bytes.',
  'Not a hardware-audio result: this machine has no sound device, so the lane asserts that voices were scheduled and that the context reached running, never that a sample reached a speaker.',
  'Not a screen-reader result: no assistive technology is installed here, so the lane asserts the semantics one reads (role, name, state, value, description) and nothing about what any of them announces.',
  'Not a macOS Safari, iPad, Android, Chromebook, or physical-device result of any kind; the four accessibility viewports are Chromium emulations.',
  'Not an audio-quality result: the recipes are asserted to schedule the nodes they declare, not to sound like anything.',
] as const;

const ASSET_LIMITATIONS = [
  'Not a world-mount result: no Phase 10 route mounts a Pixi world, so the lane drives the real asset loader and the real PixiJS asset runtime directly rather than through a scene. The world-mount half of this criterion is the Phase 9 memory lane.',
  'Not a bundle-size result: this lane measures nothing about emitted bytes, and check:bundle-size remains the gate for that.',
  'Not a licence result: the lane records that a forced-missing file is handled, and npm run test:licenses remains the authority on whether a file is admissible.',
] as const;

export const PHASE10_MEDIA_LANE: Phase10MediaLaneDeclaration = Object.freeze({
  schemaVersion: PHASE10_MEDIA_LANE_SCHEMA_VERSION,
  suite: 'phase-10-audio-and-assets',
  project: PHASE10_MEDIA_PROJECT,
  testFile: PHASE10_MEDIA_TEST_FILE,
  testPath: PHASE10_MEDIA_TEST_PATH,
  testDir: PHASE10_MEDIA_TEST_DIR,
  configFile: PHASE10_MEDIA_CONFIG_FILE,
  buildScript: PHASE10_MEDIA_BUILD_SCRIPT,
  manifestPath: PHASE10_MEDIA_MANIFEST_PATH,
  worldRenderer: 'phaser',
  storageRepository: 'v2',
  dataProductsV2: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  previewPort: PHASE10_MEDIA_PREVIEW_PORT,
  devPort: PHASE10_MEDIA_DEV_PORT,
  previewOrigin: PHASE10_MEDIA_PREVIEW_ORIGIN,
  devOrigin: PHASE10_MEDIA_DEV_ORIGIN,
  a11yProjects: PHASE10_MEDIA_A11Y_PROJECTS,
  minimumTouchTargetPx: PHASE10_MEDIA_MINIMUM_TOUCH_TARGET_PX,
  knownBlockingSignatures: PHASE10_MEDIA_KNOWN_BLOCKING_SIGNATURES,
  claim:
    'In real Chromium, against the recorded production web artifact: opening the Settings Audio tab, moving both ' +
    'volume sliders, toggling mute and both bus switches, walking two routes, and reloading the page constructs ' +
    'no AudioContext at all; mute, music volume, and SFX volume read back unchanged after two route changes and ' +
    'after a reload; every request the journey makes is same-origin, with no font and no media request; and the ' +
    'Audio settings panel adds no new serious or critical automated accessibility violation and meets the plan\'s ' +
    '44 CSS-pixel minimum touch target at all four documented emulated viewports. Against the same checkout served ' +
    'unbundled, and against the real shipped audio service and the real PixiJS asset runtime: a real trusted click ' +
    'does construct a context, resume it to running, and start the scheduled voices, and a bundle asset whose ' +
    'request is forced to fail is recorded as attempted, falls back to a procedurally drawn texture of the recipe ' +
    'size, and leaves the route rendered with no unhandled error.',
  doesNotProve: [...MEASUREMENT_LIMITATIONS, ...ASSET_LIMITATIONS],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validatePhase10MediaLane(
  lane: Phase10MediaLaneDeclaration = PHASE10_MEDIA_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (
    [
      'pixi-world-memory-chromium',
      'pixi-pointer-chromium',
      'storage-v2-chromium',
      'data-products-restore-chromium',
      'subject-product-chromium',
      'reload-persistence-chromium',
    ].includes(lane.project)
  ) {
    problems.push('the phase 10 media lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (
    [
      'currentBuild.spec.ts',
      'compatibility.spec.ts',
      'storageV2.spec.ts',
      'dataProductsRestore.spec.ts',
      'subjectProductRoundTrip.spec.ts',
      'reloadPersistence.spec.ts',
      'pixiMemory.spec.ts',
      'pixi-canvas-pointer.spec.ts',
    ].includes(lane.testFile)
  ) {
    problems.push('the phase 10 media lane must not bind an existing suite spec file.');
  }
  if (lane.worldRenderer !== 'phaser') {
    problems.push(
      'this lane previews the post-cutover production artifact, whose host is the application host (phaser); the PixiJS worlds are per-world flags.',
    );
  }
  if (lane.storageRepository !== 'v2') {
    problems.push('this lane previews the post-cutover production artifact, whose storage repository is v2.');
  }
  if (lane.dataProductsV2 !== true) {
    problems.push('this lane previews the post-cutover production artifact, so the data-products flag is on.');
  }
  if (lane.viewport.width !== 1440 || lane.viewport.height !== 900) {
    problems.push('the lane must use the desktop-chromium-equivalent viewport.');
  }
  if (lane.previewPort === lane.devPort) {
    problems.push('the preview and the dev server must not contend for one port.');
  }
  if (lane.previewOrigin === lane.devOrigin) {
    problems.push('the preview and the dev server must be distinguishable origins.');
  }
  if (lane.a11yProjects.length !== 4) {
    problems.push('the audio settings panel must be measured at the four documented emulated viewports.');
  }
  if (lane.minimumTouchTargetPx !== 44) {
    problems.push('the lane must use the plan minimum touch target of 44 CSS pixels.');
  }
  if (lane.knownBlockingSignatures.length === 0) {
    problems.push('a lane that tolerates no known exception must prove it; one that tolerates everything proves nothing.');
  }
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 8) problems.push('the lane must declare a does-not-prove list.');
  for (const limitation of lane.doesNotProve) {
    if (limitation.trim().length < 20) problems.push('a does-not-prove entry is too short to be a boundary.');
  }
  return problems;
}
