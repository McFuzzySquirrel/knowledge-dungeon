/**
 * Shared machinery for the two Phase 17 fishing lanes.
 *
 * ## What lives here and why
 *
 * Both lanes have to do the same three things before they can assert anything: prove the
 * artifact under test is the one that was recorded, get a learner from Welcome to a fishing
 * pond, and record what the run actually observed. Written once, because three of the four
 * claims in Phase 17's exit criteria are about the *entry point* rather than about the pond,
 * and a second copy of a walk is a second thing to keep correct.
 *
 * The parts that are pure — the chunk census, the walk schedule, the evidence record — are
 * plain functions with no Playwright import, and `tests/e2e/fishing-lane.test.ts` exercises
 * them with synthetic values. The parts that drive a page take a `Page` and nothing else.
 *
 * ## Why reaching a pond needs a walk at all
 *
 * There is no supported way to place the player. `Welcome`'s "Continue to Village"
 * deliberately clears the one-shot `kd-village-spawn` override, which is correct product
 * behaviour and not something a test should route around, and the fishing entry point is a
 * *village structure* — so the pond is reached the way a learner reaches it, on foot.
 *
 * `VILLAGE_MAP.playerStart` is grid `(5, 27)` and the nearest pond, `pond-fish-sw`, is grid
 * `(10, 23)` two tiles by two, so its centre is grid `(11, 24)`: six tiles east and three
 * tiles north. `fish-stand` is grid `(19, 0)` three by two, so its centre is `(20.5, 1)`.
 *
 * ## How the walk aims: from where the village says the learner is
 *
 * The village **publishes the learner's own tile**, as `data-village-player="<gridX>,<gridY>"`
 * on the village screen's root, refreshed on a 100 ms interval. So the walk does not have to
 * assume where it started: it reads the published tile before every burst, presses the key that
 * closes the larger remaining distance from *that* tile, and reads again. It is a re-aiming walk,
 * not a schedule, and it corrects by construction — there is no heading to reverse, because the
 * heading is recomputed from the learner rather than assumed from the map.
 *
 * Two properties of the published value shape the loop:
 *
 * - **A value read may be up to one interval stale.** 100 ms at `PLAYER_SPEED` 120 px/s is
 *   12 px, a quarter of a 48 px tile, so a reading means "somewhere within a quarter tile of
 *   here". That is why the aim is computed per burst and re-derived from the next reading, and
 *   why nothing in the loop treats a tile as exact.
 * - **Absence is "cannot navigate yet", never `0,0`.** The attribute is absent before a
 *   renderer mounts, and absent on an adapter that does not implement the read. A walk that
 *   substituted a default tile would silently aim at tile `(0, 0)` and walk the learner off the
 *   north-west corner of the map, so {@link waitForPlayerGrid} waits for it and
 *   {@link walkToStructureAndPress} fails on its absence instead.
 *
 * **The numbers are not retyped, and they are also not retyped *only* here.** They appear in
 * this module as literals because a Playwright worker does not resolve the `@/` alias, and
 * `tests/e2e/fishing-lane.test.ts` asserts every one of them against `src/data/villageLayout.ts`
 * — the product's own table — so a retuned speed or a moved structure fails `npm test` rather
 * than a lane four minutes later. The lane's gate also asserts this module's reader against
 * `src/ui/village/villagePlayerPosition.ts`, so a renamed attribute cannot leave the walk
 * reading something that is always absent.
 *
 * ## Why a walk has to leave the pond before it can cross the village
 *
 * Because the pond owns the arrow keys while it is open, and that is correct product behaviour
 * rather than something to fix: the angler has to be able to walk. See {@link returnToVillage},
 * the step every test that walks *after* a cast performs, which uses the pond's own control
 * instead of a synthetic key.
 *
 * ## Two ways a passing assertion in this lane could not fail
 *
 * Recorded here because two different agents hit the same class of defect in one phase, and
 * because the shape is invisible in a green run.
 *
 * 1. **`expect(NaN).toBe(NaN)` passes.** `toBe` is `Object.is`, so a value that failed to parse
 *    compares equal to itself and every before/after comparison built on it is a tautology.
 *    `data-fish-stat="species"` publishes `"{caught} of {total}"`, and a reader that took
 *    `Number(...)` of the whole string produced `NaN` — on **both** sides of a release test.
 *    The fix is not to compare differently but to **refuse the unparsed value**: the readers
 *    now throw on a shape they did not expect, so a changed format is a loud failure.
 * 2. **A predicate that is never consulted.** A walk control can be computed every iteration
 *    and wired to nothing, and every assertion that re-implements its arithmetic still passes.
 *    The gate below therefore asserts the *wiring* — the key the loop derives is the key it
 *    presses — rather than only the arithmetic, and every arithmetic simulation here is paired
 *    with an assertion that the loop really contains the branch that feeds it.
 *
 * ## Privacy
 *
 * Synthetic fixtures only. The only identifiers this module names are structure ids the
 * authored village map already publishes (`pond-fish-sw`, `fish-stand`), a `data-*` attribute
 * name, and the app's own static control ids. A tile index into an authored map is not personal
 * data — two learners on one tile publish the identical pair. Nothing here reads or writes a
 * storage key, and no request body, header, query, fragment, or non-loopback URL is recorded
 * anywhere. The one module that does seed storage is `tests/e2e/fishing-recall-fixture.ts`, and
 * its seed is synthetic by construction.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Page, Request, TestInfo, WebSocket } from '@playwright/test';

/**
 * What the privacy spy hands back.
 *
 * Declared before the factory so the interface and the implementation cannot drift, which is a
 * failure mode a type-checker catches and a comment does not.
 */
export interface NetworkSpy {
  readonly report: () => ReturnType<typeof import('./compat-evidence').buildNetworkPolicyReport>;
  readonly assertions: () => string;
  readonly pixiScriptPaths: () => readonly string[];
  readonly fishingScriptPaths: () => readonly string[];
  readonly pageErrors: () => readonly string[];
}

import {
  buildNetworkPolicyReport,
  classifyRequestLike,
  classifyWebSocketLike,
  describeNetworkFailures,
  evidenceRelativePath,
  normalizeHost,
  sanitizeToolchainText,
} from './compat-evidence';
import {
  FISHING_CHUNK_PREFIX,
  type FishingInputMode,
  type FishingRendererMode,
} from './fishing-lane';

/* ── The artifact, read from `dist/` rather than from a flag ────────────────── */

/**
 * The repository root, as the lane's Playwright config captured it.
 *
 * `process.cwd()` alone is not enough, because a Playwright spec runs in a worker whose working
 * directory is not guaranteed to be the directory its config was loaded from - which is exactly
 * why every one of these configs states `webServer.cwd` explicitly. Reading `dist/` from the
 * wrong directory would report an empty census and fail a lane whose artifact is perfectly good,
 * so the value is exported by the config and resolved here. `process.cwd()` remains the fallback
 * for a unit test that imports this module with no config in play, and the lane's own gate
 * asserts the export exists in both configs.
 */
export function repoRoot(): string {
  return process.env['KD_FISHING_REPO_ROOT'] ?? process.cwd();
}

export interface DistChunkCensus {
  /** Every emitted chunk file name under `dist/assets`, sorted. */
  readonly chunks: readonly string[];
  /**
   * The ES5 `nomodule` re-emissions, listed rather than dropped.
   *
   * They are excluded from the three family lists below, and that is a decision rather than an
   * oversight: `@vitejs/plugin-legacy` re-emits every modern chunk once more with a `-legacy-`
   * marker, so a build with one Phaser dependency ships two Phaser files and a census counting
   * both would report "2" for one. The claim the rollback lane makes is about the *module*
   * bundle, which is the release path; the ES5 fallback is listed here so nothing is hidden.
   */
  readonly legacyChunks: readonly string[];
  /** The Pixi fishing world chunk, if this build emitted one. */
  readonly fishingChunks: readonly string[];
  /** Every `vendor-pixi-*` chunk. */
  readonly pixiChunks: readonly string[];
  /** Every `vendor-phaser-*` chunk. */
  readonly phaserChunks: readonly string[];
}

const PIXI_CHUNK_PATTERN = /^vendor-pixi-/;
const PHASER_CHUNK_PATTERN = /^vendor-phaser-/;

/**
 * The ES5 re-emission marker, anchored on the literal segment immediately before the extension
 * rather than on a content hash - the same pattern `vite.config.ts`'s `isLegacyEmission` uses, so
 * the two agree by construction and a rename in one is a rename in both.
 */
const LEGACY_EMISSION_PATTERN = /-legacy-[^/]*\.[a-z0-9]+$/i;

/**
 * The chunk names an emitted `dist/assets` directory contains, classified.
 *
 * **Pure**, so it takes the names rather than reading the directory itself and the wiring gate
 * can exercise every branch against a synthetic list. The spec's `censusForDist()` is the only
 * caller that touches the filesystem.
 *
 * This is the whole reason the lane classifies its artifact from `dist/` instead of from an
 * environment variable: "the rollback target contains no Pixi fishing chunk" is a claim about
 * the bytes that will be served, and reading the flag back out of the code under test would make
 * the lane assert the flag rather than the product.
 */
export function classifyChunkNames(names: readonly string[]): DistChunkCensus {
  const chunks = [...names].sort();
  const legacyChunks = chunks.filter((name) => LEGACY_EMISSION_PATTERN.test(name));
  const modern = chunks.filter((name) => !LEGACY_EMISSION_PATTERN.test(name));
  return {
    chunks,
    legacyChunks,
    fishingChunks: modern.filter((name) => name.startsWith(FISHING_CHUNK_PREFIX)),
    pixiChunks: modern.filter((name) => PIXI_CHUNK_PATTERN.test(name)),
    phaserChunks: modern.filter((name) => PHASER_CHUNK_PATTERN.test(name)),
  };
}

/**
 * Read `<repoRoot>/dist/assets` and classify it. Returns `null` when there is no build to read.
 *
 * Takes the **repository root**, not the `dist` directory, so a caller cannot pass one when the
 * other was meant — which is exactly the mistake this signature exists to make impossible, and
 * which its own lane hit once before this comment was written.
 */
export function censusForDist(root: string): DistChunkCensus | null {
  const assetsDir = path.join(root, 'dist', 'assets');
  if (!existsSync(assetsDir)) return null;
  return classifyChunkNames(
    readdirSync(assetsDir).filter((name) => name.endsWith('.js')),
  );
}

/* ── The recorded identity, verified before anything is measured ───────────── */

export interface RecordedArtifactVerification {
  readonly status: string;
  readonly code: string;
  readonly recordedTreeSha256: string | null;
  readonly recordedFileCount: number | null;
  readonly sourceMatches: boolean | null;
}

/**
 * Run `scripts/web-artifact-manifest.mjs verify` against one recorded identity.
 *
 * A **failure, not a skip**, and that is the stance `scripts/check-welcome-budget.mjs` takes and
 * this lane takes with it: a gate that reports success because it measured nothing is the
 * failure it exists to prevent. A missing or stale manifest is therefore an exception whose
 * message names the script that records one.
 *
 * The child process is spawned with `stdio: ['ignore', 'pipe', 'pipe']` and only its **exit
 * code and its own bounded JSON** are read. Nothing else the process wrote is forwarded, so a
 * diagnostic cannot carry a path or a value from the host into a report.
 */
export function verifyRecordedArtifact(
  repoRoot: string,
  manifestRelativePath: string,
): RecordedArtifactVerification {
  let raw: string;
  let ok = false;
  try {
    raw = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'web-artifact-manifest.mjs'),
        'verify',
        `--manifest=${manifestRelativePath}`,
        '--json',
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 },
    );
    ok = true;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    raw = stdout;
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!ok || parsed === null || parsed['status'] !== 'match') {
    const code = typeof parsed?.['code'] === 'string' ? (parsed['code'] as string) : 'unreadable';
    throw new Error(
      'The recorded artifact identity did not verify, so this lane cannot claim to have measured it. ' +
        `status code: ${code}. ` +
        `Rebuild and re-record with "npm run record:web-artifact" (or the flagged lane's own record script) ` +
        `and then verify with "npm run verify:web-artifact".`,
    );
  }
  const recorded = parsed['recordedIdentity'] as { treeSha256?: unknown; fileCount?: unknown } | undefined;
  return {
    status: 'match',
    code: 'match',
    recordedTreeSha256: typeof recorded?.treeSha256 === 'string' ? recorded.treeSha256 : null,
    recordedFileCount: typeof recorded?.fileCount === 'number' ? recorded.fileCount : null,
    sourceMatches: typeof parsed['sourceMatches'] === 'boolean' ? parsed['sourceMatches'] : null,
  };
}

/* ── The walk ──────────────────────────────────────────────────────────────── */

/**
 * The village's own movement numbers, restated here so the walk's arithmetic can be exercised
 * without a browser.
 *
 * They are **literals rather than imports** because this module is loaded by a Playwright
 * worker, which does not resolve the `@/` alias, and a lane that only type-checks would be a
 * lane that never runs. `tests/e2e/fishing-lane.test.ts` therefore asserts each of them against
 * `src/data/villageLayout.ts` — the product's own table — so the two cannot drift: a renamed
 * constant or a retuned speed fails `npm test` rather than a lane four minutes later.
 */
export const VILLAGE_TILE_SIZE = 48;
export const VILLAGE_PLAYER_SPEED = 120;
export const VILLAGE_STRUCTURE_APPROACH_RADIUS = 48;

/**
 * One held arrow key: how long, and which way.
 *
 * 400 ms is `VILLAGE_PLAYER_SPEED × 0.4 s = 48` nominal world pixels, so a burst is nominally one
 * tile — which is the same as `VILLAGE_STRUCTURE_APPROACH_RADIUS`.
 *
 * ## Why one tile is the binding constraint, and why it still binds
 *
 * The village is a collision-free world with no collision to stop the learner, so the walk reads
 * the page before **every** burst and presses the row the moment the row is there. If a burst
 * carries the learner clean over the one-tile ring a structure's row exists inside, no reading
 * ever falls inside it and the walk carries on past the target forever. So a burst must be no
 * longer than the approach radius, and 400 ms is one tile.
 *
 * Measured on the container this lane runs in, walking the same spawn-to-pond journey twice per
 * configuration:
 *
 * | burst | nominal travel | outcome |
 * | --- | --- | --- |
 * | 400 ms | 1 tile | 2 of 2 arrived — burst 18, 10.2 s |
 * | 700 ms | 1.75 tiles | 2 of 2 arrived — burst 12, 10.5 s |
 * | 1000 ms | 2.5 tiles | **4 of 4 timed out at 90 s** |
 *
 * The 400 ms and 700 ms rows cost the same wall time, because the round trip is dominated by the
 * `page.evaluate` rather than by the key hold. So the shorter burst is free and it is the one
 * that leaves margin, and the 1000 ms row is what a burst that is too long looks like.
 *
 * ## The second constraint, which arrived with the published tile
 *
 * The walk decides whether it is making progress by comparing **whole-tile** distances between
 * readings, because the tile is the only unit the village publishes. On the slowest rate measured
 * here a burst covers {@link WALK_MEASURED_BURST_TRAVEL_TILES} of a tile, so several consecutive
 * bursts can leave the published tile unchanged while the learner is visibly walking — a burst
 * short enough to make that likely would look like a walk that had stopped moving. A *longer*
 * burst makes progress easier to see; a *shorter* one leaves more readings inside the approach
 * ring. 400 ms is the only length that satisfies both, and it is the one measured.
 */
export const WALK_BURST_MS = 400;

/** Tiles one burst is expected to cover. Derived, so it tracks {@link WALK_BURST_MS}. */
export const WALK_BURST_TRAVEL_TILES =
  (WALK_BURST_MS / 1000) * (VILLAGE_PLAYER_SPEED / VILLAGE_TILE_SIZE);

/** One burst's nominal travel in pixels, derived so it tracks {@link WALK_BURST_MS}. */
export const WALK_BURST_TRAVEL_PX = WALK_BURST_TRAVEL_TILES * VILLAGE_TILE_SIZE;

/**
 * The smallest travel this lane has measured per burst on the machine its budgets are sized for.
 *
 * A Phaser scene integrates movement from its **frame delta**, and Phaser clamps that delta to the
 * frame target (`TimeStep` takes `Math.min(delta, this._target)`), so a key held for 400 ms travels
 * 400 ms of *simulated* time rather than 400 ms of wall time. Measured in this repository's own
 * container: 400 ms of `ArrowRight` moves 0.29 tiles against a nominal 0.83, so the frame rate
 * here is about a third of what the arithmetic assumes.
 *
 * It exists so the two bounds below can be sized against the **measured** rate rather than the
 * nominal one. The difference between them is a factor of three, and a bound sized against the
 * nominal rate fails on the first machine slower than the one it was measured on — which is the
 * whole defect a wall-clock deadline replaced.
 */
export const WALK_MEASURED_BURST_TRAVEL_TILES = 0.29;

/** The four keys the village's movement bindings accept. */
export type WalkArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** One step of a walk. */
export interface WalkBurst {
  readonly key: WalkArrowKey;
  readonly ms: number;
}

/** A place in the village in grid units, the coordinates `VILLAGE_MAP` publishes. */
export interface VillageGridPoint {
  readonly gridX: number;
  readonly gridY: number;
}

/** One whole journey: where the learner is expected to be, where the target is, and how long to try. */
export interface VillageWalkPlan {
  /** The nearby-action row to press once the structure is in reach. */
  readonly targetId: string;
  /**
   * Where the walk is *expected* to start — and only that.
   *
   * **Never the origin of an aim.** An aim is `plan.to` plus the tile the village publishes. This
   * field is carried for the failure diagnosis, where the pair "the map says the learner starts
   * here, the renderer published *there*" is exactly what a reader needs in order to tell a walk
   * aimed at the wrong place from one that merely ran out of time.
   */
  readonly from: VillageGridPoint;
  /** The structure's centre in grid units, which is what the approach radius is measured from. */
  readonly to: VillageGridPoint;
  /**
   * Wall-clock budget for the whole approach.
   *
   * **Time, not a step count.** The old budget was a number of bursts pinned to the arithmetic,
   * which made a walk that needed four more bursts than the arithmetic predicted a flake rather
   * than a finding, and which had four bursts of slack on the longest journey in the lane. A
   * deadline says what a learner is actually willing to spend walking and is independent of how
   * far a key hold happens to travel on the machine running the lane.
   */
  readonly budgetMs: number;
}

/** `VILLAGE_MAP.playerStart`, the grid the village drops the learner at. */
export const VILLAGE_SPAWN_GRID: VillageGridPoint = Object.freeze({ gridX: 5, gridY: 27 });

/** `pond-fish-sw` at grid `(10, 23)` two by two, so its centre is `(11, 24)`. */
export const FISH_STAND_SW_POND_GRID: VillageGridPoint = Object.freeze({ gridX: 11, gridY: 24 });

/** `fish-stand` at grid `(19, 0)` three by two, so its centre is `(20.5, 1)`. */
export const FISH_STAND_GRID: VillageGridPoint = Object.freeze({ gridX: 20.5, gridY: 1 });

/**
 * The walk every lane performs first: the spawn to the nearest pond.
 *
 * Six tiles east and three north is nine bursts at the nominal rate; the 90-second budget is
 * several times the seconds this journey actually measured, which is the point of a deadline — it
 * costs nothing when the walk arrives early, and it covers a machine several times slower than the
 * one it was measured on.
 */
export const WALK_SPAWN_TO_SW_POND: VillageWalkPlan = Object.freeze({
  targetId: 'pond-fish-sw',
  from: VILLAGE_SPAWN_GRID,
  to: FISH_STAND_SW_POND_GRID,
  budgetMs: 90_000,
});

/**
 * The walk onwards from that pond to the fish stand, after the pond has been closed.
 *
 * The longer journey — twenty-three tiles north and nine and a half east from the pond. This is
 * the walk the traced failure happened on, when each leg aimed a long heading from a position it
 * was never at: it reached the stand at 38.9 pixels, lost the press to the sample interval, and
 * then held its heading north-east for 104 seconds without turning round.
 */
export const WALK_SW_POND_TO_FISH_STAND: VillageWalkPlan = Object.freeze({
  targetId: 'fish-stand',
  from: FISH_STAND_SW_POND_GRID,
  to: FISH_STAND_GRID,
  budgetMs: 120_000,
});

/** The same journey in reverse, for a test that read the stand before it went fishing. */
export const WALK_FISH_STAND_TO_SW_POND: VillageWalkPlan = Object.freeze({
  targetId: 'pond-fish-sw',
  from: FISH_STAND_GRID,
  to: FISH_STAND_SW_POND_GRID,
  budgetMs: 120_000,
});

/* ── Reading where the learner is ───────────────────────────────────────────── */

/**
 * The attribute the village screen's root carries the learner's tile on.
 *
 * **A literal**, like the movement numbers above, for the same reason: this module runs in a
 * Playwright worker that does not resolve the `@/` alias. The lane's gate asserts it against
 * `VILLAGE_PLAYER_ATTRIBUTE` in `src/ui/village/villagePlayerPosition.ts`, so a rename fails
 * `npm test` rather than leaving every walk in the lane reading an attribute that is always absent.
 */
export const VILLAGE_PLAYER_ATTRIBUTE = 'data-village-player';

/** The element that carries it: the village screen's own root. */
export const VILLAGE_PLAYER_ROOT_SELECTOR = '.village-screen';

/** Two tile indices exactly. A tolerance this small is still strictly less than one tile. */
const GRID_EPSILON = 1e-9;

/**
 * The published tile, or `null` for "cannot say where the learner is".
 *
 * **Every path that is not a pair of integers returns `null`, and no path invents a value.** That
 * is the whole reason this is a *total parser* rather than a cast. The failure it has to make
 * impossible is a walk silently navigating from tile `(0, 0)` because the attribute was missing,
 * unparseable, or written by something that was not the village: there is no default, no fallback,
 * and no `NaN` that would compare equal to itself a few lines later.
 *
 * Optional whitespace around the comma is **accepted**, and that is not a loosening of the
 * contract. Both halves are still anchored to a whole integer, so a value this returns is the
 * tile the village published whatever the spelling was; anything else in the string is refused
 * rather than guessed at. See the lane header for the `expect(NaN).toBe(NaN)` family this
 * refuses to join.
 */
export function parseVillagePlayerGrid(raw: string | null | undefined): VillageGridPoint | null {
  if (raw === null || raw === undefined) return null;
  const match = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(raw);
  if (match === null) return null;
  const gridX = Number(match[1]);
  const gridY = Number(match[2]);
  // `Number.isInteger` already refuses `NaN` and `Infinity`.
  if (!Number.isInteger(gridX) || !Number.isInteger(gridY)) return null;
  return { gridX, gridY };
}

/** How far apart two tiles are, in tiles. Euclidean, because the approach radius is a circle. */
export function gridDistanceTiles(from: VillageGridPoint, to: VillageGridPoint): number {
  return Math.hypot(to.gridX - from.gridX, to.gridY - from.gridY);
}

/**
 * Tiles from the target within which the burst shrinks to {@link WALK_BURST_NEAR_MS}.
 *
 * One and a half tiles, and the reason is the same arithmetic that governs the aim: beyond a tile the
 * dominant axis is unambiguous and a long burst is the fastest way to cover ground, while inside it
 * the only remaining uncertainty is **where inside the tile the learner stands** — which is not
 * published — and a burst longer than the radius would step straight over the target and land outside
 * it again.
 */
export const WALK_NEAR_APPROACH_TILES = 1.5;

/**
 * The hold used once the learner is within {@link WALK_NEAR_APPROACH_TILES} of the target.
 *
 * 150 ms is 18 nominal pixels — under half the 48-pixel approach radius, and a third of a tile — so a
 * burst can no longer step over the ring the row exists inside. At the rate measured on this
 * container a 150 ms burst is worth about five pixels, which is what lets the walk sample *inside*
 * the ring rather than only near it.
 *
 * Without this the last tile and a half is the whole problem. A 400 ms burst is 48 nominal pixels,
 * which is exactly the approach radius, so a learner homing on a target whose centre is mid-tile
 * lands on the boundary and steps off it again. Measured on this lane before the shrink existed: the
 * walk oscillated for 55 readings between the two tiles either side of the fish stand's centre, its
 * tile distance pinned at 0.50 the whole time, and the row never appeared once.
 */
export const WALK_BURST_NEAR_MS = 150;

/**
 * The hold for one burst at a given tile distance.
 *
 * Long bursts far out, short bursts near, and the switch is a stated distance rather than a condition
 * on progress — so it is the same rule on every reading and on every machine.
 */
export function burstMsFor(tileDistance: number): number {
  return tileDistance > WALK_NEAR_APPROACH_TILES ? WALK_BURST_MS : WALK_BURST_NEAR_MS;
}

/** One axis' aim: which way, and how much uncertainty is left on it. */
interface AxisAim {
  readonly direction: -1 | 0 | 1;
  /** Tiles of uncertainty on this axis. */
  readonly magnitude: number;
}

/**
 * The magnitude an axis claims when the learner is already on the target's own tile.
 *
 * Half a tile: the learner's offset inside that tile is uniformly distributed over it, so half a tile
 * is the expected size of the remaining uncertainty. It is what lets an *unambiguous* distance on the
 * other axis outrank this one, and what makes the two axes tie when both are mid-tile.
 */
const WALK_TIE_MAGNITUDE_TILES = 0.5;

/**
 * The aim on one axis, from a learner's **integer** tile toward a target that may sit mid-tile.
 *
 * ## Why the target's fraction matters
 *
 * `VillageScene.readNpcSnapshotCandidates` measures proximity from `(gridX + width / 2) * tileSize`
 * in **pixels** and admits a row on `distance < range`. So the arrival test is a pixel distance from a
 * point that can sit anywhere inside a tile, while the only position this lane is given is an integer
 * tile. Aiming at the target's *tile* is therefore not enough on its own: standing on the tile whose
 * index equals the centre leaves the learner anywhere in a whole square that can be a tile and a half
 * from the centre pixel — so it can be a tile "on the spot" and still out of range.
 *
 * Two shapes of that failure were measured on this lane before this rule existed:
 *
 * - the learner reached the pond's centre tile exactly and the walk **stopped**, because the aim had
 *   run out of distance to work with. That centre pixel is the tile's own corner, and the walk had no
 *   way to know which of four directions leads into it.
 * - the learner oscillated for 55 readings between the two tiles either side of the fish stand's
 *   centre, its tile distance pinned at 0.50 the entire time, and the row never appeared once.
 *
 * ## The rule
 *
 * On a *different* tile from the target's, the direction is unambiguous. On the target's own tile the
 * centre sits at fraction `f` of that tile and the learner at some unknown `u ∈ [0, 1)`. Pressing the
 * positive key moves it to `u + 1` on that axis, an expected `1.5 − f` tiles of error; pressing the
 * negative key moves it to `u − 1`, an expected `0.5 + f`. The negative key is the better bet when
 * `f < 0.5` and the positive one when `f ≥ 0.5` — which is what this returns. At `f = 0` the centre is
 * on the tile's edge and the learner is sent the short way round to it.
 */
function aimAxis(fromTile: number, targetTile: number): AxisAim {
  const delta = targetTile - fromTile;
  if (Math.abs(delta) > GRID_EPSILON) {
    return { direction: delta > 0 ? 1 : -1, magnitude: Math.abs(delta) };
  }
  const fraction = targetTile - Math.floor(targetTile);
  return { direction: fraction < 0.5 ? -1 : 1, magnitude: WALK_TIE_MAGNITUDE_TILES };
}

/**
 * The single key to press next, computed from a **published** tile toward the target.
 *
 * The axis with the larger remaining uncertainty gets the burst, so the learner never drifts sideways
 * while the long axis is open and closes the short one as soon as it becomes the only candidate.
 *
 * ## Why `avoid` exists
 *
 * Because one press is one key, a walk can only ever work **one** axis at a time. When both axes claim
 * the same uncertainty — the fish stand's centre sits at `(20.5, 1)`, so a learner standing on tile
 * `(20, 1)` is half a tile from the centre on each axis — a fixed tie-break picks the same axis
 * forever and the other one never closes. That is not hypothetical: it is what the 55-reading
 * oscillation above was. So on a tie the aim prefers **the axis the last burst did not work**, which
 * is one bit of history and makes both axes converge.
 *
 * It never returns "press nothing". The learner cannot be at the centre pixel from an integer tile,
 * so the honest move is always towards it, and the **row** — not the aim running out — is the arrival
 * test. A walk that pressed nothing inside the radius would leave its best opportunity unsampled.
 */
export function approachKey(
  from: VillageGridPoint,
  to: VillageGridPoint,
  avoid?: WalkArrowKey,
): WalkArrowKey {
  const across = aimAxis(from.gridX, to.gridX);
  const down = aimAxis(from.gridY, to.gridY);
  const horizontal: WalkArrowKey = across.direction >= 0 ? 'ArrowRight' : 'ArrowLeft';
  const vertical: WalkArrowKey = down.direction >= 0 ? 'ArrowDown' : 'ArrowUp';
  const workedHorizontal = avoid === 'ArrowRight' || avoid === 'ArrowLeft';

  if (across.magnitude > down.magnitude + GRID_EPSILON) return horizontal;
  if (down.magnitude > across.magnitude + GRID_EPSILON) return vertical;
  return workedHorizontal ? vertical : horizontal;
}

/**
 * Move one point one burst's nominal travel along `key`, clamped to the target on that axis.
 *
 * The clamp is what keeps the model finite: the aim **oscillates around** the target rather than
 * stopping on it, so without a clamp this model would walk off the map and could not serve as the
 * bounded reference the gate and the failure diagnosis both use.
 *
 * The result is deliberately **not** floored. `at` is the learner's sub-tile position, which the real
 * learner accumulates; the walk only ever *reads* it floored, and {@link approachBursts} floors it
 * when it hands a position to {@link approachKey}. Rounding here instead would discard the
 * accumulation, and a near burst is a third of a tile — so a learner standing a tenth of a tile into a
 * tile would never cross it and the model would run to its ceiling on a journey the walk itself
 * completes. That was the first version's behaviour, measured rather than argued.
 */
function stepOneBurst(
  at: VillageGridPoint,
  key: WalkArrowKey,
  to: VillageGridPoint,
  ms: number,
): VillageGridPoint {
  const travel = (ms / 1000) * (VILLAGE_PLAYER_SPEED / VILLAGE_TILE_SIZE);
  const forward = key === 'ArrowRight' || key === 'ArrowDown';
  const delta = forward ? travel : -travel;
  const clamp = (value: number, limit: number): number =>
    forward ? Math.min(limit, value + delta) : Math.max(limit, value + delta);
  return key === 'ArrowRight' || key === 'ArrowLeft'
    ? { gridX: clamp(at.gridX, to.gridX), gridY: at.gridY }
    : { gridX: at.gridX, gridY: clamp(at.gridY, to.gridY) };
}

/** The tile the village would publish for a sub-tile position. */
function publishedTile(at: VillageGridPoint): VillageGridPoint {
  return { gridX: Math.floor(at.gridX), gridY: Math.floor(at.gridY) };
}

/**
 * The backstop on the reference model, and only on it.
 *
 * ## Why a model bound is needed where the browser loop has none
 *
 * The aim **oscillates around** the target, which is correct — a learner homing on a centre pixel it
 * can only see through a tile-sized window crosses the target and comes back, and that is what puts it
 * inside the approach radius. But an oscillating aim has no monotone quantity to run to zero, so
 * `approachBursts` cannot terminate on "arrived the way the walk does". (Its first version looped
 * forever and took the vitest worker down with it, which is how this constant exists.)
 *
 * The browser loop does **not** need this number. It ends on the deadline, on a frozen published
 * tile, or on no progress at all — three bounds, each tied to a measurement the walk actually takes.
 * The model has none of those, so it gets a plain ceiling.
 *
 * It is far larger than any journey here needs — the longest is 33 tiles and the homing tail is
 * measured in tens of bursts — so it cannot be mistaken for an arrival count, and the gate asserts it
 * is never reached on either of this lane's journeys.
 */
export const WALK_MODEL_MAX_BURSTS = 400;

/**
 * The bursts a straight approach from one grid point to another takes, as a pure function.
 *
 * **A reference model, and it is used as one.** The browser loop follows no schedule: it re-derives
 * {@link approachKey} from the tile the village publishes, one burst at a time. The only caller of
 * this function is the walk's failure diagnosis, which reports how many bursts the modelled journey
 * from the learner's *last published tile* would have taken — so a reader who sees "the walk gave up
 * 24 tiles short" is told how far it actually had left, in the units the walk thinks in. That is the
 * honest reason for a pure model of the same rule: so the rule can be asserted without a browser and
 * measured against in a report.
 *
 * It stops when the learner is on the target's **own tile** on both axes, which is the granularity at
 * which the walk is given positions and therefore the point at which the model has nothing further to
 * close — homing inside that tile is the **row's** job, not the aim's, and pretending otherwise is what
 * the first version did when it looped to its ceiling on a journey the walk completes. Bounded by
 * {@link WALK_MODEL_MAX_BURSTS} as a backstop against a bug rather than as an arrival count. The burst
 * length is the one the browser loop would use at that distance, so the count means the same thing in
 * both places.
 */
export function approachBursts(from: VillageGridPoint, to: VillageGridPoint): WalkBurst[] {
  const goal = publishedTile(to);
  let at: VillageGridPoint = { gridX: from.gridX, gridY: from.gridY };
  const bursts: WalkBurst[] = [];
  let previous: WalkArrowKey | undefined;
  for (let index = 0; index < WALK_MODEL_MAX_BURSTS; index += 1) {
    const seen = publishedTile(at);
    if (seen.gridX === goal.gridX && seen.gridY === goal.gridY) break;
    const key = approachKey(seen, to, previous);
    const ms = burstMsFor(gridDistanceTiles(seen, to));
    bursts.push({ key, ms });
    previous = key;
    at = stepOneBurst(at, key, to, ms);
  }
  return bursts;
}

/* ── Holding keys and reading the page ──────────────────────────────────────── */

/** Hold a key for a bounded time. The only place this lane synthesises input. */
export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/**
 * The gap between two readings of a walk that is not moving.
 *
 * Used by the loop's wait for the published tile and by its "already on the target tile" poll. It
 * is the village's own publish interval rounded up a little, because a poll faster than the
 * village publishes can only ever re-read the value it already has.
 */
export const WALK_POLL_MS = 120;

/** Every nearby-action row currently on the page, as plain data. */
export interface NearbyRow {
  readonly id: string;
  readonly kind: string;
  readonly distance: number | null;
  readonly label: string;
  /** Whether a press at the row's centre still lands on that row, read in the same pass. */
  readonly pressable: boolean;
}

/** One pass over the village: the nearby rows, a press, and the published tile. */
export interface VillageReading {
  readonly rows: readonly NearbyRow[];
  /** Whether a press was dispatched at the target's row in this pass. */
  readonly pressed: boolean;
  /**
   * The attribute's **raw** string, unparsed.
   *
   * Deliberately raw rather than parsed: parsing in the page would mean two copies of
   * {@link parseVillagePlayerGrid}, one of which nothing would exercise. The copy that decides
   * where the learner is ought to be the one this module's gate tests.
   */
  readonly playerRaw: string | null;
}

/**
 * One pass over the nearby-action list and the village's published tile.
 *
 * **One `evaluate`, not two, and not a pile of locators.** Three reasons, independent, all pointing
 * the same way:
 *
 * - The two readings are used **together** — the heading comes from the tile and the arrival is
 *   decided from the row — so reading them in separate round trips would let the learner move
 *   between them and hand the loop a heading computed from one instant and a distance measured
 *   from another. One pass is one instant.
 * - The checks compare readings against each other, and a locator read *waits* for an element that
 *   may legitimately be absent — a fifteen-second timeout each time, for an absence that is the
 *   answer. The published tile is **expected** to be absent before a renderer mounts, and that
 *   absence is a state the loop has to be able to see at once rather than wait out.
 * - The press-liveness flag is why the click happens in the same round trip. A row exists only
 *   while its target is within the approach radius, and `click()` spends longer than that in
 *   actionability checks, so a row present when the test decided to press it can be gone by the
 *   time Playwright would dispatch. Reading `document.elementFromPoint` at the row's own centre
 *   and clicking in the same pass means the question "is the point I am about to click still this
 *   row" is answered as freshly as the press itself.
 */
async function readVillage(
  page: Page,
  targetId: string,
  press: boolean,
): Promise<VillageReading> {
  return page.evaluate(
    ({ id, shouldPress, attribute, rootSelector }) => {
      const playerRaw = document.querySelector(rootSelector)?.getAttribute(attribute) ?? null;
      const rows = [...document.querySelectorAll<HTMLButtonElement>(
        '[data-village-nearby="true"] button[data-target-kind]',
      )].map((button) => {
        const raw = button.dataset.targetDistance;
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        const box = button.getBoundingClientRect();
        return {
          id: button.dataset.targetId ?? '',
          kind: button.dataset.targetKind ?? '',
          distance: Number.isFinite(parsed) ? parsed : null,
          label: (button.textContent ?? '').trim(),
          pressable: false,
          centre:
            box.width > 0 && box.height > 0
              ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
              : null,
        };
      });
      const target = rows.find((row) => row.id === id) ?? null;
      let pressed = false;
      if (target !== null && target.centre !== null) {
        const hit = document.elementFromPoint(target.centre.x, target.centre.y);
        const landed = hit?.closest<HTMLButtonElement>(
          '[data-village-nearby="true"] button[data-target-kind="structure"]',
        );
        if (landed?.dataset.targetId === id) {
          if (shouldPress) landed.click();
          pressed = shouldPress;
          return {
            rows: rows.map((row) => (row.id === id ? { ...row, pressable: true } : row)),
            pressed,
            playerRaw,
          };
        }
      }
      return { rows, pressed, playerRaw };
    },
    {
      id: targetId,
      shouldPress: press,
      attribute: VILLAGE_PLAYER_ATTRIBUTE,
      rootSelector: VILLAGE_PLAYER_ROOT_SELECTOR,
    },
  );
}

/**
 * Every nearby-action row currently on the page, with no press.
 *
 * The thin wrapper the rollback lane's own "walk away, and prove the row went" fence uses, so both
 * lanes keep one spelling of "read the nearby list".
 */
export async function readNearby(page: Page, targetId: string): Promise<NearbyRow[]> {
  return readVillage(page, targetId, false).then((reading) => [...reading.rows]);
}

/** The nearby row for one structure id, or `null` when it is not in reach. */
export async function nearbyRowFor(page: Page, targetId: string): Promise<NearbyRow | null> {
  const rows = await readNearby(page, targetId);
  return rows.find((row) => row.id === targetId) ?? null;
}

/**
 * The pond's published phase, or `null` while the HUD is not on the page.
 *
 * **This is the one place the lane is allowed to swallow a read**, and it is here rather than in
 * a spec because the lane's own gate forbids `.catch(` in both spec files: a poll that has to ask
 * "is the HUD there yet?" cannot also be a poll that fails the test when the answer is no. The
 * tolerance is one named function with one purpose, and every caller still asserts on the result
 * — `requirePond` throws when the pond is absent, and `phaseOf` re-reads through this and fails
 * on `null`.
 */
export async function readPondPhase(page: Page): Promise<string | null> {
  try {
    return await page.locator('.fishing-hud').getAttribute('data-fishing-phase');
  } catch {
    return null;
  }
}

/**
 * Wait until the village publishes the learner's tile, and return the first tile it does.
 *
 * **It waits, and it never substitutes a value.** The attribute is absent before a renderer mounts
 * and absent on an adapter that does not implement the read, so an absent attribute is the product
 * saying "I cannot say where the learner is" — a state the walk survives by waiting, never by
 * papering over with tile `(0, 0)`. A walk that guessed would aim north-west from the map's
 * corner and walk the learner off the top-left of the village, and that is the failure mode this
 * function exists to make impossible.
 *
 * Throws rather than returning `null`, because the caller has nothing useful to do without a
 * position: it could not aim, so there is no walk to attempt and no distance to report. The
 * message says which attribute, which element, how long it looked, and that the state is a product
 * finding rather than a walk that ran out of time.
 */
export async function waitForPlayerGrid(page: Page, plan: VillageWalkPlan): Promise<VillageGridPoint> {
  const deadline = Date.now() + plan.budgetMs;
  for (;;) {
    const reading = await readVillage(page, plan.targetId, false);
    const at = parseVillagePlayerGrid(reading.playerRaw);
    if (at !== null) return at;
    if (Date.now() >= deadline) {
      throw new Error(
        `The village screen never published ${VILLAGE_PLAYER_ATTRIBUTE}, so this walk could not aim ` +
          `at ${plan.targetId} at all. It looked on ${VILLAGE_PLAYER_ROOT_SELECTOR} for ` +
          `${plan.budgetMs}ms and read ${JSON.stringify(reading.playerRaw)} throughout. The attribute ` +
          'is published by the village screen from the renderer-neutral readPlayerGridPosition, so an ' +
          'adapter that does not implement it and a screen that never mounted both produce exactly ' +
          'this state. That is a product finding rather than a walk that failed: there is no supported ' +
          'way to navigate the village without a position.',
      );
    }
    await page.waitForTimeout(WALK_POLL_MS);
  }
}

/* ── The loop ──────────────────────────────────────────────────────────────── */

/**
 * How long after a press before another one is attempted.
 *
 * Long enough for the surface the press opened to mount — a Pixi pond is a lazy chunk and a panel is
 * a React commit — and short enough that a press which genuinely did nothing is retried within the
 * same burst budget. It is a *settle*, not a timeout: the walk never waits on it, it only declines to
 * press again while a previous press is still within it.
 */
export const WALK_CONFIRM_SETTLE_MS = 3_000;

/**
 * Readings with neither progress nor movement before the walk stops trying.
 *
 * ## Why two separate conditions, and why progress alone is not enough
 *
 * The aim now **oscillates around** the target rather than closing monotonically onto it — a learner
 * homing on a centre pixel it can only see through a tile-sized window crosses the target and comes
 * back, which is correct and is what puts it inside the approach radius. So a walk that is *working*
 * can legitimately stop improving its tile distance for a long stretch, and a stall counter keyed on
 * improvement alone read that as stuck.
 *
 * That was measured. Before this split the walk ended itself after 55 readings having made no
 * progress while its tile moved on every single reading — a learner doing exactly the right thing
 * that a progress-only rule threw away. So the counter is reset by **either** improvement in the
 * distance to the target **or** a change in the published tile, and it fires only when neither has
 * happened. A frozen learner, a walk whose keys stopped reaching the world, and a walk whose aim ran
 * out of distance all still trip it, because in each of those the tile is not changing.
 *
 * ## Why this many readings, and how the number was chosen
 *
 * It has to be long enough that "the tile has not changed" cannot mean "moving slowly", and the tile
 * quantum sets the floor. Progress is measured in **whole tiles**, because the tile is the only unit
 * the village publishes, and at the slowest rate measured here a burst covers
 * {@link WALK_MEASURED_BURST_TRAVEL_TILES} of one — so several consecutive bursts can leave the
 * published tile unchanged while the learner is visibly walking. Four bursts is the smallest number
 * that *guarantees* a tile change on some axis; this is several times that, so the walk will have
 * travelled multiple whole tiles without changing its published tile at all before it concludes it is
 * stuck. Anything shorter would read a slow runner as a frozen learner, which is the defect a deadline
 * replaced.
 *
 * It also has to outlast the press settle, or a walk that keeps arriving and keeps losing its press
 * would give up before it had retried once. Both properties are asserted in the lane's gate rather
 * than assumed here, because they are the two ways this number could be wrong.
 */
export const WALK_STALL_READINGS = 24;

/**
 * Readings without progress **however much the learner moves**, before the walk concludes it is
 * circling.
 *
 * ## Why the movement reset is not enough on its own
 *
 * Because a walk that oscillates around the target without the row ever appearing is a real state:
 * the learner is moving and closing, and nothing about "am I moving" distinguishes it from a walk
 * about to succeed. Only the fact that **the distance stopped improving altogether** does — and at
 * sixty readings with no improvement at all, while still pressing keys, the walk has sampled the area
 * sixty times and found nothing.
 *
 * Sixty readings is deliberately far above the handful an oscillating walk needs to land inside a
 * 48-pixel ring: the measured 55-reading oscillation above was against a walk that could not press at
 * all, so the number is not tuned from it. It is set where the wall-clock cost stays well inside the
 * shortest budget — sixty readings at one burst each is roughly half of it — so the diagnosis arrives
 * while the reader still has the run's other evidence in front of them.
 */
export const WALK_RINGING_READINGS = 60;

/** A distance change smaller than this is the tile quantum itself, not progress. */
const WALK_PROGRESS_EPSILON_TILES = GRID_EPSILON;

/**
 * Tells the walk whether its press actually took effect.
 *
 * The nearby list is a **sampled** read-out: the renderer publishes a proximity snapshot on a
 * throttled interval, so a row can be present while the learner's real distance has already
 * crossed the approach radius. Measured on this lane: the walk's read reported the fish stand at
 * **47.9** against a 48-pixel radius, the press landed on the button, and nothing happened — the
 * structure had left, `structureLeft` closed the panel in the same tick, and the press was silently
 * lost.
 *
 * The harness cannot know what "it worked" looks like for a pond or a fish stand, so the caller
 * supplies the check. It is asked **after** a press, and its answer decides whether the walk keeps
 * going: a press that did not take effect is retried rather than reported as an arrival.
 */
export type WalkConfirmation = () => Promise<boolean>;

/**
 * How a walk ended.
 *
 * A discriminated union rather than a nullable row, because `row === null` and "arrived, and here
 * is the row" are different answers and a caller that reads them as one cannot write a diagnosis.
 * The failure arm carries the **measurements** — the last published tile and the closest approach —
 * because those are the whole of what the walk knew when it gave up, and a caller that reports
 * "never came into reach" without them is repeating the misleading-diagnosis failure this lane
 * already found once.
 */
export type VillageWalkOutcome =
  | {
      readonly arrived: true;
      readonly row: NearbyRow;
      /** How many readings the walk took, so a fast arrival and a slow one stay distinguishable. */
      readonly readings: number;
    }
  | {
      readonly arrived: false;
      /**
       * `no-progress`: neither the distance nor the published tile moved. `no-approach`: the learner
       * kept moving and never closed, so the walk circled a target it could not reach. `budget`: the
       * deadline. Three different findings behind one red test, and a reader who cannot tell them
       * apart has to re-run the lane to find out which one it was.
       */
      readonly reason: 'no-progress' | 'no-approach' | 'budget';
      /** The last tile the village published, or `null` if none ever was. */
      readonly lastPlayer: VillageGridPoint | null;
      /** The closest approach to the target's centre in tiles, or `null` if nothing was measured. */
      readonly closestTiles: number | null;
      readonly readings: number;
    };

/** The failure arm, named, so a caller reads one identifier instead of narrowing on a literal. */
export type VillageWalkFailure = Extract<VillageWalkOutcome, { arrived: false }>;

/**
 * Walk to a structure under `plan` and press its nearby-action row.
 *
 * ## The loop, in the order it happens
 *
 * 1. {@link waitForPlayerGrid} — no aim is possible until the village says where the learner is,
 *    and there is no default to fall back on.
 * 2. Each iteration: ask the caller's confirmation whether a **previous** press took, then take one
 *    reading of the nearby rows and the published tile together, aim from the published tile, and
 *    spend exactly one burst on that key.
 * 3. Stop on the reading where the target's own row appears and the press is **confirmed**, or when
 *    {@link WALK_STALL_READINGS} readings have failed to improve the distance to the target, or when
 *    the deadline passes.
 *
 * ## Why it corrects instead of reversing
 *
 * The earlier version of this walk had no position at all. It could only press along a fixed ratio
 * derived from the map's two endpoints, so it needed a separate **reversal** control to turn round
 * when it overshot — measured firing correctly on the one failure it was written for, and still
 * redundant the moment the walk could see where it was. That control is gone. A heading computed
 * from the learner's own published tile already points **back** at the target the instant the
 * learner passes it, so "overshot" is not a state this walk can be in: there is no schedule to
 * reverse and no distance to interpret, only a position and a key that follows from it.
 *
 * The residual defect the reversal never fixed is also gone, and that is the reason the two are the
 * same change. Each plan names a structure *centre*, a press is made wherever the learner happens to
 * be inside a one-tile radius — measured at 30.8 and 41.6 pixels — and the next leg used to aim a
 * twenty-five-tile heading from a position it was never at. Traced consequence: the
 * fish-stand-to-pond walk ran 212 readings with a correct heading, never saw the pond row once, and
 * walked off the map. A walk that aims from the published tile cannot carry that error forward,
 * because it never had it.
 *
 * ## What the readings are used for
 *
 * One reading carries three facts and each has exactly one job. The **published tile** decides the
 * next key. The **distance to the target in tiles** decides whether the walk is still making
 * progress and whether it has arrived. The **row's presence** decides whether there is something to
 * press. Nothing reads a fourth thing, and nothing reads a thing twice.
 *
 * ## Why it never throws on a timeout
 *
 * A lane that cannot reach its own entry point has a finding to report, and the caller decides what
 * that finding means. The measurements travel back in the outcome so the caller's own message can
 * name them.
 */
export async function walkToStructureAndPress(
  page: Page,
  plan: VillageWalkPlan,
  confirm?: WalkConfirmation,
): Promise<VillageWalkOutcome> {
  let closestTiles: number | null = null;
  let lastPlayer: VillageGridPoint | null = null;
  let previousTile: VillageGridPoint | null = null;
  let stalledReadings = 0;
  let ringingReadings = 0;
  let readings = 0;
  let pressedAt: number | null = null;
  let lastRow: NearbyRow | null = null;
  let lastKey: WalkArrowKey | undefined;
  let reason: 'no-progress' | 'no-approach' | 'budget' = 'budget';

  const deadline = Date.now() + plan.budgetMs;
  await waitForPlayerGrid(page, plan);

  for (;;) {
    readings += 1;

    // The last press is checked **once, and then the walk resumes**.
    //
    // The obvious shape — sit and re-ask until the press takes — is wrong, and it was measured: it
    // spends the walk's whole budget re-pressing in place while the learner stands exactly where the
    // press failed, so a press that was lost because the player was out of range never gets the walk
    // to move and the walk times out having never moved. A learner whose tap misses takes another
    // *step*, so this asks once, then spends the burst and reads again from a new position.
    if (pressedAt !== null && confirm !== undefined && (await confirm())) {
      if (lastRow === null) {
        throw new Error(
          `The walk to ${plan.targetId} reported a confirmed press with no row to report. The press ` +
            'and the confirmation disagreed, which is a harness defect rather than a walk that failed.',
        );
      }
      return { arrived: true, row: lastRow, readings };
    }

    /*
     * One reading, and both halves of it taken together.
     *
     * The heading is computed from the published tile and the arrival is decided from the row, so
     * reading them in separate round trips would let the learner move between them and hand the loop
     * a heading computed from one instant and an arrival decided at another. The press is attempted
     * in the same pass as the reading, for the reason {@link readVillage} gives.
     */
    const attempt = await readVillage(page, plan.targetId, true);
    const row = attempt.rows.find((candidate) => candidate.id === plan.targetId) ?? null;
    if (row !== null) lastRow = row;

    /*
     * The published tile, or a failure.
     *
     * `waitForPlayerGrid` established that one exists, so a gap here means the attribute was
     * *removed* — which the product does, when a renderer stops answering. That is a different state
     * from "never published" and it is still not a licence to guess. The two honest options are to
     * keep the tile last read, or to fail, and keeping it is right: the learner cannot have moved
     * to a place the village cannot report, because the renderer is gone rather than the learner.
     */
    const published = parseVillagePlayerGrid(attempt.playerRaw);
    if (published !== null) lastPlayer = published;
    const at = published ?? lastPlayer;
    if (at === null) {
      // Unreachable while `waitForPlayerGrid` ran, and kept as a *failure* rather than a `continue`
      // so a walk that somehow got here reports a cause instead of walking on nothing.
      throw new Error(
        `The village stopped publishing ${VILLAGE_PLAYER_ATTRIBUTE} during the walk to ` +
          `${plan.targetId} and this walk had never read a tile to fall back on. There is no default ` +
          'tile to navigate from by design; see waitForPlayerGrid for why.',
      );
    }

    const distanceTiles = gridDistanceTiles(at, plan.to);
    if (closestTiles === null || distanceTiles < closestTiles - WALK_PROGRESS_EPSILON_TILES) {
      closestTiles = distanceTiles;
      stalledReadings = 0;
      ringingReadings = 0;
    } else {
      /*
       * Two counters, and they answer two different questions.
       *
       * `ringingReadings` counts readings without *progress*, whatever the learner is doing. `stalledReadings`
       * additionally requires the published tile to be unmoved, because an aim that oscillates around a
       * target it can only see through a tile-sized window stops improving while still working — and a
       * progress-only rule threw that away. Measured: 55 readings, no progress, the tile moving on every
       * one, and a walk doing exactly the right thing.
       */
      ringingReadings += 1;
      const moved =
        previousTile !== null && (previousTile.gridX !== at.gridX || previousTile.gridY !== at.gridY);
      if (published !== null && moved) stalledReadings = 0;
      else stalledReadings += 1;
    }
    if (published !== null) previousTile = published;

    /*
     * Press on **any** row in reach. There is deliberately no distance threshold on the press, and
     * that is a measured decision rather than an omission.
     *
     * A threshold was implemented on the theory that the nearby list is a sampled read-out and a
     * press outside some fraction of the radius would race it. It refused every press the walk was
     * ever in a position to make — the walk's closest approach to a structure was a lateral offset
     * of 32 to 45 pixels on a 48-pixel radius, so a half-radius gate declined all of them and all
     * ten tests timed out on the first leg. The theory was then checked against the measurements
     * instead of kept on plausibility: presses at **32** and **45.1** pixels both landed and opened
     * their surfaces, and the two that were lost went at **38.9** and **47.9**. That is not monotonic
     * in distance, so *no* cut-off separates the cases a gate is meant to separate, and the
     * arithmetic is pinned as such in the lane's gate.
     *
     * A lost press is handled by pressing again from a *near* position rather than by declining to
     * press — and now the walk also comes back to the same place, because the aim is derived from
     * the published tile and a learner standing inside the radius keeps being aimed at the centre.
     */
    if (
      row !== null &&
      attempt.pressed &&
      (pressedAt === null || Date.now() - pressedAt >= WALK_CONFIRM_SETTLE_MS)
    ) {
      pressedAt = Date.now();
      if (confirm === undefined) return { arrived: true, row, readings };
    }

    // The two conclusions, both checked **after** the reading so neither can pre-empt a reading
    // that would have found the row.
    if (stalledReadings >= WALK_STALL_READINGS) {
      reason = 'no-progress';
      break;
    }
    if (ringingReadings >= WALK_RINGING_READINGS) {
      reason = 'no-approach';
      break;
    }
    // The deadline is checked *after* the read and *before* the next burst, so a walk that cannot
    // arrive ends on a measurement rather than on a burst it had no time to finish.
    if (Date.now() >= deadline) break;

    /*
     * The aim, from this reading's tile — and the burst it is worth.
     *
     * `avoid` carries one bit of history, because one press is one key: with both axes claiming the
     * same half-tile of uncertainty (the fish stand's centre at `(20.5, 1)` seen from tile `(20, 1)`)
     * a fixed tie-break would work one axis forever. The burst shrinks inside
     * {@link WALK_NEAR_APPROACH_TILES}, because a 400 ms burst is 48 nominal pixels — exactly the
     * approach radius — and would step over the ring the row exists inside.
     */
    const key = approachKey(at, plan.to, lastKey);
    await holdKey(page, key, burstMsFor(distanceTiles));
    lastKey = key;
  }
  return { arrived: false, reason, lastPlayer, closestTiles, readings };
}

/* ── Leaving the pond ───────────────────────────────────────────────────────── */

/** The pond's own way out, the control `FishingHud` publishes for it. */
const POND_RETURN_CONTROL = '[data-fishing-touch-target="return-to-village"]';

/**
 * Leave the pond with the pond's own control, and wait until the village is back.
 *
 * ## Why this is a step and not a detail
 *
 * While the pond is open it **owns the arrow keys**: `createFishingScene` binds its own
 * `keydown` listener, calls `preventDefault` on the arrows, and spends them moving the angler
 * along the shore. That is correct product behaviour — the angler has to be able to walk — and it
 * means a learner standing in the pond who presses the arrow keys does not move the village. So a
 * lane that casts a fish and then walks to the fish stand without closing the pond is asking the
 * village to move while the pond is holding the keys, and the pond's proximity list is the only
 * one that ever fills.
 *
 * The walk therefore has to return to the village first, and it returns through the same button a
 * learner presses, rather than by dispatching a synthetic key or reaching past the overlay.
 */
export async function returnToVillage(page: Page): Promise<void> {
  const leave = page.locator(POND_RETURN_CONTROL);
  await leave.waitFor({ state: 'visible', timeout: 30_000 });
  await leave.click();
  // Three readings, in the order they become true: the screen says which world it is showing,
  // the pond's own HUD is gone, and the village's action list is back.
  await page.locator('[data-world="village"]').waitFor({ timeout: 30_000 });
  await page.locator('.fishing-hud').waitFor({ state: 'detached', timeout: 30_000 });
  await page.locator('[data-village-nearby="true"]').waitFor({ timeout: 30_000 });
}

/* ── Reaching the village ──────────────────────────────────────────────────── */

const WELCOME_HEADING = 'Knowledge Dungeon';

/**
 * Welcome → the tutorial dungeon → the village, with **no reload**.
 *
 * The reload is the part that matters and it is easy to get wrong. Returning to Welcome and
 * clicking "Continue to Village" works, but it rebuilds the in-memory subject store from
 * `localStorage`, and the fishing session is minted from that store's active subject — so a
 * reload between the two routes can leave the run at a pond that refuses every catch for a
 * reason that has nothing to do with fishing. "Go to Village" is the button a learner presses
 * and it keeps the activated subject in memory, so that is the route this lane takes.
 */
export async function openVillage(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { level: 1, name: WELCOME_HEADING }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Start Tutorial' }).click();
  await page.getByRole('button', { name: 'Go to Village' }).click({ timeout: 60_000 });
  await page.locator('[data-world]').waitFor({ timeout: 60_000 });
  await page.locator('[data-village-nearby="true"]').waitFor({ timeout: 60_000 });
}

/**
 * Welcome → "Continue to Village", for a device that already holds a subject.
 *
 * The route a returning learner takes, and the only one that leaves a **pre-seeded** subject as
 * the active one: "Start Tutorial" mints a second subject and makes it active, which would put
 * the tutorial's room-less subject back in front of the pond and quietly turn the seeded fixture
 * into the branch it exists to avoid. No reload, for the reason {@link openVillage} gives.
 */
export async function openVillageWithSeededSubject(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('heading', { level: 1, name: WELCOME_HEADING }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue to Village' }).click({ timeout: 60_000 });
  await page.locator('[data-world]').waitFor({ timeout: 60_000 });
  await page.locator('[data-village-nearby="true"]').waitFor({ timeout: 60_000 });
}

/**
 * Choose the Scholar archetype in the village's own HUD, and assert the choice registered.
 *
 * A requirement, not a convenience. `App` routes to the dungeon only when the session has a
 * snapshot, **an archetype, and an active subject**, so a device that has never picked one lands
 * back on Welcome however correct the recall route's own navigation is. The assertion is on the
 * control's `aria-pressed` state rather than on a painted class, so it fails if the click landed
 * on something that was not the archetype button.
 */
export async function chooseScholarArchetype(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Scholar' }).first();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click();
  const pressed = await button.getAttribute('aria-pressed');
  if (pressed !== 'true') {
    throw new Error(
      'The Scholar archetype control is still aria-pressed="false" after it was clicked, so the ' +
        'dungeon route would not open: App renders WorldRoute only when the session has a snapshot, ' +
        'an archetype, and an active subject, and an unselected archetype sends the recall route ' +
        'back to Welcome instead of the room it resolved.',
    );
  }
}

/* ── Privacy ───────────────────────────────────────────────────────────────── */

/**
 * Install the privacy spy and the non-loopback route guard.
 *
 * `localOrigin` is the preview origin the lane is pointed at, passed in rather than read from
 * the page, so a classification never depends on a page having finished loading. `classifyRequestLike`
 * also treats a bare loopback origin as local, so this is a second check and not the only one.
 *
 * The guard and the spy are installed together and in this order: the route is registered
 * before the first navigation so a privacy regression is *observed* by the spy while still being
 * prevented from leaving.
 */
export function installNetworkSpy(page: Page, localOrigin: string): NetworkSpy {
  const requests: Request[] = [];
  const sockets: string[] = [];
  const pageErrors: string[] = [];
  const scriptPaths: string[] = [];

  page.on('request', (request) => {
    requests.push(request);
    if (request.resourceType() === 'script') {
      scriptPaths.push(new URL(request.url()).pathname);
    }
  });
  page.on('websocket', (socket: WebSocket) => {
    sockets.push(socket.url());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(sanitizeToolchainText(error.message));
  });

  void page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );

  const report = (): ReturnType<typeof buildNetworkPolicyReport> =>
    buildNetworkPolicyReport(
      requests.map((request) => classifyRequestLike(request, localOrigin)),
      sockets.map((url) => classifyWebSocketLike(url, localOrigin)),
    );

  return {
    report,
    assertions: () => {
      const summary = report();
      const parts = [describeNetworkFailures(summary)];
      if (summary.webSockets.total > 0) {
        parts.push(`unexpected WebSocket destinations x${summary.webSockets.total}`);
      }
      if (pageErrors.length > 0) {
        parts.push(`page errors: ${pageErrors.join(' | ')}`);
      }
      return parts.join('; ');
    },
    pixiScriptPaths: () => scriptPaths.filter((p) => /pixi/i.test(p)),
    fishingScriptPaths: () => scriptPaths.filter((p) => p.includes(FISHING_CHUNK_PREFIX)),
    pageErrors: () => pageErrors,
  };
}

/* ── Evidence ──────────────────────────────────────────────────────────────── */

export interface FishingRunReading {
  readonly lane: string;
  readonly rendererMode: FishingRendererMode;
  readonly inputMode: FishingInputMode;
  readonly hostOperatingSystem: string;
  readonly architecture: string;
  readonly browserVersion: string;
  readonly browserChannel: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly evidenceClass: string;
  readonly worldRenderer: string;
  readonly villageRenderer: string;
  readonly storageRepository: string;
  readonly fishingChunkPresent: boolean;
  readonly pixiScriptRequestCount: number;
  readonly totalRequestCount: number;
  readonly networkViolations: readonly { category: string; count: number }[];
  readonly observedPhases: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Write one sanitized JSON evidence file per test, under the allowlisted evidence root.
 *
 * Every field is a bounded category, a count, a browser constant, or a sentence this file wrote
 * itself. Nothing here can be a host path, a URL, a header, a request body, or a learner value:
 * the observed phases come from a closed union of the state machine's eight cast phases, and the
 * notes are literals.
 */
export async function recordFishingEvidence(
  testInfo: TestInfo,
  project: string,
  reading: FishingRunReading,
): Promise<void> {
  const relative = evidenceRelativePath({
    runId: process.env.KD_COMPAT_RUN_ID ?? 'local-unknown',
    project,
    testTitle: testInfo.title,
  });
  await testInfo.attach('fishing-lane-reading.json', {
    body: JSON.stringify(reading, null, 2),
    contentType: 'application/json',
  });
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const root = repoRoot();
  await mkdir(dirname(join(root, relative)), { recursive: true });
  await writeFile(join(root, relative), `${JSON.stringify(reading, null, 2)}\n`, 'utf8');
}

/** The host OS, in the support matrix's own vocabulary, or `unknown`. */
export function hostOperatingSystem(): string {
  return normalizeHost(process.platform) ?? 'unknown';
}