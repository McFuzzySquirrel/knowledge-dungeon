/**
 * The renderer chunk boundary: `manualChunks` assignment and the emitted-graph audit.
 *
 * ## Why this file exists
 *
 * Plan section 10.2 requires "no eager Phaser or Pixi load on Welcome", and Phase 9's
 * scope says "keep Pixi in a lazy bundle". A `manualChunks` group on its own does not
 * deliver that, and the gap is not theoretical: Vite emits a
 * `<link rel=modulepreload>` for every chunk statically reachable from the entry, so
 * a Pixi host reached with a plain `import` sits in its own correctly named chunk and
 * is still downloaded before any application code runs. This file holds the logic that
 * makes the guarantee structural instead of incidental, and it is testable without a
 * build because the audit is a pure function over the emitted bundle graph.
 *
 * The audit also carries a distinction that is easy to get wrong and expensive to get
 * wrong twice, so it is pinned here rather than left to a reader: a chunk file name
 * appearing inside another chunk's text is not an import edge. `dist/index.html` in a
 * correctly lazy Pixi build contains `vendor-pixi-<hash>.js` inside Vite's
 * `__vite__mapDeps` array - a runtime string list for the dynamic import's preload
 * helper - while the entry chunk has no static import of it. A gate that matched on
 * file names anywhere in the artifact would fail that build.
 *
 * ## What is deliberately not asserted here
 *
 * Nothing in this file reads `dist/`, runs a build, or starts a browser, so it passes
 * on a clean checkout before anything has been built. The build-level proof is the
 * `renderer-chunks` block every build prints and the gate in
 * `scripts/check-memory.mjs`, which reads a built artifact.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data. It imports the
 * Vite configuration - which loads two plugins and defines a config factory without
 * invoking it - and reads no asset, registry, or IndexedDB store.
 */

import { describe, expect, it } from 'vitest';

import {
  auditRendererChunkBoundary,
  collectStaticClosure,
  isLegacyEmission,
  manualChunkFor,
  packageNameFromModuleId,
  PIXI_VENDOR_PACKAGES,
  rendererChunkBoundaryPlugin,
  RENDERER_CHUNK_PREFIX,
  rendererChunkFamily,
  type EmittedBundle,
} from '../../vite.config';

import { sourceOf } from './support/phase9Build';

/**
 * Builds an emitted-bundle fixture from a path-keyed description.
 *
 * Every chunk carries its own `fileName`, because the audit reads entries from
 * `chunk.isEntry` / `chunk.fileName` the way a real bundler emits them. A fixture
 * that omitted it would be testing a shape that never occurs.
 */
function bundleOf(
  entries: Readonly<Record<string, { imports?: readonly string[]; dynamicImports?: readonly string[]; isEntry?: boolean }>>,
): EmittedBundle {
  const bundle: Record<string, EmittedBundle[string]> = {};
  for (const [fileName, entry] of Object.entries(entries)) {
    bundle[fileName] = {
      fileName,
      type: 'chunk',
      imports: entry.imports ?? [],
      dynamicImports: entry.dynamicImports ?? [],
      isEntry: entry.isEntry === true,
    } as EmittedBundle[string];
  }
  return bundle;
}

/**
 * The `writeBundle` handler of a plugin, whether the bundler hands it over as a
 * function or as an object hook.
 */
function writeBundleHandler(plugin: {
  writeBundle?: unknown;
}): ((this: unknown, outputOptions: unknown, bundle: unknown) => void) | undefined {
  const hook = plugin.writeBundle;
  if (typeof hook === 'function') return hook as never;
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return (hook as { handler: (...args: never[]) => void }).handler as never;
  }
  return undefined;
}

/**
 * A plugin context that records `error()` instead of throwing, so a failing build is
 * observed the way a red CI run observes it - as a message, not an exception.
 */
function recordingContext(): { context: { error(message: string | Error): void }; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    context: {
      error(message: string | Error) {
        errors.push(message instanceof Error ? message.message : String(message));
      },
    },
  };
}

function runWriteBundle(
  plugin: { writeBundle?: unknown },
  bundle: EmittedBundle,
  context: { error(message: string | Error): void } = recordingContext().context,
): void {
  const handler = writeBundleHandler(plugin);
  if (handler === undefined) throw new Error('The plugin has no writeBundle hook.');
  // The output options are the first argument the hook receives and this fixture does
  // not read them.
  handler.call(context, {}, bundle);
}

/**
 * The shape a correct Phase 9 build has: the entry reaches React and Phaser
 * statically, and reaches the world chunk - and with it Pixi - only dynamically.
 */
function lazyPixiModuleBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': {
      isEntry: true,
      imports: ['assets/vendor-react-b2.js', 'assets/vendor-phaser-c3.js'],
      dynamicImports: ['assets/world-d4.js'],
    },
    'assets/polyfills-e5.js': { isEntry: true },
    'assets/vendor-react-b2.js': { imports: ['assets/types-f6.js'] },
    'assets/types-f6.js': {},
    'assets/vendor-phaser-c3.js': { imports: ['assets/rolldown-runtime-g7.js'] },
    'assets/rolldown-runtime-g7.js': {},
    'assets/world-d4.js': { imports: ['assets/vendor-pixi-h8.js', 'assets/rolldown-runtime-g7.js'] },
    'assets/vendor-pixi-h8.js': {},
  });
}

describe('module ids resolve to an npm package, not to a substring', () => {
  it('handles scoped, unscoped, nested, and Windows-separated ids', () => {
    expect(packageNameFromModuleId('/repo/node_modules/pixi.js/lib/index.mjs')).toBe('pixi.js');
    expect(packageNameFromModuleId('/repo/node_modules/@pixi/colord/index.mjs')).toBe('@pixi/colord');
    expect(packageNameFromModuleId('C:\\repo\\node_modules\\tiny-lru\\index.js')).toBe('tiny-lru');
    // A nested install resolves to the package nearest the file, not the outermost.
    expect(
      packageNameFromModuleId('/repo/node_modules/a/node_modules/pixi.js/lib/index.mjs'),
    ).toBe('pixi.js');
    // A scoped directory with nothing inside it is not a package.
    expect(packageNameFromModuleId('/repo/node_modules/@scope')).toBeUndefined();
    expect(packageNameFromModuleId('/repo/node_modules/')).toBeUndefined();
  });

  it('returns undefined for project source, which is what keeps a Pixi-named file out', () => {
    for (const id of [
      '/repo/src/renderers/pixi/runtime/createPixiApplication.ts',
      '/repo/src/ui/pixi-helpers.ts',
      '/repo/src/theme/pixiScale.ts',
      'rolldown/runtime.js',
    ]) {
      expect(packageNameFromModuleId(id), id).toBeUndefined();
    }
  });
});

describe('manualChunks claims each renderer into its own group', () => {
  it('claims Phaser first, exactly as the pre-existing predicate did', () => {
    // Order matters and is not incidental: the Phaser predicate is a substring test
    // that predates Phase 9, so its precedence over the new package-based Pixi test
    // is what keeps the current production artifact byte-identical.
    expect(manualChunkFor('/repo/node_modules/phaser/dist/phaser.js')).toBe(
      RENDERER_CHUNK_PREFIX.phaser,
    );
    expect(manualChunkFor('/repo/src/game/scenes/VillageScene.ts')).toBeUndefined();
  });

  it('claims pixi.js and every package only PixiJS pulls in', () => {
    for (const packageName of PIXI_VENDOR_PACKAGES) {
      const id = `/repo/node_modules/${packageName}/lib/index.mjs`;
      expect(manualChunkFor(id), id).toBe(RENDERER_CHUNK_PREFIX.pixi);
    }
    // The list is the v8 single-package layout plus its transitive dependencies. A
    // `@pixi/*` sub-package appearing here would mean someone is installing v7's
    // layout, which PixiJS 8 merged back in.
    expect(PIXI_VENDOR_PACKAGES).toContain('pixi.js');
    expect(PIXI_VENDOR_PACKAGES.filter((name) => name.startsWith('@pixi/'))).toEqual([
      '@pixi/colord',
    ]);
  });

  it('claims React into its pre-existing group and leaves everything else alone', () => {
    expect(manualChunkFor('/repo/node_modules/react/index.js')).toBe('vendor-react');
    expect(manualChunkFor('/repo/node_modules/react-dom/index.js')).toBe('vendor-react');
    expect(manualChunkFor('/repo/node_modules/scheduler/index.js')).toBe('vendor-react');
    expect(manualChunkFor('/repo/node_modules/zustand/esm/index.mjs')).toBeUndefined();
    expect(manualChunkFor('/repo/src/main.tsx')).toBeUndefined();
  });

  it('does not claim a project file that happens to be named after Pixi', () => {
    // The asymmetry with Phaser is deliberate and is the reason the Pixi predicate
    // is package-based: `id.includes('phaser')` is the pre-existing substring test
    // and changing it would change today's artifact, while a new predicate has no
    // such excuse.
    expect(manualChunkFor('/repo/src/renderers/pixi/runtime/PixiWorldHost.tsx')).toBeUndefined();
    expect(manualChunkFor('/repo/src/theme/pixiTokens.ts')).toBeUndefined();
  });
});

describe('a chunk file name resolves to a renderer family, not to a hash', () => {
  it('matches the bare group and the hashed group, and the legacy re-emission', () => {
    expect(rendererChunkFamily('assets/vendor-pixi-CkHy5qFN.js')).toBe('pixi');
    // The bare group name with no extension, which is what a bundle records as a
    // chunk's `name` rather than its `fileName`.
    expect(rendererChunkFamily('vendor-pixi')).toBe('pixi');
    expect(rendererChunkFamily('assets/vendor-pixi-legacy-CD2_jj-Z.js')).toBe('pixi');
    expect(rendererChunkFamily('assets/vendor-phaser-BHvTOz-D.js')).toBe('phaser');
    expect(rendererChunkFamily('assets/index-CANyR14L.js')).toBeUndefined();
    // A prefix match, which is the same shape `vendor-phaser-*` has always had in
    // `scripts/check-welcome-budget.mjs` and `tests/e2e/currentBuild.spec.ts`. The
    // cost of the shape is that anything beginning with the group prefix counts as
    // the group; that is why the prefix is `vendor-pixi` and not `pixi`, and why a
    // chunk that merely contains the family name does not match.
    expect(rendererChunkFamily('assets/vendor-pixi-extra-abc.js')).toBe('pixi');
    expect(rendererChunkFamily('assets/pixi-vendor-abc.js')).toBeUndefined();
    expect(rendererChunkFamily('assets/my-vendor-pixi.js')).toBeUndefined();
    // Windows separators resolve the same way.
    expect(rendererChunkFamily('assets\\vendor-pixi-abc.js')).toBe('pixi');
  });

  it('recognises the ES5 re-emission by its marker, not by its hash', () => {
    expect(isLegacyEmission('assets/index-legacy-DwJFFN11.js')).toBe(true);
    expect(isLegacyEmission('assets/vendor-pixi-legacy-CD2_jj-Z.js')).toBe(true);
    expect(isLegacyEmission('assets/index-CANyR14L.js')).toBe(false);
    expect(isLegacyEmission('assets/legacy-notes.js')).toBe(false);
  });

  it('keeps the Pixi family visible to the standing e2e network gate', () => {
    // `tests/e2e/currentBuild.spec.ts` asserts no request URL matches `/pixi/i`.
    // That standing gate can only fail a build that violates this one if the chunk
    // name carries `pixi`, so the name is a contract and not a preference.
    const e2e = sourceOf('tests/e2e/currentBuild.spec.ts');
    expect(e2e).toContain('/pixi/i');
    expect(RENDERER_CHUNK_PREFIX.pixi).toMatch(/pixi/i);
  });
});

describe('the static closure follows imports and only imports', () => {
  it('reaches a renderer through a chain of static imports', () => {
    const closure = collectStaticClosure(lazyPixiModuleBundle(), ['assets/index-a1.js']);
    expect([...closure].sort()).toEqual([
      'assets/index-a1.js',
      'assets/rolldown-runtime-g7.js',
      'assets/types-f6.js',
      'assets/vendor-phaser-c3.js',
      'assets/vendor-react-b2.js',
    ]);
    // Pixi is not in it, and that is the whole point: two hops through a dynamic
    // import is two hops the preload helper takes at runtime, not at parse time.
    expect(closure.has('assets/vendor-pixi-h8.js')).toBe(false);
    expect(closure.has('assets/world-d4.js')).toBe(false);
  });

  it('does not follow a dynamic import, which is the mechanism the plan relies on', () => {
    const bundle = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/world-d4.js'] },
      'assets/world-d4.js': { imports: ['assets/vendor-pixi-h8.js'] },
      'assets/vendor-pixi-h8.js': {},
    });
    const closure = collectStaticClosure(bundle, ['assets/index-a1.js']);
    expect([...closure]).toEqual(['assets/index-a1.js']);
  });

  it('treats an asset as a leaf and tolerates a reference to a missing chunk', () => {
    // Both cases are real: `dist/index.html` is an asset in the bundle, and a chunk
    // can name an import the bundler did not emit. Neither may throw, because a gate
    // that dies with a stack trace has already lost the reader who needed the finding
    // in sentence form.
    const bundle = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/gone-b2.js'] },
    });
    (bundle as Record<string, unknown>)['index.html'] = { fileName: 'index.html', type: 'asset' };
    const closure = collectStaticClosure(bundle, ['assets/index-a1.js', 'index.html']);
    expect([...closure]).toEqual(['assets/index-a1.js']);
  });
});

describe('the audit reads a lazy Pixi build as lazy', () => {
  it('reports the Pixi chunk as present and unreachable from the entry', () => {
    const audit = auditRendererChunkBoundary(lazyPixiModuleBundle());
    expect(audit.hasModuleEntry).toBe(true);
    expect(audit.moduleEntryChunks).toEqual(['assets/index-a1.js', 'assets/polyfills-e5.js']);
    expect(audit.legacyEntryChunks).toEqual([]);
    expect(audit.pixiIsLazy).toBe(true);
    expect(audit.eagerPixiChunks).toEqual([]);
    expect(audit.rendererChunks.map((entry) => `${entry.family}:${entry.fileName}`).sort()).toEqual([
      'phaser:assets/vendor-phaser-c3.js',
      'pixi:assets/vendor-pixi-h8.js',
    ]);
    // The Phaser chunk is genuinely eagerly reachable in the current application, and
    // the audit says so rather than hiding it behind the Pixi rule.
    expect(audit.eagerRendererChunks.map((entry) => entry.family)).toEqual(['phaser']);
  });

  it('is deterministic: the same bundle audits to the same report', () => {
    const bundle = lazyPixiModuleBundle();
    expect(JSON.stringify(auditRendererChunkBoundary(bundle))).toBe(
      JSON.stringify(auditRendererChunkBoundary(bundle)),
    );
  });
});

describe('the audit reads an eager Pixi build as a violation, however deep the import is', () => {
  it('catches a direct static import', () => {
    const bundle = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-pixi-h8.js'] },
      'assets/vendor-pixi-h8.js': {},
    });
    const audit = auditRendererChunkBoundary(bundle);
    expect(audit.pixiIsLazy).toBe(false);
    expect(audit.eagerPixiChunks.map((entry) => entry.fileName)).toEqual([
      'assets/vendor-pixi-h8.js',
    ]);
  });

  it('catches a static import three hops from the entry, which is the case a name search misses', () => {
    const bundle = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/ui-b2.js'] },
      'assets/ui-b2.js': { imports: ['assets/router-c3.js'] },
      'assets/router-c3.js': { imports: ['assets/world-d4.js'] },
      'assets/world-d4.js': { imports: ['assets/vendor-pixi-h8.js'] },
      'assets/vendor-pixi-h8.js': {},
    });
    const audit = auditRendererChunkBoundary(bundle);
    expect(audit.eagerPixiChunks.map((entry) => entry.fileName)).toEqual([
      'assets/vendor-pixi-h8.js',
    ]);
  });

  it('does not treat an eager Phaser chunk as a Pixi violation, and says why out loud', () => {
    const bundle = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
      'assets/vendor-phaser-b2.js': {},
    });
    const audit = auditRendererChunkBoundary(bundle);
    expect(audit.eagerPixiChunks).toEqual([]);
    expect(audit.eagerRendererChunks.map((entry) => entry.family)).toEqual(['phaser']);
  });
});

describe('the ES5 nomodule bundle is reported, never failed, and never mistaken for the module one', () => {
  it('separates a bundle whose only entries are legacy emissions', () => {
    // `System.register` declares its dependencies in the module's own argument list,
    // so a dynamic import appears there as a static registration. That is a property
    // of the SystemJS output format, not of the application's import graph, and no
    // browser in plan section 2.5's matrix executes this bundle.
    const bundle = bundleOf({
      'assets/index-legacy-a1.js': {
        isEntry: true,
        imports: ['assets/vendor-pixi-legacy-b2.js'],
      },
      'assets/vendor-pixi-legacy-b2.js': {},
    });
    const audit = auditRendererChunkBoundary(bundle);
    expect(audit.hasModuleEntry).toBe(false);
    expect(audit.moduleEntryChunks).toEqual([]);
    expect(audit.legacyEntryChunks).toEqual(['assets/index-legacy-a1.js']);
    expect(audit.eagerPixiChunks).toEqual([]);
    expect(audit.rendererChunks[0].legacyEager).toBe(true);
    expect(audit.rendererChunks[0].entryReachable).toBe(false);
  });

  it('keeps the two bundles apart when a build emits both', () => {
    const bundle: EmittedBundle = {
      ...lazyPixiModuleBundle(),
      ...bundleOf({
        'assets/index-legacy-a1.js': {
          isEntry: true,
          imports: ['assets/vendor-pixi-legacy-b2.js'],
        },
        'assets/vendor-pixi-legacy-b2.js': {},
      }),
    };
    const audit = auditRendererChunkBoundary(bundle);
    expect(audit.moduleEntryChunks).toHaveLength(2);
    expect(audit.legacyEntryChunks).toEqual(['assets/index-legacy-a1.js']);
    // The module verdict is unaffected by what the ES5 bundle registered.
    expect(audit.eagerPixiChunks).toEqual([]);
    expect(
      audit.rendererChunks.filter((entry) => entry.family === 'pixi').map((entry) => ({
        fileName: entry.fileName,
        entryReachable: entry.entryReachable,
        legacyEager: entry.legacyEager,
      })),
    ).toEqual([
      { fileName: 'assets/vendor-pixi-h8.js', entryReachable: false, legacyEager: false },
      { fileName: 'assets/vendor-pixi-legacy-b2.js', entryReachable: false, legacyEager: true },
    ]);
  });

  it('reports a bundle with no entry at all as un-auditable rather than clean', () => {
    const audit = auditRendererChunkBoundary(
      bundleOf({ 'assets/world-a1.js': { imports: ['assets/vendor-pixi-b2.js'] }, 'assets/vendor-pixi-b2.js': {} }),
    );
    expect(audit.hasModuleEntry).toBe(false);
    expect(audit.entryChunks).toEqual([]);
  });
});

describe('the boundary is wired into the build, not only into this file', () => {
  it('the manualChunks the build uses is the function this file tested', () => {
    const viteConfig = sourceOf('vite.config.ts');
    // A renamed or wrapped predicate would leave this file testing something the
    // build no longer does, which is the shape of a gate that reports on the test
    // rather than on the product.
    expect(viteConfig).toContain('manualChunks: manualChunkFor');
    expect(viteConfig).not.toMatch(/manualChunks\s*:\s*\{/);
    expect(viteConfig).not.toMatch(/manualChunks\s*:\s*function/);
  });

  it('the plugin is registered in the plugin list the build uses', () => {
    const viteConfig = sourceOf('vite.config.ts');
    // Phase 11 made the options object multi-line, so the assertion is on the call
    // shape and each argument rather than on one exact line. Both keys are asserted,
    // because a call that dropped `pixiVillage` would silently disable the Phase 11
    // village check while every Phase 9 gate still passed.
    expect(viteConfig).toContain('rendererChunkBoundaryPlugin({');
    expect(viteConfig).toContain('worldRenderer: runtimeConfig.worldRenderer');
    expect(viteConfig).toContain('pixiVillage: runtimeConfig.pixiVillage');
    // After the legacy plugin, so the ES5 pass is audited too, and the ES5 pass
    // happens first - which is why the audit splits the two bundles rather than
    // reporting "no entry chunk" on the bundle it happens to see.
    expect(viteConfig.indexOf('legacy({')).toBeLessThan(
      viteConfig.indexOf('rendererChunkBoundaryPlugin({'),
    );
  });

  it('the plugin is a build plugin that fails the build, not a logger', () => {
    const plugin = rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' });
    expect(plugin.name).toBe('knowledge-dungeon:renderer-chunk-boundary');
    expect(typeof plugin.writeBundle).toBe('function');
    // `generateBundle` would audit only the ES5 bundle. Verified against Vite 8.0.14:
    // a `generateBundle` hook at either plugin precedence sees exactly the twenty-two
    // `*-legacy-*.js` files and not one modern chunk.
    expect(plugin.generateBundle).toBeUndefined();
  });

  it('the plugin fails on an eager Pixi chunk and stays silent on a lazy one', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }),
      lazyPixiModuleBundle(),
      context,
    );
    expect(errors, 'a lazy Pixi build must not fail the build').toEqual([]);

    const eager = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-pixi-b2.js'] },
      'assets/vendor-pixi-b2.js': {},
    });
    runWriteBundle(rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }), eager, context);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('plan section 10.2');
    expect(errors[0]).toContain('vendor-pixi-b2.js');
  });

  it('the plugin fails a Pixi-flagged build that emitted no Pixi chunk', () => {
    const { context, errors } = recordingContext();
    const phaserOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
      'assets/vendor-phaser-b2.js': {},
    });
    runWriteBundle(rendererChunkBoundaryPlugin({ worldRenderer: 'pixi' }), phaserOnly, context);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_WORLD_RENDERER=pixi');
    // The Phaser-flagged build of the same bundle passes: the production default is
    // not required to contain a Pixi chunk, only not to reach one eagerly.
    errors.length = 0;
    runWriteBundle(rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }), phaserOnly, context);
    expect(errors).toEqual([]);
  });

  it('the plugin does not fail a build for an ES5 bundle that registered Pixi eagerly', () => {
    const { context, errors } = recordingContext();
    const legacyOnly = bundleOf({
      'assets/index-legacy-a1.js': {
        isEntry: true,
        imports: ['assets/vendor-pixi-legacy-b2.js'],
      },
      'assets/vendor-pixi-legacy-b2.js': {},
    });
    runWriteBundle(rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }), legacyOnly, context);
    expect(errors).toEqual([]);
  });

  /*
   * ── The Phase 11 additive option ──────────────────────────────────────────
   *
   * `pixiVillage` is a second build-time contract, independent of `worldRenderer`:
   * `build:web:pixi-village` sets `VITE_PIXI_VILLAGE=true` while leaving
   * `VITE_WORLD_RENDERER=phaser`, so the Phase 9 renderer check cannot cover it. The
   * four cases below are the whole truth table that matters: absent/false changes
   * nothing, true-with-a-chunk passes, true-without-a-chunk fails by name, and
   * both-switches-on does not print the same finding twice.
   */

  it('the additive option changes nothing when it is unset or false', () => {
    const phaserOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
      'assets/vendor-phaser-b2.js': {},
    });
    const { context, errors } = recordingContext();
    // Unset: the shape every Phase 9 caller constructs.
    runWriteBundle(rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }), phaserOnly, context);
    expect(errors).toEqual([]);
    // Explicitly false is the production default stated out loud.
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', pixiVillage: false }),
      phaserOnly,
      context,
    );
    expect(errors).toEqual([]);
  });

  it('a village-flagged build that emitted a lazy Pixi chunk passes', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', pixiVillage: true }),
      lazyPixiModuleBundle(),
      context,
    );
    expect(errors, 'a lazy village chunk is the intended Phase 11 shape').toEqual([]);
  });

  it('a village-flagged build with no Pixi chunk fails, naming VITE_PIXI_VILLAGE=true', () => {
    const { context, errors } = recordingContext();
    const phaserOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
      'assets/vendor-phaser-b2.js': {},
    });
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', pixiVillage: true }),
      phaserOnly,
      context,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_PIXI_VILLAGE=true');
    // The renderer check must not have fired: the village build leaves the world
    // renderer on Phaser, and a second finding for it would blame the wrong switch.
    expect(errors[0]).not.toContain('VITE_WORLD_RENDERER=pixi');
  });

  it('both switches on with no Pixi chunk produce exactly one finding', () => {
    const { context, errors } = recordingContext();
    const phaserOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
      'assets/vendor-phaser-b2.js': {},
    });
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'pixi', pixiVillage: true }),
      phaserOnly,
      context,
    );
    // One fact, one sentence. The renderer check owns it because it is the stronger
    // switch; the village check is guarded so it cannot restate it.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_WORLD_RENDERER=pixi');
    expect(errors[0]).not.toContain('VITE_PIXI_VILLAGE=true');
  });
});
