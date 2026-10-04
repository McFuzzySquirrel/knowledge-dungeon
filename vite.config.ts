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
 * The `manualChunks` group for a module id, or `undefined` to leave it alone.
 *
 * The order is the order the groups are tested, and Phaser is tested first
 * because its predicate is the pre-existing substring test and changing its
 * precedence would change the current production artifact.
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
 */
export function collectStaticClosure(bundle: EmittedBundle, roots: Iterable<string>): Set<string> {
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
    for (const imported of chunk.imports ?? []) {
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
  rendererChunks.sort((a, b) =>
    a.family === b.family ? a.fileName.localeCompare(b.fileName) : a.family.localeCompare(b.family),
  );

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
 * 2. **A build that asked for Pixi and emitted no Pixi chunk.** Reached by
 *    `VITE_WORLD_RENDERER=pixi` (the Phase 9 renderer switch), and additively by
 *    `VITE_PIXI_VILLAGE=true` (the Phase 11 village switch), `VITE_PIXI_DUNGEON=true`
 *    (the Phase 13 dungeon switch), and `VITE_PIXI_FISHING=true` (the Phase 17 fishing
 *    switch). Each is a build-time contract that CI has to exercise, and a switched build
 *    that contains no switched renderer is the shape of a check that reports success
 *    because it measured nothing. The four are independent because each of those build
 *    scripts leaves `VITE_WORLD_RENDERER=phaser`: the renderer check cannot cover any of
 *    them.
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
