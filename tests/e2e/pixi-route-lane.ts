/**
 * Phase 22 route-change renderer teardown lane declaration.
 *
 * ## The gap this lane fills
 *
 * Plan section 10.2 asks for "correct Pixi Application and asset-bundle teardown"
 * and Phase 22's scope restates it as "Application and asset teardown across ROUTE
 * CHANGES". The Phase 9 memory lane already proves twenty mount/unmount cycles retain
 * no canvas, context, or application - but it drives those cycles with a
 * `prefers-reduced-motion` flip inside a single route, so every sample is the *same*
 * screen's host being torn down and rebuilt. A learner who walks from the dungeon to
 * the village, or from the village into the fishing pond, exercises a different edge:
 * React unmounts one screen's host and mounts another screen's. That edge is where a
 * canvas, a WebGL context, or an `Application` can outlive the route it belonged to,
 * and nothing in the twenty-cycle verdict can fail on it.
 *
 * ## Why two flags and not three, and what the Phase 22 chunking fix changed
 *
 * This lane's artifact is `VITE_PIXI_DUNGEON=true VITE_PIXI_FISHING=true`: the two
 * Pixi worlds whose teardown is a route change (the dungeon, a screen route) and an
 * overlay unmount (the pond), with the Phaser village as the route between them.
 *
 * Until the Phase 22 chunking fix, a build with **two** lazy renderer boundaries - for
 * example `VITE_PIXI_VILLAGE=true` together with `VITE_PIXI_DUNGEON=true` - emitted
 * Vite's dynamic-import preload helper into the `vendor-pixi` chunk, so the entry
 * document statically reached the Pixi runtime and the renderer-chunk-boundary gate
 * failed the build. That defect is fixed: `vendor-vite-helpers` now captures the
 * helper, and the `VILLAGE+DUNGEON` and all-three builds pass both the gate and
 * `npm run check:memory`.
 *
 * This lane is nevertheless still declared on the DUNGEON+FISHING artifact, and that
 * is now a measured choice rather than the old constraint. The Pixi village world's
 * own teardown is not exercised by the walk below, because this flow has no in-app
 * route *away* from the village: the dungeon's "Return to subject selection" control
 * leads *to* it and the pond is an overlay that leaves it mounted. Covering the
 * village teardown needs a new artifact and a new navigation step, so it is recorded
 * in `doesNotProve` rather than folded into this lane.
 *
 * ## What it does not prove
 *
 * The `doesNotProve` list is asserted by the lane's wiring test. The three that
 * matter most: it is not the Pixi village world (blocked by the chunking defect
 * above), it is not a GPU-memory figure, and it is Chromium in a software rasteriser
 * - so it is a release-side reading, not a hardware measurement.
 */

export const PIXI_ROUTE_SCHEMA_VERSION = 1;

export const PIXI_ROUTE_PROJECT = 'pixi-world-route-chromium';
export const PIXI_ROUTE_TEST_FILE = 'pixiRoute.spec.ts';
export const PIXI_ROUTE_TEST_PATH = `tests/e2e/${PIXI_ROUTE_TEST_FILE}`;
export const PIXI_ROUTE_CONFIG_FILE = 'tests/e2e/playwright.pixi-route.config.ts';

export const PIXI_ROUTE_BUILD_SCRIPT = 'build:web:pixi-route';
export const PIXI_ROUTE_RECORD_SCRIPT = 'record:web-artifact:pixi-route';
export const PIXI_ROUTE_VERIFY_SCRIPT = 'verify:web-artifact:pixi-route';
export const PIXI_ROUTE_MANIFEST_PATH = 'artifacts/web-artifact-manifest-pixi-route.json';

export const PIXI_ROUTE_PREVIEW_PORT = 43195;
export const PIXI_ROUTE_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${PIXI_ROUTE_PREVIEW_PORT} --strictPort`;

export const PIXI_ROUTE_LANE_SCRIPT = 'test:e2e:pixi-route';
export const PIXI_ROUTE_LANE_FULL_SCRIPT = `${PIXI_ROUTE_LANE_SCRIPT}:full`;
export const PIXI_ROUTE_LANE_RECORDED_SCRIPT = `${PIXI_ROUTE_LANE_SCRIPT}:recorded`;

export const PIXI_ROUTE_PLAYWRIGHT_COMMAND = `playwright test --config=${PIXI_ROUTE_CONFIG_FILE}`;

/** The two world switches this artifact is built with. */
export const PIXI_ROUTE_FLAGS = Object.freeze({
  dungeon: 'VITE_PIXI_DUNGEON',
  fishing: 'VITE_PIXI_FISHING',
});

/**
 * The CI wiring this artifact owns.
 *
 * The upload lives in `web-build` and the download lives in `browser-smoke`, where the
 * single Chromium install already exists. The artifact is moved through the shared
 * transfer declaration in `tests/e2e/artifact-transfer-wiring.ts`, not a count.
 *
 * Its own artifact is genuinely required rather than a convenience: no existing flagged
 * build carries both Pixi worlds, and `tests/phase13/dungeon-flag-boundary.test.ts`
 * pins `build:web:pixi-dungeon` to "the dungeon flag and nothing else", so the lake
 * cannot be folded into the dungeon artifact without weakening that gate.
 */
export const PIXI_ROUTE_CI_JOB = 'browser-smoke';
export const PIXI_ROUTE_CI_BUILD_JOB = 'web-build';
export const PIXI_ROUTE_CI_UPLOAD_ARTIFACT = 'pixi-route-web-artifact';
export const PIXI_ROUTE_CI_BUILD_STEP = 'Build the Phase 22 Pixi-route-flagged artifact';
export const PIXI_ROUTE_CI_UPLOAD_STEP = 'Upload the Pixi-route-flagged web artifact';
export const PIXI_ROUTE_CI_DISCARD_STEP =
  'Discard the Pixi-dungeon dist before the Pixi-route download';
export const PIXI_ROUTE_CI_DOWNLOAD_STEP = 'Download the Pixi-route-flagged artifact';
export const PIXI_ROUTE_CI_VERIFY_STEP = 'Verify the Pixi-route-flagged artifact identity';
export const PIXI_ROUTE_CI_RUN_STEP = 'Run the Phase 22 Pixi route-teardown lane';
export const PIXI_ROUTE_CI_RUN_SCRIPT = PIXI_ROUTE_LANE_RECORDED_SCRIPT;
export const PIXI_ROUTE_CI_RUN_COMMAND = `npm run ${PIXI_ROUTE_CI_RUN_SCRIPT}`;

export interface PixiRouteLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-22-pixi-route-teardown';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly manifestPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly worldRenderer: 'phaser';
  readonly flags: readonly string[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

export const PIXI_ROUTE_LANE: PixiRouteLaneDeclaration = Object.freeze({
  schemaVersion: PIXI_ROUTE_SCHEMA_VERSION,
  suite: 'phase-22-pixi-route-teardown',
  project: PIXI_ROUTE_PROJECT,
  testFile: PIXI_ROUTE_TEST_FILE,
  configFile: PIXI_ROUTE_CONFIG_FILE,
  buildScript: PIXI_ROUTE_BUILD_SCRIPT,
  manifestPath: PIXI_ROUTE_MANIFEST_PATH,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  worldRenderer: 'phaser',
  flags: [PIXI_ROUTE_FLAGS.dungeon, PIXI_ROUTE_FLAGS.fishing],
  claim:
    'Against a build with VITE_PIXI_DUNGEON=true and VITE_PIXI_FISHING=true, a real route change from the ' +
    'PixiJS dungeon to the village detaches the dungeon canvas and loses its WebGL context, and opening and ' +
    'closing the PixiJS fishing pond detaches the pond canvas and loses its WebGL context - with exactly one ' +
    'PixiJS Application retained for every Pixi world currently on the page.',
  doesNotProve: [
    'Not the PixiJS village world teardown: this lane runs on the VITE_PIXI_DUNGEON=true VITE_PIXI_FISHING=true artifact with the Phaser village as the route between the two Pixi worlds. Building VITE_PIXI_VILLAGE=true together with VITE_PIXI_DUNGEON=true is now possible after the Phase 22 chunking fix, but this flow has no in-app route away from the village, so the Pixi village\'s own teardown is not exercised here.',
    'Not a live-WebGL-context count and not a GPU memory figure: no API in a headless browser reports either. What is asserted is the release-side equivalent - the left world canvas is detached and its context is lost.',
    'Not a hardware-GPU result: the WebGL2 context is real and the evidence records the unmasked renderer string, which in a headless Linux container is a software rasteriser.',
    'Not a cross-engine result: Chromium only, matching the memory lane.',
    'Not a frame-time result: the route walk is a teardown measurement, not a performance measurement.',
  ],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validatePixiRouteLane(
  lane: PixiRouteLaneDeclaration = PIXI_ROUTE_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (lane.flags.length !== 2) problems.push('the lane must name exactly its two world switches.');
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 4) problems.push('the lane must declare a does-not-prove list.');
  for (const limitation of lane.doesNotProve) {
    if (limitation.trim().length < 20) problems.push('a does-not-prove entry is too short to be a boundary.');
  }
  return problems;
}
