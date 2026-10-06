/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { parseRuntimeConfig, type WorldRenderer } from './src/config/runtimeConfig';

function spriteManifestPlugin(): Plugin {
  const ASSETS_DIR = path.resolve(__dirname, 'public', 'assets');
  const MANIFEST_PATH = path.join(ASSETS_DIR, 'sprite-manifest.json');

  function generateManifest(): void {
    try {
      execSync('node scripts/generate-sprite-manifest.mjs', {
        cwd: __dirname,
        stdio: 'pipe',
      });
    } catch {
      // Non-fatal - the manifest script may not exist during initial setup
    }
  }

  return {
    name: 'sprite-manifest',
    configureServer(server) {
      generateManifest();
      server.watcher.add(path.join(ASSETS_DIR, '**', '*.svg'));
      server.watcher.on('add', (filePath) => {
        if (filePath.endsWith('.svg') && !filePath.includes('sprite-manifest')) {
          generateManifest();
        }
      });
      server.watcher.on('unlink', (filePath) => {
        if (filePath.endsWith('.svg') && !filePath.includes('sprite-manifest')) {
          generateManifest();
        }
      });
    },
    buildStart() {
      if (!fs.existsSync(MANIFEST_PATH)) {
        generateManifest();
      }
    },
  };
}

/**
 * ── Renderer chunking ──────────────────────────────────────────────────────
 *
 * Plan section 10.2 requires "no eager Phaser or Pixi load on Welcome", and global
 * working rule 9 requires world assets to stay lazy-loaded. A `manualChunks` group
 * is the mechanism for both: it names the engine's whole runtime as one chunk, so
 * "is Pixi in the bundle" and "did the Welcome route pull Pixi" become two different
 * questions with two different answers.
 *
 * The group is necessary but not sufficient. Vite emits a `<link rel=modulepreload>`
 * for every chunk statically reachable from the entry, so a Pixi host imported with a
 * plain `import` would sit in its own group and still be fetched on Welcome.
 * `rendererChunkBoundaryPlugin()` below is what makes the guarantee structural
 * rather than incidental: it walks the emitted import graph and fails the build when
 * the entry can reach a renderer chunk.
 */

export type RendererChunkFamily = 'phaser' | 'pixi';

/**
 * The `manualChunks` group name each renderer runtime is claimed into.
 *
 * These are prefixes, not content hashes, and every consumer in the repository
 * matches on them: `scripts/check-welcome-budget.mjs` excludes `vendor-phaser-*`
 * as a lazy renderer bundle, `tests/e2e/currentBuild.spec.ts` looks for
 * `vendor-phaser-*` by name, and `scripts/check-memory.mjs` refuses an eager Pixi
 * chunk by name. Renaming a value here therefore breaks three gates on purpose
 * rather than silently.
 */
export const RENDERER_CHUNK_PREFIX: Readonly<Record<RendererChunkFamily, string>> = Object.freeze({
  phaser: 'vendor-phaser',
  pixi: 'vendor-pixi',
});

/**
 * npm packages claimed into the Pixi chunk.
 *
 * `pixi.js` is a single package in v8 - the `@pixi/*` sub-packages were merged
 * back in at v8 and installing them separately is the v7 layout - so this is one
 * renderer dependency and not a family. The remaining entries are Pixi's own
 * transitive dependencies, listed so that a module shared between two engines
 * cannot be hoisted into a chunk the entry already imports. Claiming a package
 * that the current build never imports costs nothing: `manualChunks` only sees
 * modules that are in the graph, so the default Phaser build is unaffected by
 * entries that never appear in it.
 */
export const PIXI_VENDOR_PACKAGES: readonly string[] = Object.freeze([
  'pixi.js',
  '@pixi/colord',
  '@xmldom/xmldom',
  'earcut',
  'eventemitter3',
  'gifuct-js',
  'ismobilejs',
  'parse-svg-path',
  'tiny-lru',
]);

/** Splits on either separator, so a Windows checkout resolves the same package. */
const NODE_MODULES_SPLIT = /[\\/]node_modules[\\/]/;

/**
 * The npm package a module id belongs to, or `undefined` for project source.
 *
 * Written against the `node_modules/` boundary rather than a prefix match so that
 * a project file called `pixi-helpers.ts` or a directory called `phaser-notes`
 * cannot be claimed into a renderer group by accident.
 */
export function packageNameFromModuleId(id: string): string | undefined {
  const segments = id.split(NODE_MODULES_SPLIT);
  if (segments.length < 2) return undefined;
  const tail = segments[segments.length - 1].split(/[\\/]/);
  if (tail.length === 0 || tail[0] === '') return undefined;
  if (tail[0].startsWith('@')) {
    return tail.length >= 2 && tail[1] ? `${tail[0]}/${tail[1]}` : undefined;
  }
  return tail[0];
}

/**
 * ── The assistance lane census ──────────────────────────────────────────────
 *
 * {@link RENDERER_CHUNK_PREFIX} can assert the *presence* of a renderer because a
 * renderer is an npm package and a package can be claimed by name. Phase 19's
 * assistance code is project source, so there is no package to name, and the first
 * attempt to solve that by declaring a `manualChunks` group for it was **wrong in a way
 * worth recording**, because it cost headroom on the production build and the mistake is
 * the kind that looks correct in review:
 *
 * Claiming `src/core/assistance/` and `src/store/assistanceStore` into a manual group
 * made rolldown hoist every module **shared** between that group and the rest of the
 * graph into the group. `assistanceStore` imports `zustand`, `zustand` imports
 * `use-sync-external-store`, and React itself is shared with the entry - so
 * `node_modules/react/index.js` and `node_modules/react/cjs/react.production.js` moved
 * out of `vendor-react` and into the assistance group. The entry needs React, so
 * `index -> feature-assistance` became a **static** import edge, Vite wrote a
 * `<link rel="modulepreload">` for it, and every Welcome visitor downloaded 10.28 KiB of
 * assistance-group bytes on a build where `VITE_ADAPTIVE_ASSISTANCE` is `false`. That is
 * the same violation plan section 10.2 states for the renderer - "no eager Phaser or Pixi
 * load on Welcome" - applied to a feature, and it defeats the entire purpose of a
 * `productionDefault: false` cutover flag.
 *
 * So there is no assistance `manualChunks` group, and nothing below claims one. The lane
 * is identified the only way that cannot hoist anything: **by which module ids a chunk
 * contains**, read from the emitted bundle. That is a stronger identity than a chunk name
 * - it cannot be renamed, it cannot be satisfied by an unrelated chunk, and it needs no
 * bundler cooperation - and it is what lets the guard assert two different properties:
 * that the lane is *reachable* when the flag is on, and that it is *not statically
 * reachable* when the flag is off.
 */

/**
 * The module paths that must be present and fetchable for this build to count as carrying
 * the Phase 19 assistance lane. Both are required, and each is a **named load-bearing
 * module** rather than a directory.
 *
 * A learner is assisted by two things and neither is optional: the ranking
 * (`assistanceEngine`) and the state (`assistanceStore`). Naming the modules rather than the
 * directory is not fussiness - it is the difference between a check that works and one that is
 * satisfied by a type. Measured on the default build: `assistanceStore` imports
 * `@/core/assistance/types`, so a **directory**-level requirement is met by a chunk carrying
 * the vocabulary alone, and a build that shipped the store and never shipped the ranking would
 * pass. Naming `assistanceEngine` makes that build fail.
 *
 * Naming modules rather than directories is also what dissolves the tension between the
 * chunking question and this one. The dead-lane criterion is "is the ranking reachable and is
 * the state reachable", which says nothing about which chunk either lands in - so the
 * `manualChunks` group could be deleted outright, which is what fixes the eager preload,
 * without the guard losing any sensitivity. Before: "a chunk named `feature-assistance`
 * exists", which could not tell a live lane from a store-only build. Now: two named modules
 * are reachable, which can.
 *
 * Paths are repository-relative and POSIX, and matched against the project-source form of the
 * module id (see {@link projectSourcePath}) rather than the raw id, for the reason
 * {@link packageNameFromModuleId} documents. Each is a module **stem** prefix, so
 * `src/store/assistanceStore.test.ts` also matches - harmless, because a test module is never
 * in a production graph. A stem that stops matching is a loud failure: the build error names
 * the path and its role, and `tests/e2e/assistance-build-lane.test.ts` asserts both modules
 * still exist at these paths, so a rename is a red run in two places rather than a silently
 * weaker guard.
 */
export const ASSISTANCE_LANE_PATHS: readonly string[] = Object.freeze([
  'src/core/assistance/assistanceEngine',
  'src/store/assistanceStore',
]);

/**
 * What each entry of {@link ASSISTANCE_LANE_PATHS} is, for the build error message.
 *
 * A build failing on a path it has never heard of learns nothing from the path alone. This
 * map is the difference between "src/core/assistance/assistanceEngine is unreachable" and
 * "the ranking is unreachable", and it is also what makes a future rename diagnosable from the
 * build log instead of only from the source.
 */
export const ASSISTANCE_LANE_ROLE: Readonly<Record<string, string>> = Object.freeze({
  'src/core/assistance/assistanceEngine': 'the ranking',
  'src/store/assistanceStore': 'the state',
});

/**
 * The repository-relative project-source path for a module id, or `undefined` for a
 * dependency.
 *
 * Two separations are load-bearing:
 *
 * - A module id containing `node_modules` is never project source, whatever it is called. A
 *   dependency whose own source directory is named `src/core/assistance` is not part of
 *   this project's assistance lane.
 * - A module id may be absolute (`/repo/src/core/assistance/assistanceEngine.ts`), root
 *   relative (`/src/core/assistance/assistanceEngine.ts`), or carry a query suffix, so the
 *   tail after the *last* `/src/` is normalised to one `src/`-prefixed form and all three
 *   spellings compare equal.
 *
 * Returning `undefined` for anything outside `src/` keeps the predicate unable to reach a
 * file the project did not write.
 */
export function projectSourcePath(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/').split(/[?#]/, 1)[0] as string;
  if (normalized.includes('/node_modules/') || normalized.startsWith('node_modules/')) {
    return undefined;
  }
  const match = /(?:^|\/)src\/(.+)$/.exec(normalized);
  return match ? `src/${match[1]}` : undefined;
}

/** The declared lane path a module id belongs to, or `undefined` for a non-lane module. */
export function assistanceLanePathFor(id: string): string | undefined {
  const sourcePath = projectSourcePath(id);
  if (sourcePath === undefined) return undefined;
  return ASSISTANCE_LANE_PATHS.find((prefix) => sourcePath.startsWith(prefix));
}

/**
 * The `manualChunks` group for a module id, or `undefined` to leave it alone.
 *
 * The order is the order the groups are tested, and Phaser is tested first
 * because its predicate is the pre-existing substring test and changing its
 * precedence would change the current production artifact.
 *
 * Every group here is a **vendor** group, and that is the rule this file learned the
 * expensive way: a `manualChunks` group takes its shared dependencies with it. See the
 * header of the assistance lane census for the measured 10.28 KiB. A future phase that
 * needs a project-source feature group must identify it by module membership in the
 * emitted bundle, not by claiming it into a chunk here.
 */
export function manualChunkFor(id: string): string | undefined {
  if (id.includes('phaser')) {
    return RENDERER_CHUNK_PREFIX.phaser;
  }
  const packageName = packageNameFromModuleId(id);
  if (packageName !== undefined && PIXI_VENDOR_PACKAGES.includes(packageName)) {
    return RENDERER_CHUNK_PREFIX.pixi;
  }
  if (
    id.includes('/node_modules/react/') ||
    id.includes('/node_modules/react-dom/') ||
    id.includes('/node_modules/scheduler/')
  ) {
    return 'vendor-react';
  }
  return undefined;
}

/* ── Emitted-bundle audit ─────────────────────────────────────────────────── */

export interface EmittedChunk {
  readonly fileName: string;
  readonly type?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  /**
   * Module ids in this chunk, keyed by id - Rollup's `OutputChunk.modules`.
   *
   * The lane census is the only reader. {@link EmittedChunk} is declared here rather than
   * importing Rollup's type because this module is loaded by Vite's own config pipeline and
   * by Vitest, and a structural declaration keeps both from having to agree on a bundler
   * type package. A chunk that omits `modules` - a fixture, or a bundler that declines to
   * report them - yields "this chunk contains no lane modules", which is the safe reading:
   * a lane cannot be proved by a chunk whose contents are unknown.
   */
  readonly modules?: Readonly<Record<string, unknown>>;
}

export type EmittedBundle = Readonly<Record<string, EmittedChunk>>;

/**
 * The renderer chunk family a file name belongs to, or `undefined`.
 *
 * Matched as `name` or `name-<hash>` so the family survives content hashing and
 * the `-legacy-` re-emission without the pattern ever matching a content hash by
 * accident.
 */
export function rendererChunkFamily(fileName: string): RendererChunkFamily | undefined {
  const base = path.posix.basename(fileName.replace(/\\/g, '/'));
  for (const [family, prefix] of Object.entries(RENDERER_CHUNK_PREFIX) as ReadonlyArray<
    [RendererChunkFamily, string]
  >) {
    if (base === prefix || base.startsWith(`${prefix}-`)) return family;
  }
  return undefined;
}

/**
 * ── The share lane census ───────────────────────────────────────────────────
 *
 * Phase 20 adds a second feature lane behind a second `productionDefault: false` flag,
 * and the census above already answers every question it needs answered - which modules a
 * chunk carries, whether the entry reaches that chunk statically, and whether a browser can
 * reach it at all. So this is a **declaration**, not a second implementation:
 * {@link SHARE_LANE_PATHS} names the Phase 20 modules and {@link auditShareLane} calls the
 * same {@link auditFeatureLane}. One census, two lanes. Duplicating it would give the two
 * lanes two chances to disagree about what "statically reachable" means, which is exactly
 * the class of drift a shared helper exists to prevent.
 *
 * Three named modules, and each is load-bearing:
 *
 * - `shareCardPolicy` - **the field-selection policy**. It decides which of a learner's own
 *   data may appear. Plan section 9 and the phase exit criteria both reduce to "no notes, no
 *   internal ids, no room lists, no assistance history by default", and this module is where
 *   that is decided. A build that shipped the dialog and the renderer without it shipped an
 *   unguarded card. It lives in `src/core/share/` rather than `src/ui/share/` because that is
 *   where the renderer-neutral policy belongs, and this declaration follows the code rather
 *   than a pre-phase guess about where it would land.
 * - `renderShareCard` - **the card image**. It turns the card model into PNG bytes. A lane
 *   that shipped the policy and the dialog and never shipped this shipped no card.
 * - `ShareCardDialog` - **the preview and the explicit action**. Plan section 9 requires a
 *   preview before delivery and Web Share only after an explicit user action, and both live
 *   in the surface a learner opens on purpose.
 *
 * ### Two neighbouring modules deliberately not named
 *
 * `src/core/share/types.ts` is the **vocabulary**, and `src/core/share/shareCardModel.ts` is
 * the **model** that `renderShareCard` must consume in order to draw anything at all. Both are
 * therefore dragged into any chunk that carries the lane, for free, by an import the renderer
 * needs regardless. Naming either would add no sensitivity: a chunk satisfying the declaration
 * above already carries them. That is the exact shape of the trap `ASSISTANCE_LANE_PATHS`
 * documents, where a **directory**-level requirement was met by a `types.ts` the store
 * imported, so a build that never shipped the ranking passed. What makes this declaration
 * sensitive is that the three named modules are the ones nothing else drags in.
 *
 * Each is named as a module **stem**, for the same reason the assistance lane names modules
 * rather than directories: a directory-level requirement is satisfied by whatever a neighbour
 * drags in, and a lane that ships the vocabulary without the thing that matters is the Phase
 * 17 dead lane wearing a different hat.
 *
 * ## The structural demand this places on the Phase 20 code
 *
 * Stated here rather than left in a report, because it is load-bearing for the build:
 * **every module in {@link SHARE_LANE_PATHS} must be reached through a dynamic import.**
 *
 * The measured reason is this repository's current shape: the whole application core - the
 * router, `GameScreen`, `InventoryBadgesPanel` - is emitted into a **single** entry chunk,
 * `index-DXLHFk3w.js`, at `23a0e0f`. There is no route-aware split behind it. So "somewhere
 * statically reachable" and "in the entry chunk" are the same statement today, and a plain
 * `import` from any of it makes the module eager. Check 2 below enforces this on the default
 * build, which is the same trade the assistance lane made and the same fix: a lazily opened
 * dialog is precisely what `React.lazy` is for, and everything under the lane becomes lazy
 * with it.
 *
 * ## "Retain local PNG download" is compatible with this, and here is why
 *
 * The phase rollback is "set `VITE_WEB_SHARE=false` and retain local PNG download", and the
 * download path genuinely needs {@link SHARE_LANE_PATHS}' policy to stay privacy-correct with
 * the flag **off**. That is not a contradiction, because check 2 constrains **static**
 * reachability only. A module reached by `await import('@/core/share/shareCardPolicy')` from
 * the download handler is reachable with the flag off, is fetched the moment a learner clicks
 * Share, and costs no Welcome visitor a byte. Both checks together therefore say: the lane
 * must work with the flag off, and must not be *downloaded* with the flag off.
 *
 * ## What is deliberately *not* a lane module
 *
 * `src/ui/utils/progressionShareExport.ts` is the legacy exporter, and it is **already**
 * eagerly reachable at `23a0e0f` - `GameScreen` imports `InventoryBadgesPanel`, which imports
 * it, so it is inside the entry chunk today. Declaring it a lane path would make the default
 * build red for a condition Phase 20 did not create and did not cause, and it is the wrong
 * subject anyway: the phase's own rollback line is the thing that must keep working when this
 * flag is off. Gating the thing rollback requires to survive would invert the rollback. It is
 * reported as a measured observation in the Phase 20 record instead.
 */
export const SHARE_LANE_PATHS: readonly string[] = Object.freeze([
  'src/core/share/shareCardPolicy',
  'src/ui/share/renderShareCard',
  'src/ui/share/ShareCardDialog',
]);

/**
 * What each entry of {@link SHARE_LANE_PATHS} is, for the build error message.
 *
 * Same job as {@link ASSISTANCE_LANE_ROLE}: a build failing on a path nobody has heard of
 * teaches nothing from the path alone.
 */
export const SHARE_LANE_ROLE: Readonly<Record<string, string>> = Object.freeze({
  'src/core/share/shareCardPolicy': 'the field-selection policy',
  'src/ui/share/renderShareCard': 'the card image',
  'src/ui/share/ShareCardDialog': 'the preview and the explicit action',
});

/** The declared share lane path a module id belongs to, or `undefined` for a non-lane module. */
export function shareLanePathFor(id: string): string | undefined {
  const sourcePath = projectSourcePath(id);
  if (sourcePath === undefined) return undefined;
  return SHARE_LANE_PATHS.find((prefix) => sourcePath.startsWith(prefix));
}

/**
 * The lane census, for one declared lane.
 *
 * Two facts per chunk that contains lane code, and both are read from the emitted bundle
 * rather than inferred from a chunk name:
 *
 * - `staticReachable` - in the entry's **static** closure, which is the set Vite writes
 *   `modulepreload` links for and therefore the set a Welcome visitor downloads whether or
 *   not the feature is switched on.
 * - `fetchable` - in the entry's **fetchable** closure, which additionally follows dynamic
 *   imports. A chunk reachable only dynamically is a working lazy lane, not a dead one.
 *
 * `lanePaths` records which of the lane's declared paths the chunk actually carries, so a
 * build that shipped the engine without the store is distinguishable from one that shipped
 * neither.
 */
export interface FeatureLaneCensusEntry {
  readonly fileName: string;
  /** The declared lane paths present in this chunk. */
  readonly lanePaths: readonly string[];
  /** In the module entry's static closure - Vite emits a `modulepreload` for these. */
  readonly staticReachable: boolean;
  /** In the module entry's closure following `imports` and `dynamicImports`. */
  readonly fetchable: boolean;
}

export interface FeatureLaneAudit {
  /** Entry chunks of the module bundle, the release path. */
  readonly moduleEntryChunks: readonly string[];
  /** Every chunk carrying at least one lane module, sorted. */
  readonly laneChunks: readonly FeatureLaneCensusEntry[];
  /**
   * Lane paths carried by at least one **fetchable** chunk, in declaration order.
   *
   * A flagged build has to cover every declared lane path here; that is the whole of the
   * dead-lane criterion.
   */
  readonly fetchableLanePaths: readonly string[];
  /**
   * Lane paths carried by at least one chunk the module entry **statically** reaches. Every
   * one of these is bytes a Welcome visitor downloads before any application code runs.
   */
  readonly eagerLanePaths: readonly string[];
}

/** The Phase 19 lane's audit shape. The same census, so the same type. */
export type AssistanceLaneAudit = FeatureLaneAudit;

/** The Phase 20 lane's audit shape. The same census, so the same type. */
export type ShareLaneAudit = FeatureLaneAudit;

/**
 * Audits an emitted bundle for one declared feature lane.
 *
 * Unlike the renderer census this does **not** need a `manualChunks` group to find its
 * chunks, and that is the point: a group would let the bundler decide what else ends up in
 * the same file, which is how 13 unrelated modules - including React itself - came to be
 * shipped as "assistance". Module membership cannot be influenced by the bundler.
 *
 * `lanePathFor` is the lane's own membership predicate, and `lanePaths` is its own
 * declaration. Passing them in rather than reading a module-level constant is what lets one
 * implementation serve both lanes without either of them being able to claim the other's
 * modules.
 *
 * Deterministic in both senses that matter: `laneChunks` is sorted by file name and every
 * derived list is returned in declaration order, so the line printed on every build is
 * byte-stable and a diff of two runs is meaningful.
 */
export function auditFeatureLane(
  bundle: EmittedBundle,
  lanePaths: readonly string[],
  lanePathFor: (id: string) => string | undefined,
): FeatureLaneAudit {
  const moduleEntryChunks = Object.values(bundle)
    .filter((chunk) => chunk.type !== 'asset' && chunk.isEntry === true)
    .map((chunk) => chunk.fileName)
    .filter((fileName) => !isLegacyEmission(fileName))
    .sort();

  const staticClosure = collectStaticClosure(bundle, moduleEntryChunks);
  const fetchableClosure = collectFetchableClosure(bundle, moduleEntryChunks);

  const laneChunks: FeatureLaneCensusEntry[] = [];
  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (chunk.type === 'asset') continue;
    const carried = [
      ...new Set(
        Object.keys(chunk.modules ?? {})
          .map((id) => lanePathFor(id))
          .filter((lanePath): lanePath is string => lanePath !== undefined),
      ),
    ].sort();
    if (carried.length === 0) continue;
    laneChunks.push({
      fileName,
      lanePaths: carried,
      staticReachable: staticClosure.has(fileName),
      fetchable: fetchableClosure.has(fileName),
    });
  }
  laneChunks.sort((a, b) => a.fileName.localeCompare(b.fileName));

  const carriedBy = (predicate: (entry: FeatureLaneCensusEntry) => boolean): string[] =>
    lanePaths.filter((lanePath) =>
      laneChunks.some((entry) => predicate(entry) && entry.lanePaths.includes(lanePath)),
    );

  return {
    moduleEntryChunks,
    laneChunks,
    fetchableLanePaths: carriedBy((entry) => entry.fetchable),
    eagerLanePaths: carriedBy((entry) => entry.staticReachable),
  };
}

/** Audits an emitted bundle for the Phase 19 assistance lane. See {@link auditFeatureLane}. */
export function auditAssistanceLane(bundle: EmittedBundle): AssistanceLaneAudit {
  return auditFeatureLane(bundle, ASSISTANCE_LANE_PATHS, assistanceLanePathFor);
}

/** Audits an emitted bundle for the Phase 20 share lane. See {@link auditFeatureLane}. */
export function auditShareLane(bundle: EmittedBundle): ShareLaneAudit {
  return auditFeatureLane(bundle, SHARE_LANE_PATHS, shareLanePathFor);
}

/**
 * The chunks statically reachable from `roots`, following `imports` only.
 *
 * This is the same edge set Vite uses to decide what to put in
 * `<link rel=modulepreload>` in the entry document: a modulepreload link is
 * emitted for a statically imported chunk of the entry and for its statically
 * imported chunks in turn. So the closure computed here and the set of chunk
 * files named by `dist/index.html` describe the same graph, and "the entry can
 * reach this chunk" is the same statement as "the browser fetches this chunk
 * before any application code has run".
 *
 * `dynamicImports` is deliberately not followed. A dynamic import is the whole
 * mechanism plan section 10.2 relies on, and reaching a renderer through one is
 * the intended outcome rather than a violation.
 *
 * {@link collectFetchableClosure} is the other half: it follows both edge kinds, and
 * answers "can the browser get to this chunk at all" rather than "does it fetch it
 * unprompted".
 */
export function collectStaticClosure(bundle: EmittedBundle, roots: Iterable<string>): Set<string> {
  return collectClosure(bundle, roots, (chunk) => chunk.imports ?? []);
}

/**
 * The chunks reachable from `roots` through `imports` **or** `dynamicImports`.
 *
 * This is the looser of the two closures and answers a different question: not "what does
 * the entry download before any code runs" but "what could a browser fetch once the
 * application is running". It is the right closure for asking whether a lane is *live* - a
 * dead lane is one no sequence of user actions can ever reach, and a dynamic import is
 * exactly the mechanism that makes it reachable.
 */
export function collectFetchableClosure(
  bundle: EmittedBundle,
  roots: Iterable<string>,
): Set<string> {
  return collectClosure(bundle, roots, (chunk) => [
    ...(chunk.imports ?? []),
    ...(chunk.dynamicImports ?? []),
  ]);
}

function collectClosure(
  bundle: EmittedBundle,
  roots: Iterable<string>,
  edgesOf: (chunk: EmittedChunk) => readonly string[],
): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    const chunk = bundle[next];
    // An asset (a font, an image, the HTML file itself) has no import edge and
    // cannot extend the graph.
    if (!chunk || chunk.type === 'asset') continue;
    seen.add(next);
    for (const imported of edgesOf(chunk)) {
      if (!seen.has(imported)) queue.push(imported);
    }
  }
  return seen;
}

export interface RendererChunkCensusEntry {
  readonly family: RendererChunkFamily;
  readonly fileName: string;
  /** Statically reachable from a module (non-`nomodule`) entry chunk. */
  readonly entryReachable: boolean;
  /** Statically registered by a `System.register` entry in the ES5 fallback bundle. */
  readonly legacyEager: boolean;
}

export interface RendererChunkAudit {
  /** Entry chunks the audit found, module bundle first then ES5 fallback. */
  readonly entryChunks: readonly string[];
  /** Entry chunks of the module bundle - the release path. */
  readonly moduleEntryChunks: readonly string[];
  /** Entry chunks of the ES5 `nomodule` fallback bundle. */
  readonly legacyEntryChunks: readonly string[];
  /** Chunks statically reachable from the module entries. */
  readonly entryClosure: readonly string[];
  /** Every chunk that belongs to a renderer group, sorted. */
  readonly rendererChunks: readonly RendererChunkCensusEntry[];
  /** Renderer chunks the module entry can statically reach. */
  readonly eagerRendererChunks: readonly RendererChunkCensusEntry[];
  /** Pixi chunks the module entry can statically reach. This is the violation. */
  readonly eagerPixiChunks: readonly RendererChunkCensusEntry[];
  /** Whether a module (non-`nomodule`) entry chunk was found. */
  readonly hasModuleEntry: boolean;
  /** True when no module entry chunk can reach any Pixi chunk. */
  readonly pixiIsLazy: boolean;
}

/**
 * The ES5 re-emission `@vitejs/plugin-legacy` produces for `nomodule` scripts.
 *
 * The suffix carries a content hash, so the pattern anchors on the literal
 * `-legacy-` marker immediately before the extension rather than on the hash.
 */
export function isLegacyEmission(fileName: string): boolean {
  return /-legacy-[^/]*\.[a-z0-9]+$/i.test(fileName.replace(/\\/g, '/'));
}

/**
 * Family-then-file-name ordering, shared by the renderer and feature censuses.
 *
 * The family is compared as a `string` rather than as its literal union on purpose. A
 * single-member union such as `FeatureChunkFamily = 'assistance'` makes
 * `a.family === b.family` always true, so TypeScript narrows the other arm to `never` and
 * `a.family.localeCompare(...)` stops compiling. That would force either a `String()`
 * cast at every comparison or a comparator that only works while a family has one member -
 * and the second option fails the moment a phase adds the next family, which is the
 * change that would be least welcome as a type error.
 */
function byFamilyThenFileName<E extends { readonly family: string; readonly fileName: string }>(
  a: E,
  b: E,
): number {
  return a.family === b.family
    ? a.fileName.localeCompare(b.fileName)
    : a.family.localeCompare(b.family);
}

/**
 * Audits an emitted bundle for the renderer chunk boundary. See `collectStaticClosure`.
 *
 * Both bundles in a `@vitejs/plugin-legacy` build are separated, because they
 * behave differently and only one of them ships to a supported browser:
 *
 * - The **module** bundle is the release path. Plan section 2.5's engine matrix is
 *   Chromium, Firefox, and WebKit, and plan section 10.2's Welcome budget
 *   explicitly declines to count the `nomodule` bundle "the release path is web on
 *   Chromebook, desktop browsers, and tablets, all of which support ES modules".
 *   The eager-Pixi rule is applied here and only here.
 * - The **ES5 fallback** bundle is re-emitted by the legacy plugin into the SystemJS
 *   module format, and `System.register` declares its dependencies in the module's
 *   own argument list. A dynamic import therefore appears there as a static
 *   registration whether the source wrote `import()` or `require()`. That is a
 *   property of the SystemJS output format, not of the application's import graph,
 *   so it is counted and reported rather than failed. No browser in the plan's
 *   support matrix executes it.
 *
 * Splitting the two is also what keeps the audit non-vacuous in either pass: a build
 * emits exactly one module bundle and one legacy bundle, and a bundle with no module
 * entry is reported as "not audited" rather than as a pass.
 *
 * The census is two independent passes over the same bundle: `rendererChunks` for the
 * engines, and {@link auditAssistanceLane} for the Phase 19 feature lane. They share the
 * entry-closure computation and nothing else, because they answer different questions - a
 * renderer chunk the entry can reach is a plan section 10.2 violation, while a lane chunk's
 * reachability is a dead-lane finding that depends on the flag set for this build.
 */
export function auditRendererChunkBoundary(bundle: EmittedBundle): RendererChunkAudit {
  const entryChunks = Object.values(bundle)
    .filter((chunk) => chunk.type !== 'asset' && chunk.isEntry === true)
    .map((chunk) => chunk.fileName)
    .sort();

  const moduleEntryChunks = entryChunks.filter((fileName) => !isLegacyEmission(fileName));
  const legacyEntryChunks = entryChunks.filter((fileName) => isLegacyEmission(fileName));

  const entryClosure = new Set(collectStaticClosure(bundle, moduleEntryChunks));
  const legacyClosure = new Set(collectStaticClosure(bundle, legacyEntryChunks));

  const rendererChunks: RendererChunkCensusEntry[] = [];
  for (const fileName of Object.keys(bundle)) {
    const family = rendererChunkFamily(fileName);
    if (family === undefined) continue;
    rendererChunks.push({
      family,
      fileName,
      entryReachable: entryClosure.has(fileName),
      legacyEager: legacyClosure.has(fileName),
    });
  }
  rendererChunks.sort(byFamilyThenFileName);

  const eagerRendererChunks = rendererChunks.filter((entry) => entry.entryReachable);
  const eagerPixiChunks = eagerRendererChunks.filter((entry) => entry.family === 'pixi');

  return {
    entryChunks,
    moduleEntryChunks,
    legacyEntryChunks,
    entryClosure: [...entryClosure].sort(),
    rendererChunks,
    eagerRendererChunks,
    eagerPixiChunks,
    hasModuleEntry: moduleEntryChunks.length > 0,
    pixiIsLazy: eagerPixiChunks.length === 0,
  };
}

export interface RendererChunkBoundaryOptions {
  /**
   * The renderer this build was asked for, from `VITE_WORLD_RENDERER`.
   *
   * Used for one check only: a build that asks for Pixi and emits no Pixi chunk
   * has not been switched to Pixi, it has only had a variable set. That is
   * reported as a failure rather than as a passing run that measured nothing.
   */
  readonly worldRenderer: WorldRenderer;
  /**
   * Whether this build was asked for the PixiJS Village, from `VITE_PIXI_VILLAGE`.
   *
   * Optional and additive, so every existing caller - including the Phase 9
   * switch tests, which construct options with `worldRenderer` alone - keeps
   * compiling and keeps its current behaviour. `undefined` is treated exactly as
   * `false`: the default production build is unaffected.
   *
   * Used for the same single check as `worldRenderer`, independent of it: a build
   * that asks for the Pixi village and emits no Pixi chunk has not been switched,
   * it has only had a variable set. `VITE_WORLD_RENDERER` stays `phaser` for that
   * build (the village is the only thing turned on), so the renderer check cannot
   * cover it.
   */
  readonly pixiVillage?: boolean;
  /**
   * Whether this build was asked for the PixiJS Dungeon, from `VITE_PIXI_DUNGEON`.
   *
   * Optional and additive, for the same reason as `pixiVillage`: every existing caller
   * keeps compiling and keeps its current behaviour, and `undefined` is treated exactly
   * as `false`.
   *
   * Independent of both other checks, and necessary because of it: `build:web:pixi-dungeon`
   * leaves `VITE_WORLD_RENDERER=phaser`, so the Phase 9 renderer check cannot cover it, and
   * a build that asked for the dungeon and emitted no Pixi chunk has set a variable and
   * read nothing - the shape of a check that measures nothing.
   */
  readonly pixiDungeon?: boolean;
  /**
   * Whether this build was asked for the PixiJS fishing pond, from `VITE_PIXI_FISHING`.
   *
   * Optional and additive, for the same reason as `pixiDungeon`, and necessary for the
   * same reason: `build:web:pixi-fishing` leaves `VITE_WORLD_RENDERER=phaser`,
   * `VITE_PIXI_VILLAGE` unset, and `VITE_PIXI_DUNGEON` unset, so none of the three
   * existing checks can cover it. A fishing-flagged build that emitted no Pixi chunk set a
   * build-time variable and read nothing, which is the shape of a check that reports
   * success because it measured nothing. `undefined` is treated exactly as `false`, so
   * every existing caller - including the Phase 9 switch tests, which construct options
   * with `worldRenderer` alone - keeps compiling and keeps its current behaviour.
   */
  readonly pixiFishing?: boolean;
  /**
   * Whether this build was asked for adaptive learner assistance, from
   * `VITE_ADAPTIVE_ASSISTANCE`.
   *
   * Optional and additive, for the same reason as `pixiFishing`, and `undefined` is
   * treated exactly as `false` so every existing caller keeps compiling and keeps its
   * current behaviour.
   *
   * This one is not a renderer switch, so it is independent of all four above in a stronger
   * sense than "the build script happens to leave them off": `build:web:assistance` turns on
   * exactly one flag and turns on **no** renderer, so there is no Pixi chunk to look for and
   * looking for one would be checking the wrong question.
   *
   * It drives two checks that are mirror images of each other, both stated over the
   * {@link ASSISTANCE_LANE_PATHS} module census rather than over a chunk name:
   *
   * - **on** - every declared lane path must be carried by a chunk the entry graph can
   *   actually reach. A lane that is emitted but never fetched is the Phase 17 dead lane.
   * - **off**, or unset, i.e. the production default - the entry must not *statically* reach
   *   any lane code, because a static edge becomes a `modulepreload` that every Welcome
   *   visitor downloads regardless of what the flag says.
   */
  readonly adaptiveAssistance?: boolean;
  /**
   * Whether this build was asked for explicit-action Web Share, from `VITE_WEB_SHARE`.
   *
   * Optional and additive for the same reason as `adaptiveAssistance`, and `undefined` is
   * treated exactly as `false` so every existing caller keeps compiling and keeps its current
   * behaviour.
   *
   * The second of two feature-lane flags, and the second lane the census serves. It drives
   * the same two mirror-image checks, stated over {@link SHARE_LANE_PATHS}:
   *
   * - **on** - every declared share lane path must be carried by a chunk the entry graph can
   *   actually reach. A `build:web:share` that contains no share code is a red build, not a
   *   green lane: this is the Phase 17 dead lane.
   * - **off**, or unset, i.e. the production default - the entry must not *statically* reach
   *   any lane module, because a static edge becomes a `modulepreload` in `dist/index.html`
   *   and every Welcome visitor downloads those bytes whatever the flag says.
   */
  readonly webShare?: boolean;
}

/**
 * Fails the build when the entry document can statically reach a renderer chunk.
 *
 * Two findings, both errors:
 *
 * 1. **A Pixi chunk in the entry's static closure.** This is the plan section 10.2
 *    rule the phase is about. Vite emits a `modulepreload` for every such chunk,
 *    so the Welcome route would fetch the Pixi runtime before running a line of
 *    application code.
 * 2. **A build that asked for something and emitted nothing for it.** Reached by
 *    `VITE_WORLD_RENDERER=pixi` (the Phase 9 renderer switch), and additively by
 *    `VITE_PIXI_VILLAGE=true` (the Phase 11 village switch), `VITE_PIXI_DUNGEON=true`
 *    (the Phase 13 dungeon switch), `VITE_PIXI_FISHING=true` (the Phase 17 fishing
 *    switch), and `VITE_ADAPTIVE_ASSISTANCE=true` (the Phase 19 assistance lane). Each is
 *    a build-time contract that CI has to exercise, and a switched build that contains no
 *    switched renderer is the shape of a check that reports success because it measured
 *    nothing. The first four are independent because each of those build scripts leaves
 *    `VITE_WORLD_RENDERER=phaser`: the renderer check cannot cover any of them.
 *
 * 3. **Assistance code the entry document can statically reach.** The mirror of finding 2,
 *    and only on a build with the flag at its production default - see
 *    {@link auditAssistanceLane}. A feature behind a cutover flag that is *eagerly fetched
 *    while switched off* spends the Welcome budget on a disabled feature, which is the same
 *    class of problem as finding 1 and defeats the flag.
 *
 * The Phaser side is reported rather than enforced. `vendor-phaser-*` is already
 * named by the entry document's `modulepreload` links in the current production
 * build - Phaser is statically imported by `src/game/**` today - and changing
 * that is a renderer migration decision, not a chunking one. The census prints it
 * on every build so the pre-existing eager Phaser fetch stays visible instead of
 * being discovered later.
 */
export function rendererChunkBoundaryPlugin(options: RendererChunkBoundaryOptions): Plugin {
  return {
    name: 'knowledge-dungeon:renderer-chunk-boundary',
    // `writeBundle`, not `generateBundle`.
    //
    // `@vitejs/plugin-legacy` re-emits the whole application as `-legacy-*` chunks
    // from its own pass, and every `generateBundle` hook in this plugin array is
    // reached inside that pass: verified against Vite 8.0.14 / Rolldown, a hook at
    // either plugin precedence sees exactly the twenty-two `*-legacy-*.js` files and
    // not one modern chunk, so a `generateBundle` audit would be auditing the ES5
    // fallback and nothing else. `writeBundle` runs once per completed bundle, so
    // this audits the module bundle, and the legacy bundle when the plugin runs its
    // own pass - which is a second, independent check of the same application graph
    // rather than an exemption from the first.
    writeBundle(_outputOptions, bundle) {
      const audit = auditRendererChunkBoundary(bundle as EmittedBundle);
      const report = (line: string): void => {
        // One prefix so the block is greppable out of a long Vite log.
        console.log(`[renderer-chunks] ${line}`);
      };
      // A bundle is the ES5 re-emission when every entry it emitted carries the
      // `-legacy-` marker. Classified on the legacy entries rather than on the
      // absence of module entries, so a bundle that emitted no entry at all is not
      // mistaken for one that emitted only legacy entries.
      const isLegacyBundle =
        audit.legacyEntryChunks.length > 0 && audit.moduleEntryChunks.length === 0;

      report(
        `${isLegacyBundle ? 'ES5 nomodule bundle' : 'module bundle'}; entry chunks: ` +
          (audit.entryChunks.length > 0 ? audit.entryChunks.join(', ') : '(none found)'),
      );
      if (!isLegacyBundle) {
        report(`statically reachable from the module entry: ${audit.entryClosure.length} chunk(s)`);
      }
      for (const family of Object.keys(RENDERER_CHUNK_PREFIX) as RendererChunkFamily[]) {
        const total = audit.rendererChunks.filter((entry) => entry.family === family);
        const eager = isLegacyBundle
          ? total.filter((entry) => entry.legacyEager)
          : audit.eagerRendererChunks.filter((entry) => entry.family === family);
        report(
          `${RENDERER_CHUNK_PREFIX[family]}: ${total.length} chunk(s), ${eager.length} ` +
            (isLegacyBundle ? 'System.register dependencies' : 'statically reachable from the entry'),
        );
      }

      if (isLegacyBundle) {
        // Reported above, never failed. See `auditRendererChunkBoundary`: the SystemJS
        // output format registers every chunk statically, including ones the source
        // reached with `import()`, and no browser in plan section 2.5's matrix runs
        // this bundle.
        return;
      }

      if (!audit.hasModuleEntry) {
        // A bundle that emitted no entry of either kind is unbuildable, and a gate
        // that cannot find the graph it was asked to audit does not get to pass.
        this.error(
          '[renderer-chunks] no module entry chunk was emitted, so the renderer chunk boundary was not checked. ' +
            'A build that cannot be audited is not a passing build.',
        );
        return;
      }

      if (audit.eagerPixiChunks.length > 0) {
        this.error(
          [
            '[renderer-chunks] the entry document can statically reach the Pixi runtime, which plan section 10.2 forbids.',
            `Statically reachable Pixi chunk(s): ${audit.eagerPixiChunks.map((entry) => entry.fileName).join(', ')}.`,
            'Vite emits a <link rel="modulepreload"> for each of these, so the Welcome route would download Pixi before any application code runs.',
            'Reach the Pixi host through a dynamic import (React.lazy, or await import()) so the router, not the entry, decides when it loads.',
          ].join('\n'),
        );
        return;
      }

      if (
        options.worldRenderer === 'pixi' &&
        audit.rendererChunks.every((entry) => entry.family !== 'pixi')
      ) {
        this.error(
          [
            '[renderer-chunks] VITE_WORLD_RENDERER=pixi, but this build contains no Pixi chunk.',
            'The renderer switch set a build-time variable and nothing read it, so there is no Pixi artifact to verify.',
            'Wire the Pixi host into routing under the flag, or build with VITE_WORLD_RENDERER=phaser until the host exists.',
          ].join('\n'),
        );
      }

      // The Phase 11 village switch, enforced independently of the renderer one.
      //
      // Guarded on `worldRenderer !== 'pixi'` only to keep the two checks from
      // printing the same finding twice on a hypothetical build that sets both. On
      // `build:web:pixi-village` this is the check that fires: that script leaves
      // `VITE_WORLD_RENDERER=phaser`, so the renderer check above cannot cover it.
      if (
        options.pixiVillage === true &&
        options.worldRenderer !== 'pixi' &&
        audit.rendererChunks.every((entry) => entry.family !== 'pixi')
      ) {
        this.error(
          [
            '[renderer-chunks] VITE_PIXI_VILLAGE=true, but this build contains no Pixi chunk.',
            'The village switch set a build-time variable and nothing read it, so there is no Pixi village artifact to verify.',
            'Wire the Pixi village host into the village route under the flag, or build without VITE_PIXI_VILLAGE until the host exists.',
          ].join('\n'),
        );
      }

      // The Phase 13 dungeon switch, enforced independently of the other two.
      //
      // `build:web:pixi-dungeon` leaves both `VITE_WORLD_RENDERER=phaser` and
      // `VITE_PIXI_VILLAGE` unset, so neither of the checks above can cover it. A build
      // that asked for the dungeon and emitted no Pixi chunk is the failure mode this
      // exists for: the flag set a variable nothing read, and the lane verified nothing.
      if (
        options.pixiDungeon === true &&
        options.worldRenderer !== 'pixi' &&
        audit.rendererChunks.every((entry) => entry.family !== 'pixi')
      ) {
        this.error(
          [
            '[renderer-chunks] VITE_PIXI_DUNGEON=true, but this build contains no Pixi chunk.',
            'The dungeon switch set a build-time variable and nothing read it, so there is no Pixi dungeon artifact to verify.',
            'Wire the Pixi dungeon host into the dungeon route under the flag, or build without VITE_PIXI_DUNGEON until the host exists.',
          ].join('\n'),
        );
      }

      // The Phase 17 fishing switch, enforced independently of the other three.
      //
      // `build:web:pixi-fishing` turns on exactly one flag and leaves every other switch at
      // its production default, so neither the renderer check, the village check, nor the
      // dungeon check can cover it. The failure mode is the same one this block exists for:
      // a build that asked for the pond and emitted no Pixi chunk has set a variable nothing
      // read, and the lane would then verify nothing.
      if (
        options.pixiFishing === true &&
        options.worldRenderer !== 'pixi' &&
        audit.rendererChunks.every((entry) => entry.family !== 'pixi')
      ) {
        this.error(
          [
            '[renderer-chunks] VITE_PIXI_FISHING=true, but this build contains no Pixi chunk.',
            'The fishing switch set a build-time variable and nothing read it, so there is no Pixi fishing artifact to verify.',
            'Wire the Pixi fishing host into the village route under the flag, or build without VITE_PIXI_FISHING until the host exists.',
          ].join('\n'),
        );
      }

      // The Phase 19 assistance lane, enforced independently of all four renderer switches
      // and for a different reason.
      //
      // `build:web:assistance` turns on exactly one flag and turns on **no** renderer, so a
      // Pixi-chunk check would report on a switch nobody set. There is no assistance
      // `manualChunks` group either - see the lane census header for why a group cannot be
      // used here - so the lane is found by which modules a chunk contains, and the two
      // checks below are stated over that census.
      const lane = auditAssistanceLane(bundle as EmittedBundle);
      report(
        `assistance lane: ${lane.laneChunks.length} chunk(s), ` +
          `${lane.fetchableLanePaths.length}/${ASSISTANCE_LANE_PATHS.length} declared path(s) fetchable, ` +
          `${lane.eagerLanePaths.length} statically reachable from the entry`,
      );
      for (const chunk of lane.laneChunks) {
        report(
          `  ${chunk.fileName} [${chunk.lanePaths.join(', ')}] ` +
            `${chunk.staticReachable ? 'EAGER' : 'lazy'}`,
        );
      }

      // Check 1, flag on: every declared lane path must be carried by a chunk a browser can
      // actually reach. "Emitted" is not "fetched", and the failure mode is the Phase 17 dead
      // lane - a build configured for a feature that verifies nothing. Both load-bearing
      // modules are required separately, so a build that ships the state and the vocabulary
      // but never the ranking fails here by name instead of passing on a `types.ts` that the
      // store drags in for free.
      //
      // Deliberately **not** guarded on `worldRenderer`, unlike the three renderer-adjacent
      // blocks above. Those guard to avoid printing one finding twice for one root cause;
      // here a missing renderer chunk and a missing lane module are two independent facts,
      // and on a build that set both flags both findings are true and both belong on the record.
      if (options.adaptiveAssistance === true) {
        const missing = ASSISTANCE_LANE_PATHS.filter(
          (lanePath) => !lane.fetchableLanePaths.includes(lanePath),
        );
        if (missing.length > 0) {
          this.error(
            [
              '[renderer-chunks] VITE_ADAPTIVE_ASSISTANCE=true, but no chunk the browser can reach carries: ' +
                `${missing.map((lanePath) => `${ASSISTANCE_LANE_ROLE[lanePath] ?? 'lane code'} (${lanePath})`).join(', ')}.`,
              'Emitted is not fetched. Lane modules nothing reachable imports are a configured lane that verifies nothing, which is the failure mode this check exists for.',
              'Reach the assistance lane through a dynamic import (React.lazy, or await import()) from a module the entry graph can reach, ' +
                'or build without VITE_ADAPTIVE_ASSISTANCE until the surface exists.',
            ].join('\n'),
          );
        }
      }

      // Check 2, flag at its production default: the entry must not statically reach any lane
      // code, because a static edge becomes a <link rel="modulepreload"> in dist/index.html and
      // every Welcome visitor downloads those bytes whatever the flag says.
      //
      // This is plan section 10.2's renderer rule - "no eager Phaser or Pixi load on
      // Welcome" - applied to a feature behind a cutover flag, and it is the check that
      // exists because the `manualChunks` group it replaces put React itself into an
      // "assistance" chunk and spent 10.28 KiB of the Welcome budget on a disabled feature.
      //
      // Stated for the flag-off build only. On a flagged build, eagerness is a measured
      // Welcome-budget question owned by `npm run check:budget:welcome`, and the line above
      // prints the verdict on every build so a flagged build that is eager is visible without
      // this becoming a second rule to relax.
      if (options.adaptiveAssistance !== true && lane.eagerLanePaths.length > 0) {
        this.error(
          [
            '[renderer-chunks] VITE_ADAPTIVE_ASSISTANCE is at its production default, but the entry document can statically reach: ' +
              `${lane.eagerLanePaths.map((lanePath) => ASSISTANCE_LANE_ROLE[lanePath] ?? lanePath).join(', ')}.`,
            'A static import edge makes Vite emit a <link rel="modulepreload"> for the lane chunk, so every Welcome visitor downloads those bytes on a build where the feature is switched off. That defeats the point of a productionDefault:false cutover flag and is the same violation plan section 10.2 states for the renderer.',
            'Reach the assistance lane through a dynamic import (React.lazy, or await import()) so the router, not the entry, decides when it loads.',
          ].join('\n'),
        );
      }

      // The Phase 20 share lane, enforced independently of the assistance lane and of all four
      // renderer switches.
      //
      // `build:web:share` turns on exactly one flag and turns on no renderer, so there is no
      // Pixi chunk to look for and no assistance module to find. The census below is the same
      // census the assistance lane uses ({@link auditFeatureLane}) over a different
      // declaration and a different membership predicate, so a chunk carrying assistance code
      // can never satisfy the share lane and vice versa.
      const shareLane = auditShareLane(bundle as EmittedBundle);
      report(
        `share lane: ${shareLane.laneChunks.length} chunk(s), ` +
          `${shareLane.fetchableLanePaths.length}/${SHARE_LANE_PATHS.length} declared path(s) fetchable, ` +
          `${shareLane.eagerLanePaths.length} statically reachable from the entry`,
      );
      for (const chunk of shareLane.laneChunks) {
        report(
          `  share ${chunk.fileName} [${chunk.lanePaths.join(', ')}] ` +
            `${chunk.staticReachable ? 'EAGER' : 'lazy'}`,
        );
      }

      // Check 1, flag on: every declared share lane path must be carried by a chunk a browser
      // can actually reach. "Emitted" is not "fetched", and the failure mode is the Phase 17
      // dead lane - `build:web:share` reported green while its host published nothing, which
      // is a check reporting success because it measured nothing.
      //
      // Stated over three **named** modules rather than over a directory or a chunk name, for
      // the reason `ASSISTANCE_LANE_PATHS` does: a build that shipped the dialog and the
      // policy but never shipped the code that makes the image would satisfy a directory-level
      // rule and satisfy a chunk-name rule, and neither of those is the thing the phase
      // delivers. Naming the modules makes that build fail by name.
      //
      // Deliberately NOT guarded on `worldRenderer`, for the same reason the assistance block
      // is not: a missing renderer chunk and a missing lane module are two independent facts,
      // and on a build that set both flags both belong on the record.
      if (options.webShare === true) {
        const missing = SHARE_LANE_PATHS.filter(
          (lanePath) => !shareLane.fetchableLanePaths.includes(lanePath),
        );
        if (missing.length > 0) {
          this.error(
            [
              '[renderer-chunks] VITE_WEB_SHARE=true, but no chunk the browser can reach carries: ' +
                `${missing.map((lanePath) => `${SHARE_LANE_ROLE[lanePath] ?? 'lane code'} (${lanePath})`).join(', ')}.`,
              'Emitted is not fetched. Lane modules nothing reachable imports are a configured lane that verifies nothing, which is the failure mode this check exists for.',
              'Reach the share lane through a dynamic import (React.lazy, or await import()) from a module the entry graph can reach, ' +
                'or build without VITE_WEB_SHARE until the surface exists.',
            ].join('\n'),
          );
        }
      }

      // Check 2, flag at its production default: the entry must not statically reach any share
      // lane module, because a static edge becomes a <link rel="modulepreload"> in
      // dist/index.html and every Welcome visitor downloads those bytes whatever the flag says.
      //
      // This is the mirror of check 1 and it is what makes `VITE_WEB_SHARE=false` a complete
      // rollback rather than a claim. The measured reason it is necessary here and not merely
      // tidy: at 23a0e0f the entire application core is emitted into one entry chunk, so
      // "statically reachable" and "in the entry chunk" are the same statement and a plain
      // `import` from any screen is eager.
      //
      // Stated for the flag-off build only. On a flagged build, eagerness is a measured
      // Welcome-budget question owned by `npm run check:budget:welcome`, and the line above
      // prints the verdict on every build so a flagged build that is eager is visible without
      // this becoming a second rule to relax.
      if (options.webShare !== true && shareLane.eagerLanePaths.length > 0) {
        this.error(
          [
            '[renderer-chunks] VITE_WEB_SHARE is at its production default, but the entry document can statically reach: ' +
              `${shareLane.eagerLanePaths.map((lanePath) => SHARE_LANE_ROLE[lanePath] ?? lanePath).join(', ')}.`,
            'A static import edge makes Vite emit a <link rel="modulepreload"> for the lane chunk, so every Welcome visitor downloads those bytes on a build where the feature is switched off. That defeats the point of a productionDefault:false cutover flag and is the same violation plan section 10.2 states for the renderer.',
            'Reach the share lane through a dynamic import (React.lazy, or await import()) so the router, not the entry, decides when it loads.',
          ].join('\n'),
        );
      }
    },
  };
}

/* ========================================================================== */

export default defineConfig(({ mode }) => {
  // Reject malformed build-time flags from both shell and mode-specific .env
  // inputs before Vite starts transforming the app.
  const buildEnvironment = {
    ...loadEnv(mode, process.cwd(), 'VITE_'),
    ...process.env,
  };
  const runtimeConfig = parseRuntimeConfig(buildEnvironment);

  const isProfileMode = mode === 'profile';
  const isElectronMode = mode === 'electron';

  return {
    base: process.env.VITE_BASE_PATH ?? (isElectronMode ? './' : '/'),
    plugins: [
      react(),
      legacy({
        targets: ['Chrome >= 120', 'Firefox >= 120', 'Safari >= 17', 'Edge >= 120'],
        modernPolyfills: true,
      }),
      spriteManifestPlugin(),
      rendererChunkBoundaryPlugin({
        worldRenderer: runtimeConfig.worldRenderer,
        pixiVillage: runtimeConfig.pixiVillage,
        pixiDungeon: runtimeConfig.pixiDungeon,
        pixiFishing: runtimeConfig.pixiFishing,
        adaptiveAssistance: runtimeConfig.adaptiveAssistance,
        webShare: runtimeConfig.webShare,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': 'http://localhost:3000',
        '/uploads': 'http://localhost:3000',
      },
    },
    build: {
      sourcemap: isProfileMode,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: manualChunkFor,
        },
      },
    },
    test: {
      include: ['tests/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      globals: true,
      setupFiles: ['vitest.setup.ts'],
    },
  };
});
