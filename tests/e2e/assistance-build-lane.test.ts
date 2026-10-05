/**
 * The Phase 19 build boundary: the `VITE_ADAPTIVE_ASSISTANCE` build script and the two
 * checks `vite.config.ts` states over the assistance-lane census.
 *
 * ## The two checks, and why there are two
 *
 * They are mirror images, and each one is a bug that actually happened:
 *
 * 1. **Flag on → both load-bearing lane modules must be fetchable.** A lane that is *emitted
 *    but never fetched* is the Phase 17 dead lane: `build:web:assistance` configured a
 *    feature no browser could reach, a lane ran against it, and every exit criterion went
 *    unmeasured while the run reported green.
 * 2. **Flag at its production default → the entry must not statically reach lane code.** A
 *    lane that is *eagerly fetched while switched off* spends the Welcome budget on a
 *    disabled feature. This is plan section 10.2's renderer rule - "no eager Phaser or Pixi
 *    load on Welcome" - applied to a feature, and it is what a learner on the default build
 *    was charged 10.28 KiB for before the chunking was fixed.
 *
 * A check that only did 1 would have passed the broken build. A check that only did 2 would
 * have passed a dead lane. Both are asserted here.
 *
 * ## Why the lane is identified by module membership, not by a chunk name
 *
 * The first implementation declared a `manualChunks` group (`feature-assistance`) and asserted
 * that a chunk of that name existed. That was wrong, and the reason is worth keeping because
 * it looks correct in review: **a `manualChunks` group takes its shared dependencies with it.**
 * `assistanceStore` imports `zustand`, `zustand` imports `use-sync-external-store`, and React
 * is shared with the entry - so `node_modules/react/index.js` and
 * `node_modules/react/cjs/react.production.js` were hoisted into the group, out of
 * `vendor-react` (which is why `vendor-react` shrank 57.50 → 55.28 KiB in that build). The
 * entry needs React, so `index -> feature-assistance` became a **static** edge, Vite wrote a
 * `modulepreload` for it, and 10.28 KiB of "assistance" was counted against every Welcome
 * visitor on a build with the flag off.
 *
 * Module membership cannot be influenced by the bundler, so the group is gone and
 * `tests/e2e/vite-config` no longer has any project-source chunk rule. The tests below pin
 * both halves of that: `manualChunkFor` claims vendor packages only, and the census finds the
 * lane by which modules a chunk contains.
 *
 * ## What is asserted, and what only a build can
 *
 * 1. the `build:web:assistance` script exists and sets **exactly** the one flag;
 * 2. the plugin is handed the parsed flag, so a dropped argument silently disables both checks
 *    while every other gate stays green;
 * 3. `manualChunkFor` claims no project source, and the lane predicate matches only project
 *    source, an exact stem, and never a dependency;
 * 4. both checks' full truth tables, in-process, from the real plugin;
 * 5. non-vacuity of every scanner and predicate above.
 *
 * **That the built `dist` is clean** is *not* claimed here. A unit test that read `dist/`
 * would fail on a checkout that has not been built; `npm run check:budget:welcome` measures
 * the entry document and is the artifact-shaped gate. Both checks are nevertheless stated over
 * the emitted bundle rather than over source, so the build itself enforces them and a green
 * `npm run build:web` is evidence.
 *
 * Hermeticity: reads repository source and drives the plugin over synthetic emitted-bundle
 * graphs that carry real module ids. No `dist/`, no build, no browser, no network, no learner
 * data.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_LANE_PATHS,
  ASSISTANCE_LANE_ROLE,
  assistanceLanePathFor,
  auditAssistanceLane,
  collectFetchableClosure,
  collectStaticClosure,
  manualChunkFor,
  projectSourcePath,
  rendererChunkBoundaryPlugin,
  RENDERER_CHUNK_PREFIX,
  type AssistanceLaneAudit,
  type EmittedBundle,
} from '../../vite.config';

import { stripComments } from '../phase9/support/phase9Build';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The module ids the checks reason about, as the two declared lane paths spell them. */
const RANKING_ID = `${REPO_ROOT}/src/core/assistance/assistanceEngine.ts`;
const STATE_ID = `${REPO_ROOT}/src/store/assistanceStore.ts`;
const TYPES_ID = `${REPO_ROOT}/src/core/assistance/types.ts`;
/**
 * A module that drags the lane into the entry's static closure without being a lane module.
 *
 * React, as it was before the group was deleted. It is the exact shape of the defect: a
 * non-lane module in a lane chunk, which the bundler - not this repository - decided.
 */
const REACT_ID = `${REPO_ROOT}/node_modules/react/index.js`;

/**
 * Builds an emitted-bundle fixture from a path-keyed description.
 *
 * `tests/phase9/renderer-chunk-boundary.test.ts` defines the same helper; it is repeated
 * rather than imported because that file is owned by Phase 9 and this one must keep working
 * if Phase 9's helper moves.
 */
function bundleOf(
  entries: Readonly<
    Record<
      string,
      {
        imports?: readonly string[];
        dynamicImports?: readonly string[];
        isEntry?: boolean;
        modules?: readonly string[];
      }
    >
  >,
): EmittedBundle {
  const bundle: Record<string, EmittedBundle[string]> = {};
  for (const [fileName, entry] of Object.entries(entries)) {
    bundle[fileName] = {
      fileName,
      type: 'chunk',
      imports: entry.imports ?? [],
      dynamicImports: entry.dynamicImports ?? [],
      isEntry: entry.isEntry === true,
      modules: Object.fromEntries((entry.modules ?? []).map((id) => [id, {}])),
    } as EmittedBundle[string];
  }
  return bundle;
}

/** A plugin context that records `error()` instead of throwing, the way a red CI run observes one. */
function recordingContext(): { context: { error(message: string | Error): void }; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    context: {
      error: (m: string | Error) => errors.push(m instanceof Error ? m.message : m),
    },
  };
}

function runWriteBundle(
  plugin: { writeBundle?: unknown },
  bundle: EmittedBundle,
  context: { error(message: string | Error): void },
): void {
  const hook = plugin.writeBundle;
  const handler =
    typeof hook === 'function'
      ? hook
      : hook && typeof hook === 'object' && 'handler' in hook
        ? (hook as { handler: (...args: never[]) => void }).handler
        : undefined;
  if (handler === undefined) throw new Error('The plugin has no writeBundle hook.');
  handler.call(context, {}, bundle);
}

/**
 * The production default: a Phaser build with no Pixi chunk and no lane code at all.
 *
 * This is the shape `build:web` emits before any importer lands, and it is the fixture every
 * "must stay quiet" case is stated against.
 */
function phaserOnlyBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
    'assets/vendor-phaser-b2.js': { modules: [REACT_ID] },
  });
}

/**
 * The intended Phase 19 shape: both lane modules present, reached only through dynamic
 * imports from the entry.
 */
function lazyLaneBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': {
      isEntry: true,
      imports: ['assets/vendor-react-c3.js'],
      dynamicImports: ['assets/assistanceStore-d4.js', 'assets/AssistanceRegion-e5.js'],
    },
    'assets/vendor-react-c3.js': { modules: [REACT_ID] },
    'assets/assistanceStore-d4.js': { modules: [STATE_ID, TYPES_ID] },
    'assets/AssistanceRegion-e5.js': { modules: [RANKING_ID] },
  });
}

/**
 * The defect this file exists for: a chunk carrying React *and* the lane, statically imported
 * by the entry. Under the old `manualChunks` group this is exactly what shipped, and it cost
 * every Welcome visitor 10.28 KiB on a build with the flag off.
 */
function eagerLaneBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': { isEntry: true, imports: ['assets/feature-assistance-b2.js'] },
    'assets/feature-assistance-b2.js': { modules: [REACT_ID, STATE_ID, TYPES_ID, RANKING_ID] },
  });
}

describe('the flagged build has a script that turns on exactly one flag', () => {
  it('build:web:assistance sets only VITE_ADAPTIVE_ASSISTANCE and leaves every renderer switch off', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    // The shape is load-bearing, not cosmetic. `build:web:assistance` sets only
    // `VITE_ADAPTIVE_ASSISTANCE`, so all four renderer-adjacent chunk checks sit on their
    // production defaults and none of them can see this build.
    expect(manifest.scripts['build:web:assistance']).toBe(
      'VITE_ADAPTIVE_ASSISTANCE=true npm run build:web',
    );
    expect(manifest.scripts['build:web:assistance']).not.toContain('VITE_WORLD_RENDERER');
    expect(manifest.scripts['build:web:assistance']).not.toContain('VITE_PIXI_VILLAGE');
    expect(manifest.scripts['build:web:assistance']).not.toContain('VITE_PIXI_DUNGEON');
    expect(manifest.scripts['build:web:assistance']).not.toContain('VITE_PIXI_FISHING');

    // And it delegates to `build:web`, like its four neighbours, so it runs typecheck and
    // lands in `dist/` the same way.
    expect(manifest.scripts['build:web:assistance']).toContain('npm run build:web');
    for (const sibling of [
      'build:web:pixi',
      'build:web:pixi-village',
      'build:web:pixi-dungeon',
      'build:web:pixi-fishing',
    ]) {
      expect(manifest.scripts[sibling], sibling).toBeDefined();
    }
  });

  it('the build plugin is handed the parsed assistance flag', () => {
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    // Asserted on the call shape and the argument, matching the Phase 11, 13 and 17
    // additions. A call that dropped `adaptiveAssistance` would silently disable BOTH lane
    // checks while every other gate stayed green - the exact gap this file closes.
    expect(viteConfig).toContain('rendererChunkBoundaryPlugin({');
    expect(viteConfig).toContain('worldRenderer: runtimeConfig.worldRenderer');
    expect(viteConfig).toContain('pixiVillage: runtimeConfig.pixiVillage');
    expect(viteConfig).toContain('pixiDungeon: runtimeConfig.pixiDungeon');
    expect(viteConfig).toContain('pixiFishing: runtimeConfig.pixiFishing');
    expect(viteConfig).toContain('adaptiveAssistance: runtimeConfig.adaptiveAssistance');
  });
});

describe('no manualChunks group claims project source, which is the fix for the eager preload', () => {
  it('manualChunkFor claims vendor packages and nothing else', () => {
    // Every group here is a vendor group, and that is the rule this repository learned the
    // expensive way: a manual group takes its shared dependencies with it. Asserted as a
    // blanket property rather than as four examples, because "no project source" is the
    // property and a list of module ids would not survive the next file to be added.
    for (const laneModule of [RANKING_ID, STATE_ID, TYPES_ID]) {
      expect(manualChunkFor(laneModule), laneModule).toBeUndefined();
    }
    expect(manualChunkFor(`${REPO_ROOT}/src/main.tsx`)).toBeUndefined();
    expect(manualChunkFor(`${REPO_ROOT}/src/ui/assistance/AssistanceSlot.tsx`)).toBeUndefined();
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/zustand/esm/index.mjs`)).toBeUndefined();

    // The vendor groups are untouched by any of this.
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/phaser/dist/phaser.js`)).toBe(
      RENDERER_CHUNK_PREFIX.phaser,
    );
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/pixi.js/lib/index.mjs`)).toBe(
      RENDERER_CHUNK_PREFIX.pixi,
    );
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/react/index.js`)).toBe('vendor-react');
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/react-dom/index.js`)).toBe('vendor-react');
  });

  it('the config declares no assistance or feature chunk prefix at all', () => {
    // A green build cannot be evidence that a group is gone if nothing asserts its absence:
    // re-adding `FEATURE_CHUNK_PREFIX` would compile and both checks would still pass while the
    // eager preload came back with it.
    //
    // Asserted on code, not on the file. The comments in `vite.config.ts` name
    // `feature-assistance` on purpose - they are the record of why the group was deleted - so
    // the source is stripped before the name check, exactly as
    // `tests/phase17/fishing-flag-boundary.test.ts` does when a gate is allowed to explain its
    // own rule.
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const code = stripComments(viteConfig);
    expect(code).not.toContain('FEATURE_CHUNK_PREFIX');
    expect(code).not.toContain('feature-assistance');
    expect(code).not.toContain('featureChunkFamily');
    expect(code).not.toContain('FeatureChunkFamily');
    // And the census is stated over module ids, not over names.
    expect(viteConfig).toContain('chunk.modules ?? {}');
    // The group name survives in the prose, so the next reader can find the reason.
    expect(viteConfig).toContain('feature-assistance');
  });
});

describe('the lane predicate matches project source by an exact stem and never a dependency', () => {
  it('resolves absolute, root-relative, and Windows module ids to the same source path', () => {
    // `manualChunks` and the census are handed ids whose spelling depends on how the bundler
    // resolved them, and all three must agree or the checks would pass on some machines only.
    expect(projectSourcePath(`${REPO_ROOT}/src/core/assistance/types.ts`)).toBe(
      'src/core/assistance/types.ts',
    );
    expect(projectSourcePath('/src/core/assistance/types.ts')).toBe('src/core/assistance/types.ts');
    expect(projectSourcePath('C:\\repo\\src\\core\\assistance\\types.ts')).toBe(
      'src/core/assistance/types.ts',
    );
    // A query suffix is stripped, so a `?used` or `?raw` id still resolves.
    expect(projectSourcePath(`${REPO_ROOT}/src/core/assistance/types.ts?used`)).toBe(
      'src/core/assistance/types.ts',
    );
    // Outside `src/`, and inside a dependency, project source does not exist.
    expect(projectSourcePath(`${REPO_ROOT}/vite.config.ts`)).toBeUndefined();
    expect(projectSourcePath(`${REPO_ROOT}/node_modules/zustand/esm/index.mjs`)).toBeUndefined();
  });

  it('claims exactly the ranking and the state, and not a module that merely shares a prefix', () => {
    expect(ASSISTANCE_LANE_PATHS).toEqual([
      'src/core/assistance/assistanceEngine',
      'src/store/assistanceStore',
    ]);
    expect(assistanceLanePathFor(RANKING_ID)).toBe('src/core/assistance/assistanceEngine');
    expect(assistanceLanePathFor(STATE_ID)).toBe('src/store/assistanceStore');

    // `types.ts` is under the assistance directory and is **not** a lane module. This is the
    // distinction that makes the guard work: `assistanceStore` imports `types.ts`, so a
    // directory-level requirement would be met by a chunk carrying the vocabulary alone and a
    // build that never shipped the ranking would pass.
    expect(assistanceLanePathFor(TYPES_ID)).toBeUndefined();
    expect(assistanceLanePathFor(`${REPO_ROOT}/src/core/assistance/assistanceEngine.test.ts`)).toBe(
      'src/core/assistance/assistanceEngine',
    );
    expect(assistanceLanePathFor(`${REPO_ROOT}/src/core/assistanceReport.ts`)).toBeUndefined();
    expect(assistanceLanePathFor(`${REPO_ROOT}/src/store/studyStore.ts`)).toBeUndefined();
    expect(assistanceLanePathFor(`${REPO_ROOT}/src/ui/assistance/AssistanceCard.tsx`)).toBeUndefined();
    expect(assistanceLanePathFor(REACT_ID)).toBeUndefined();

    // Each declared path is a **stem**, not a whole filename, so a longer name that starts with
    // it matches too. Stated rather than left as a surprise: `assistanceStore.test.ts` matching
    // costs nothing because a test module is never in a production graph, and tightening the
    // stem to a full filename would buy nothing and break on the next rename of either module.
    expect(assistanceLanePathFor(`${REPO_ROOT}/src/store/assistanceStore.test.ts`)).toBe(
      'src/store/assistanceStore',
    );
  });

  it('describes each declared path, so a failing build says what is missing in words', () => {
    // An error naming a path nobody has heard of teaches nothing. Every declared path has a
    // role, so a rename or a future path is reported as "the ranking" / "the state".
    for (const lanePath of ASSISTANCE_LANE_PATHS) {
      expect(ASSISTANCE_LANE_ROLE[lanePath], lanePath).toBeTruthy();
    }
    expect(ASSISTANCE_LANE_ROLE['src/core/assistance/assistanceEngine']).toBe('the ranking');
    expect(ASSISTANCE_LANE_ROLE['src/store/assistanceStore']).toBe('the state');
  });

  it('the modules the lane requires still exist at the paths it names', () => {
    // A guard naming modules that were renamed or moved is guarding nothing. A rename fails
    // here first, where the message can say which path moved, instead of as a build error
    // about an unreachable ranking.
    for (const repoRelative of [
      'src/core/assistance/assistanceEngine.ts',
      'src/store/assistanceStore.ts',
    ]) {
      expect(
        () => readFileSync(path.join(REPO_ROOT, repoRelative), 'utf8'),
        repoRelative,
      ).not.toThrow();
    }
  });
});

describe('the two closures differ on exactly the property the checks read', () => {
  it('the static closure excludes a dynamically imported chunk and the fetchable one includes it', () => {
    const bundle = lazyLaneBundle();
    const statics = collectStaticClosure(bundle, ['assets/index-a1.js']);
    const fetchable = collectFetchableClosure(bundle, ['assets/index-a1.js']);

    expect([...statics].sort()).toEqual(['assets/index-a1.js', 'assets/vendor-react-c3.js']);
    // The two lane chunks are reachable only by dynamic import, which is what makes them
    // fetchable and not eager.
    expect(statics.has('assets/assistanceStore-d4.js')).toBe(false);
    expect(fetchable.has('assets/assistanceStore-d4.js')).toBe(true);
    expect(fetchable.has('assets/AssistanceRegion-e5.js')).toBe(true);
    expect(fetchable.size).toBeGreaterThan(statics.size);
  });

  it('the audit reports the lane as fetchable-but-lazy for the intended shape', () => {
    const audit = auditAssistanceLane(lazyLaneBundle());
    expect(audit.moduleEntryChunks).toEqual(['assets/index-a1.js']);
    expect(audit.fetchableLanePaths).toEqual([...ASSISTANCE_LANE_PATHS]);
    expect(audit.eagerLanePaths, 'a lazy lane is fetchable and not eager').toEqual([]);
    expect(audit.laneChunks.map((entry) => `${entry.fileName} ${entry.staticReachable}`)).toEqual([
      'assets/AssistanceRegion-e5.js false',
      'assets/assistanceStore-d4.js false',
    ]);
    // Deterministic, so the line printed on every build is byte-stable.
    expect(JSON.stringify(auditAssistanceLane(lazyLaneBundle()))).toBe(
      JSON.stringify(auditAssistanceLane(lazyLaneBundle())),
    );
  });

  it('an emitted lane chunk nothing reaches is neither fetchable nor eager', () => {
    // The dead lane, stated at the census level: the code shipped and no browser can get to
    // it. Rolldown cannot currently produce this from a source graph - anything in the graph
    // is reachable from the entry - so it is constructed here rather than built, and that is
    // the honest reason it is a fixture and not a build.
    const orphan = bundleOf({
      'assets/index-a1.js': { isEntry: true },
      'assets/orphan-a2.js': { modules: [RANKING_ID, STATE_ID] },
    });
    const audit = auditAssistanceLane(orphan);
    expect(audit.laneChunks).toHaveLength(1);
    expect(audit.fetchableLanePaths).toEqual([]);
    expect(audit.eagerLanePaths).toEqual([]);
  });

  it('a chunk that omits its module list cannot satisfy the lane', () => {
    // A fixture or a bundler that declines to report `modules` yields "no lane code here",
    // which is the safe reading: a lane cannot be proved by a chunk whose contents are
    // unknown. Asserted so a future bundler change cannot turn "unknown" into "empty, fine".
    const unknown = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/mystery-a2.js'] },
      'assets/mystery-a2.js': {},
    });
    expect(auditAssistanceLane(unknown).laneChunks).toEqual([]);
  });
});

describe('check 1: a flagged build must actually be able to fetch the lane', () => {
  it('is a writeBundle plugin that calls this.error, and never generateBundle', () => {
    const plugin = rendererChunkBoundaryPlugin({
      worldRenderer: 'phaser',
      adaptiveAssistance: true,
    });
    expect(plugin.name).toBe('knowledge-dungeon:renderer-chunk-boundary');
    expect(typeof plugin.writeBundle).toBe('function');
    // `generateBundle` would audit only the ES5 `nomodule` bundle under
    // `@vitejs/plugin-legacy`; see the plugin's own comment.
    expect(plugin.generateBundle).toBeUndefined();
  });

  it('FAILS a flagged build with no lane code at all', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      phaserOnlyBundle(),
      context,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_ADAPTIVE_ASSISTANCE=true');
    // Named in words, not only as paths.
    expect(errors[0]).toContain('the ranking');
    expect(errors[0]).toContain('the state');
    // The four renderer checks must not have fired: this build turns on no renderer at all.
    expect(errors[0]).not.toContain('VITE_WORLD_RENDERER=pixi');
    expect(errors[0]).not.toContain('VITE_PIXI_VILLAGE');
    expect(errors[0]).not.toContain('VITE_PIXI_DUNGEON');
    expect(errors[0]).not.toContain('VITE_PIXI_FISHING');
  });

  it('PASSES a flagged build whose lane is reached through dynamic imports', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      lazyLaneBundle(),
      context,
    );
    expect(errors, 'a lazy, fetchable lane is the intended Phase 19 shape').toEqual([]);
  });

  it('FAILS a flagged build that ships the state and the vocabulary but never the ranking', () => {
    // The case a chunk-name check could not catch. Under the old `feature-assistance` group
    // this build was green: the group existed, because `assistanceStore` drags `types.ts`
    // into it. Naming `assistanceEngine` is what makes it red.
    const storeOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/assistanceStore-a2.js'] },
      'assets/assistanceStore-a2.js': { modules: [STATE_ID, TYPES_ID] },
    });
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      storeOnly,
      context,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('the ranking');
    // And it must not also complain about the state, which *is* present and fetchable.
    expect(errors[0]).not.toContain('the state');
  });

  it('FAILS a flagged build that ships the ranking but never the state', () => {
    const engineOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/AssistanceRegion-a2.js'] },
      'assets/AssistanceRegion-a2.js': { modules: [RANKING_ID] },
    });
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      engineOnly,
      context,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('the state');
    expect(errors[0]).not.toContain('the ranking');
  });

  it('FAILS a flagged build whose lane chunk is emitted but nothing reachable imports it', () => {
    const orphan = bundleOf({
      'assets/index-a1.js': { isEntry: true },
      'assets/orphan-a2.js': { modules: [RANKING_ID, STATE_ID] },
    });
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      orphan,
      context,
    );
    // Emitted is not fetched. This is the Phase 17 dead lane, and it is a build failure.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Emitted is not fetched');
  });

  it('reports one finding per missing renderer switch when a renderer switch and the lane are both on', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'pixi', adaptiveAssistance: true }),
      phaserOnlyBundle(),
      context,
    );
    // Unlike the three renderer-adjacent guards, this one is deliberately NOT guarded on
    // `worldRenderer`. Those guard to avoid restating one root cause; a missing renderer chunk
    // and a missing lane module are two independent facts, and on a build that set both flags
    // both belong on the record.
    expect(errors).toHaveLength(2);
    expect(errors.some((message) => message.includes('VITE_WORLD_RENDERER=pixi'))).toBe(true);
    expect(errors.some((message) => message.includes('VITE_ADAPTIVE_ASSISTANCE=true'))).toBe(true);
  });

  it('does not fail the ES5 nomodule bundle for a missing lane', () => {
    // `System.register` registers every chunk statically, so the legacy pass registers the
    // lane whether or not the application reached it. That is a property of the output format,
    // and no browser in the plan's support matrix executes it. Reported, not failed.
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      bundleOf({ 'assets/index-legacy-a1.js': { isEntry: true, modules: [STATE_ID] } }),
      context,
    );
    expect(errors).toEqual([]);
  });
});

describe('check 2: a flag-off build must not eagerly fetch the lane', () => {
  it('FAILS a default-flag build whose entry statically reaches the lane', () => {
    // The defect this check was added for. React is in this chunk because a `manualChunks`
    // group hoisted it, which made the lane chunk a static dependency of the entry and put a
    // `modulepreload` for it into `dist/index.html`.
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }),
      eagerLaneBundle(),
      context,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_ADAPTIVE_ASSISTANCE is at its production default');
    expect(errors[0]).toContain('modulepreload');
    expect(errors[0]).toContain('the ranking, the state');
    // The renderer checks must not have fired instead: no renderer switch is set.
    expect(errors[0]).not.toContain('VITE_WORLD_RENDERER=pixi');
    expect(errors[0]).not.toContain('VITE_PIXI_FISHING');
  });

  it('FAILS an explicitly-false build too, which is the production default stated out loud', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: false }),
      eagerLaneBundle(),
      context,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('production default');
  });

  it('stays quiet when the flag is off and the lane is lazy', () => {
    const { context, errors } = recordingContext();
    // A lazily reachable lane on the default build is the intended shape: the code ships, the
    // browser fetches it when a learner meets the surface, and no Welcome visitor pays for it.
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: false }),
      lazyLaneBundle(),
      context,
    );
    expect(errors).toEqual([]);
  });

  it('stays quiet on a default build with no lane code at all', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(rendererChunkBoundaryPlugin({ worldRenderer: 'phaser' }), phaserOnlyBundle(), context);
    expect(errors).toEqual([]);
    errors.length = 0;
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: false }),
      phaserOnlyBundle(),
      context,
    );
    expect(errors).toEqual([]);
  });

  it('does NOT fail a flagged build that is eager, because that is the budget gate\'s question', () => {
    // A deliberate asymmetry, and it is the only one. On a build that asked for the feature,
    // eagerness is a Welcome-budget measurement owned by `npm run check:budget:welcome`, and the
    // census line printed on every build reports it. Folding it into this check would create a
    // second rule to relax when a phase legitimately decides to spend headroom on the flagged
    // build - which is a decision for the maintainer and the budget, not for a chunk plugin.
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', adaptiveAssistance: true }),
      eagerLaneBundle(),
      context,
    );
    expect(errors).toEqual([]);
    // And the audit still reports it as eager, so the state is visible rather than hidden.
    expect(auditAssistanceLane(eagerLaneBundle()).eagerLanePaths).toEqual([...ASSISTANCE_LANE_PATHS]);
  });
});

/* ── Non-vacuity ───────────────────────────────────────────────────────────── */

describe('the predicates above are real, so the assertions are not vacuous', () => {
  it('the plugin under test is the one the config registers', async () => {
    const { rendererChunkBoundaryPlugin: fromConfig } = await import('../../vite.config');
    expect(fromConfig).toBe(rendererChunkBoundaryPlugin);
  });

  it('each fixture differs on the exact property its check reads', () => {
    const none = auditAssistanceLane(phaserOnlyBundle()) as AssistanceLaneAudit;
    const lazy = auditAssistanceLane(lazyLaneBundle());
    const eager = auditAssistanceLane(eagerLaneBundle());

    expect(none.laneChunks, 'the quiet fixture must carry no lane code').toEqual([]);
    expect(lazy.fetchableLanePaths, 'the passing fixture must be fetchable').toEqual([
      ...ASSISTANCE_LANE_PATHS,
    ]);
    expect(lazy.eagerLanePaths, 'and not eager').toEqual([]);
    expect(eager.eagerLanePaths, 'the failing fixture must be eager').toEqual([
      ...ASSISTANCE_LANE_PATHS,
    ]);

    // React is deliberately in the eager fixture and deliberately absent from the lane
    // predicate, which is what makes it the shape of the original defect.
    expect(assistanceLanePathFor(REACT_ID)).toBeUndefined();
    expect(eagerLaneBundle()['assets/feature-assistance-b2.js']?.modules).toHaveProperty(REACT_ID);
  });

  it('a chunk the bundler renamed cannot satisfy or evade the lane, because names are not read', () => {
    // The old implementation matched `feature-assistance-*`, which a chunk rename or a
    // colliding project file could influence. Module membership cannot be renamed away.
    const renamed = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/random-b2.js'] },
      'assets/random-b2.js': { modules: [RANKING_ID, STATE_ID] },
    });
    expect(auditAssistanceLane(renamed).fetchableLanePaths).toEqual([...ASSISTANCE_LANE_PATHS]);

    // And a chunk with the old *name* but no lane modules satisfies nothing.
    const impostor = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/feature-assistance-b2.js'] },
      'assets/feature-assistance-b2.js': { modules: [REACT_ID] },
    });
    expect(auditAssistanceLane(impostor).fetchableLanePaths).toEqual([]);
  });
});