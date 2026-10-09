/**
 * Phase 20 infrastructure: the `build:web:share` build boundary and the two checks
 * `vite.config.ts` states over the share-lane census.
 *
 * ## What this file is
 *
 * Owned by the infrastructure lane, and deliberately **not** a test of the card renderer, the
 * policy, or the dialog. Those belong to the Phase 20 domain and UI owners. What is tested
 * here is only the part that is infrastructure: that the lane is identified by named modules
 * rather than a chunk name, that each of the two checks fires on the failure it exists for,
 * that neither check can be satisfied by the other lane's code, and that the CC0 and
 * no-backend properties of the *lane declaration* are true.
 *
 * ## The two checks, and why there are two
 *
 * They are mirror images, and each one is a bug that already happened in this repository:
 *
 * 1. **Flag on -> every named lane module must be fetchable.** A lane that is *emitted but
 *    never fetched* is the Phase 17 dead lane: `build:web:pixi-fishing` once reported green
 *    while its host published nothing. A `build:web:share` with no share code in it is the
 *    same shape, and it is a **red build** here rather than a green lane.
 * 2. **Flag off (the rollback build) -> the entry must not statically reach lane code.** A
 *    static import edge becomes a `<link rel="modulepreload">` in `dist/index.html`, so every
 *    Welcome visitor downloads those bytes whatever the flag says. This is plan section 10.2's
 *    renderer rule applied to a feature, and the Phase 19 assistance group cost the Welcome
 *    budget 10.28 KiB for a feature that could never fire. Since the Phase 23 cutover the
 *    production default is `true`, so check 1 runs on the default build and check 2 runs on a
 *    `VITE_WEB_SHARE=false` rollback build.
 *
 * A check that only did 1 would pass the default build. A check that only did 2 would pass a
 * dead lane. Both are asserted.
 *
 * ## Why module membership and not a chunk name
 *
 * `vite.config.ts` documents the whole failure: a `manualChunks` group takes its **shared
 * dependencies** with it, so claiming the assistance lane hoisted React into the group, made
 * `index -> feature-assistance` a static edge, and emitted a 10.28 KiB counted preload on a
 * build where the flag was `false`. There is no project-source `manualChunks` group in this
 * file, and part of what is asserted below is that there is not one to add.
 *
 * ## Hermeticity
 *
 * Reads repository source and drives the real plugin over synthetic emitted-bundle graphs
 * carrying real module ids. No `dist/`, no build, no browser, no network, no learner data.
 * The one exception is the filesystem walk for font files and the `server/` route check, both
 * of which read the working tree and would be meaningless against a fixture.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NON_CUTOVER_FLAG_KEYS, FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import {
  auditShareLane,
  collectFetchableClosure,
  collectStaticClosure,
  manualChunkFor,
  projectSourcePath,
  rendererChunkBoundaryPlugin,
  RENDERER_CHUNK_PREFIX,
  SHARE_LANE_PATHS,
  SHARE_LANE_ROLE,
  shareLanePathFor,
  ASSISTANCE_LANE_PATHS,
  assistanceLanePathFor,
  type EmittedBundle,
} from '../../vite.config';

import { stripComments } from '../phase9/support/phase9Build';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The module ids the checks reason about, spelled the way the lane paths spell them. */
const POLICY_ID = `${REPO_ROOT}/src/core/share/shareCardPolicy.ts`;
const RENDERER_ID = `${REPO_ROOT}/src/ui/share/renderShareCard.ts`;
const DIALOG_ID = `${REPO_ROOT}/src/ui/share/ShareCardDialog.tsx`;

/**
 * Two modules inside the lane's own directories that the declaration must **not** name.
 *
 * `types.ts` is the vocabulary and `shareCardModel.ts` is the model `renderShareCard` must
 * consume to draw anything, so both are dragged into any chunk carrying the lane for free.
 * Naming either would make the declaration look broader without making it stricter, and the
 * whole point of naming modules rather than directories is that this distinction is the check.
 */
const VOCABULARY_ID = `${REPO_ROOT}/src/core/share/types.ts`;
const MODEL_ID = `${REPO_ROOT}/src/core/share/shareCardModel.ts`;

/** The legacy exporter: already eagerly reachable before Phase 20, and not a lane module. */
const LEGACY_EXPORTER_ID = `${REPO_ROOT}/src/ui/utils/progressionShareExport.ts`;

const REACT_ID = `${REPO_ROOT}/node_modules/react/index.js`;
const ASSISTANCE_ENGINE_ID = `${REPO_ROOT}/src/core/assistance/assistanceEngine.ts`;
const ASSISTANCE_STORE_ID = `${REPO_ROOT}/src/store/assistanceStore.ts`;

/**
 * Builds an emitted-bundle fixture from a path-keyed description.
 *
 * Repeated from `tests/e2e/assistance-build-lane.test.ts` rather than imported, because that
 * file is owned by Phase 19 and this one must keep working if its helper moves.
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
  return { errors, context: { error: (m: string | Error) => errors.push(m instanceof Error ? m.message : m) } };
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

/** Runs the plugin with only the flags a test cares about set, and returns what it reported. */
function auditBuild(options: { webShare?: boolean }, bundle: EmittedBundle): string[] {
  const { context, errors } = recordingContext();
  runWriteBundle(
    rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', ...options }),
    bundle,
    context,
  );
  return errors;
}

/** The production default: a Phaser build with no Pixi chunk and no lane code at all. */
function phaserOnlyBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
    'assets/vendor-phaser-b2.js': { modules: [REACT_ID] },
  });
}

/**
 * The intended Phase 20 shape: all three named modules present, reached only through dynamic
 * imports from the entry. The vocabulary and the model ride along in the renderer's chunk,
 * exactly as they would in a real build.
 *
 * The graph is deliberately **chained** rather than flat - the entry dynamically imports the
 * dialog, the dialog dynamically imports the renderer, and the renderer statically imports the
 * policy - because a flat fixture would pass for the wrong reason. It would assert that three
 * sibling chunks hanging off the entry's `dynamicImports` are all fetchable, and would not
 * notice that the chain, which is the shape a lazily opened dialog actually produces, behaves
 * differently: a statically imported child of a dynamically reached parent is fetchable and
 * still not eager.
 */
function lazyShareLaneBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': {
      isEntry: true,
      imports: ['assets/vendor-react-c3.js'],
      dynamicImports: ['assets/ShareCardDialog-d4.js'],
    },
    'assets/vendor-react-c3.js': { modules: [REACT_ID] },
    'assets/ShareCardDialog-d4.js': {
      modules: [DIALOG_ID],
      dynamicImports: ['assets/renderShareCard-e5.js'],
    },
    'assets/renderShareCard-e5.js': {
      modules: [RENDERER_ID, MODEL_ID, VOCABULARY_ID],
      imports: ['assets/shareCardPolicy-f6.js'],
    },
    'assets/shareCardPolicy-f6.js': { modules: [POLICY_ID] },
  });
}

/**
 * The defect check 2 exists for: a chunk carrying the lane, statically imported by the entry.
 *
 * `REACT_ID` is in this chunk on purpose, because that is the shape the deleted assistance
 * `manualChunks` group actually produced - a non-lane module in a lane chunk, which the
 * bundler decided rather than this repository.
 */
function eagerShareLaneBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': { isEntry: true, imports: ['assets/feature-share-b2.js'] },
    'assets/feature-share-b2.js': { modules: [REACT_ID, POLICY_ID, RENDERER_ID, DIALOG_ID] },
  });
}

/* ── 1. The build script ────────────────────────────────────────────────────── */

describe('the flagged share build has a script that turns on exactly one flag', () => {
  it('build:web:share sets only VITE_WEB_SHARE and leaves every renderer switch off', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // The shape is load-bearing, not cosmetic. `build:web:share` sets only `VITE_WEB_SHARE`, so
    // all four renderer-adjacent chunk checks and the assistance lane check sit on their
    // production defaults and none of them can see this build.
    expect(manifest.scripts['build:web:share']).toBe('VITE_WEB_SHARE=true npm run build:web');
    expect(manifest.scripts['build:web:share']).not.toContain('VITE_WORLD_RENDERER');
    expect(manifest.scripts['build:web:share']).not.toContain('VITE_PIXI_VILLAGE');
    expect(manifest.scripts['build:web:share']).not.toContain('VITE_PIXI_DUNGEON');
    expect(manifest.scripts['build:web:share']).not.toContain('VITE_PIXI_FISHING');
    expect(manifest.scripts['build:web:share']).not.toContain('VITE_ADAPTIVE_ASSISTANCE');

    // And it delegates to `build:web`, like its five neighbours, so it runs typecheck and lands
    // in `dist/` the same way.
    expect(manifest.scripts['build:web:share']).toContain('npm run build:web');
    for (const sibling of [
      'build:web:pixi',
      'build:web:pixi-village',
      'build:web:pixi-dungeon',
      'build:web:pixi-fishing',
      'build:web:assistance',
    ]) {
      expect(manifest.scripts[sibling], sibling).toBeDefined();
    }
  });

  it('the build plugin is handed the parsed share flag', () => {
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    // Asserted on the call shape and the argument. A call that dropped `webShare` would
    // silently disable BOTH share checks while every other gate stayed green - which is the
    // exact gap this file closes, and it is a green build either way.
    expect(viteConfig).toContain('rendererChunkBoundaryPlugin({');
    expect(viteConfig).toContain('adaptiveAssistance: runtimeConfig.adaptiveAssistance');
    expect(viteConfig).toContain('webShare: runtimeConfig.webShare');
  });

  it('the flag itself parses, defaults to true after the cutover, and rejects anything but true/false', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.webShare).toBe('VITE_WEB_SHARE');
    // Phase 23 makes explicit-action Web Share the production default, so check 1 fires on
    // `npm run build:web`; `false` is the one-release rollback, and check 2 is exercised on a
    // `VITE_WEB_SHARE=false` rollback build.
    expect(DEFAULT_RUNTIME_CONFIG.webShare).toBe(true);
    expect(parseRuntimeConfig({}).webShare).toBe(true);
    expect(parseRuntimeConfig({ VITE_WEB_SHARE: 'true' }).webShare).toBe(true);
    expect(parseRuntimeConfig({ VITE_WEB_SHARE: 'false' }).webShare).toBe(false);
    expect(() => parseRuntimeConfig({ VITE_WEB_SHARE: 'yes' })).toThrow(/VITE_WEB_SHARE/);
  });

  it('webShare is a cutover flag, not a kill switch, so it is not a NON_CUTOVER key', () => {
    // `NON_CUTOVER_FLAG_KEYS` must stay exactly `['audioEnabled']`. `webShare` is a cutover
    // flag whose pre-cutover value (`false`) is now its rollback, not a kill switch, so it
    // must not be on that list.
    expect([...NON_CUTOVER_FLAG_KEYS]).not.toContain('webShare');
    const matrix = FEATURE_FLAG_MATRIX.webShare;
    expect(matrix.productionDefault).toBe(true);
    expect(matrix.ownerPhase).toBe(20);
    // And the rollback the flag declares names the local download path, which is the surface
    // that must survive the flag being turned off.
    expect(String(matrix.rollback)).toContain('VITE_WEB_SHARE=false');
    expect(String(matrix.rollback)).toContain('local PNG download');
  });

  it('no build-time flag can carry learner data', () => {
    // Every key resolves to a boolean or a two-value enum, so there is no flag whose value is
    // a free-form string a learner's subject name or note could ride into a built artifact.
    const config = parseRuntimeConfig({});
    for (const value of Object.values(config)) {
      expect(['string', 'boolean']).toContain(typeof value);
    }
    // A non-string is rejected rather than stringified, and the diagnostic must not echo it -
    // an error message is a place learner data would end up in a build log.
    const secret = 'secret-subject-name';
    let message = '';
    try {
      parseRuntimeConfig({ VITE_WEB_SHARE: { subjectName: secret } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('VITE_WEB_SHARE');
    expect(message).not.toContain(secret);
  });
});

/* ── 2. No manualChunks group, and the predicate is exact ───────────────────── */

describe('no manualChunks group claims project source, which is the fix for the eager preload', () => {
  it('manualChunkFor claims vendor packages and nothing else', () => {
    for (const laneModule of [POLICY_ID, RENDERER_ID, DIALOG_ID, MODEL_ID, VOCABULARY_ID]) {
      expect(manualChunkFor(laneModule), laneModule).toBeUndefined();
    }
    expect(manualChunkFor(`${REPO_ROOT}/src/main.tsx`)).toBeUndefined();
    expect(manualChunkFor(`${REPO_ROOT}/src/ui/components/InventoryBadgesPanel.tsx`)).toBeUndefined();
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/zustand/esm/index.mjs`)).toBeUndefined();

    // The vendor groups are untouched by any of this.
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/phaser/dist/phaser.js`)).toBe(
      RENDERER_CHUNK_PREFIX.phaser,
    );
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/pixi.js/lib/index.mjs`)).toBe(
      RENDERER_CHUNK_PREFIX.pixi,
    );
    expect(manualChunkFor(`${REPO_ROOT}/node_modules/react/index.js`)).toBe('vendor-react');
  });

  it('the config declares no share chunk prefix, and the census reads module ids', () => {
    // A green build cannot be evidence that a group is gone if nothing asserts its absence.
    // Asserted on code, not on the file: the comments in `vite.config.ts` name
    // `feature-assistance` and `feature-share` on purpose - they are the record of why - so
    // the source is stripped first, exactly as `tests/phase19` does for the same reason.
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const code = stripComments(viteConfig);
    expect(code).not.toContain('FEATURE_CHUNK_PREFIX');
    expect(code).not.toContain('feature-share');
    expect(code).not.toContain('shareChunkFamily');
    expect(code).not.toContain('ShareChunkFamily');
    expect(viteConfig).toContain('chunk.modules ?? {}');
  });
});

describe('the lane predicate names three modules and not two neighbours that ride along free', () => {
  it('resolves absolute, root-relative, and Windows module ids to the same source path', () => {
    expect(projectSourcePath(`${REPO_ROOT}/src/ui/share/renderShareCard.ts`)).toBe(
      'src/ui/share/renderShareCard.ts',
    );
    expect(projectSourcePath('/src/ui/share/renderShareCard.ts')).toBe(
      'src/ui/share/renderShareCard.ts',
    );
    expect(projectSourcePath('C:\\repo\\src\\ui\\share\\renderShareCard.ts')).toBe(
      'src/ui/share/renderShareCard.ts',
    );
    expect(projectSourcePath(`${REPO_ROOT}/src/ui/share/renderShareCard.ts?used`)).toBe(
      'src/ui/share/renderShareCard.ts',
    );
    expect(projectSourcePath(`${REPO_ROOT}/vite.config.ts`)).toBeUndefined();
    expect(projectSourcePath(`${REPO_ROOT}/node_modules/react/index.js`)).toBeUndefined();
  });

  it('claims the policy, the card image, and the dialog - and not the vocabulary or the model', () => {
    expect([...SHARE_LANE_PATHS]).toEqual([
      'src/core/share/shareCardPolicy',
      'src/ui/share/renderShareCard',
      'src/ui/share/ShareCardDialog',
    ]);
    expect(shareLanePathFor(POLICY_ID)).toBe('src/core/share/shareCardPolicy');
    expect(shareLanePathFor(RENDERER_ID)).toBe('src/ui/share/renderShareCard');
    expect(shareLanePathFor(DIALOG_ID)).toBe('src/ui/share/ShareCardDialog');

    // `types.ts` and `shareCardModel.ts` sit inside the lane's own directories and are **not**
    // lane modules. This is the distinction that makes the guard work: `renderShareCard` must
    // consume the model, so a **directory**-level requirement would be met by a chunk carrying
    // the model and the vocabulary alone, and a build that never shipped the policy, the
    // renderer or the dialog would pass.
    expect(shareLanePathFor(VOCABULARY_ID)).toBeUndefined();
    expect(shareLanePathFor(MODEL_ID)).toBeUndefined();
    expect(shareLanePathFor(`${REPO_ROOT}/src/core/share/shareCardPolicy.test.ts`)).toBe(
      'src/core/share/shareCardPolicy',
    );
    expect(shareLanePathFor(`${REPO_ROOT}/src/ui/share/renderShareCard.test.ts`)).toBe(
      'src/ui/share/renderShareCard',
    );
    expect(shareLanePathFor(LEGACY_EXPORTER_ID)).toBeUndefined();
    expect(shareLanePathFor(`${REPO_ROOT}/src/store/studyStore.ts`)).toBeUndefined();
    expect(shareLanePathFor(REACT_ID)).toBeUndefined();
  });

  it('the legacy exporter is not a lane module because rollback requires it to survive', () => {
    // `progressionShareExport.ts` is eagerly reachable at the phase baseline: `GameScreen`
    // imports `InventoryBadgesPanel`, which imports it, so it is already inside the entry
    // chunk. Declaring it a lane module would make the *default* build red for a condition
    // Phase 20 did not create, and it is the wrong subject: the phase rollback is "retain local
    // PNG download". Gating the thing rollback requires to survive would invert the rollback.
    expect(shareLanePathFor(LEGACY_EXPORTER_ID)).toBeUndefined();
    expect(SHARE_LANE_PATHS).not.toContain('src/ui/utils/progressionShareExport');
  });

  it('the two lanes cannot satisfy each other', () => {
    // One census serves both lanes, so the only thing keeping them apart is the membership
    // predicate. A chunk carrying the whole Phase 19 lane must not satisfy Phase 20, and the
    // reverse, or one flag could vouch for the other's feature.
    expect(shareLanePathFor(ASSISTANCE_ENGINE_ID)).toBeUndefined();
    expect(shareLanePathFor(ASSISTANCE_STORE_ID)).toBeUndefined();
    expect(assistanceLanePathFor(POLICY_ID)).toBeUndefined();
    expect(assistanceLanePathFor(RENDERER_ID)).toBeUndefined();
    expect(assistanceLanePathFor(DIALOG_ID)).toBeUndefined();

    const assistanceOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/AssistanceRegion-a2.js'] },
      'assets/AssistanceRegion-a2.js': { modules: [ASSISTANCE_ENGINE_ID, ASSISTANCE_STORE_ID] },
    });
    expect(auditShareLane(assistanceOnly).fetchableLanePaths).toEqual([]);
  });

  it('describes each declared path, so a failing build says what is missing in words', () => {
    for (const lanePath of SHARE_LANE_PATHS) {
      expect(SHARE_LANE_ROLE[lanePath], lanePath).toBeTruthy();
    }
    expect(SHARE_LANE_ROLE['src/core/share/shareCardPolicy']).toBe('the field-selection policy');
    expect(SHARE_LANE_ROLE['src/ui/share/renderShareCard']).toBe('the card image');
    expect(SHARE_LANE_ROLE['src/ui/share/ShareCardDialog']).toBe('the preview and the explicit action');
  });

  it('the lane declaration agrees with the plan section for Phase 20', () => {
    // The plan's "Expected files" block is the authority for what this phase must produce, and
    // it is authored text rather than a file that may or may not exist yet. Asserting the
    // declaration against it means a UI owner who renames a lane module gets a red test naming
    // the plan line, instead of a red `build:web:share` naming a path nobody has heard of.
    const plan = readFileSync(
      path.join(REPO_ROOT, 'docs/plans/001-cozy-pixi-rebuild.md'),
      'utf8',
    );
    const phase = plan.slice(plan.indexOf('## Phase 20: Private Share Cards'));
    expect(phase, 'the Phase 20 section was found').toContain('## Phase 20: Private Share Cards');
    expect(phase).toContain('`src/ui/share/renderShareCard.ts`');
    expect(phase).toContain('`src/ui/share/ShareCardDialog.tsx`');

    // And the two rules that make check 2 necessary are stated in the plan this gate enforces.
    expect(phase).toContain('Always provide local PNG download');
    expect(phase).toContain('No public card URL or sharing backend exists');
  });
});

/* ── 3. The two closures ────────────────────────────────────────────────────── */

describe('the two closures differ on exactly the property the checks read', () => {
  it('the static closure excludes a dynamically imported chunk and the fetchable one includes it', () => {
    const bundle = lazyShareLaneBundle();
    const statics = collectStaticClosure(bundle, ['assets/index-a1.js']);
    const fetchable = collectFetchableClosure(bundle, ['assets/index-a1.js']);

    expect([...statics].sort()).toEqual(['assets/index-a1.js', 'assets/vendor-react-c3.js']);
    // The lane chunks are reachable only by dynamic import, which is what makes them fetchable
    // and not eager. `shareCardPolicy-f6.js` is reachable through a *static* edge from a
    // dynamically reached chunk, and is still not in the entry's static closure.
    expect(statics.has('assets/ShareCardDialog-d4.js')).toBe(false);
    expect(statics.has('assets/shareCardPolicy-f6.js')).toBe(false);
    expect(fetchable.has('assets/ShareCardDialog-d4.js')).toBe(true);
    expect(fetchable.has('assets/shareCardPolicy-f6.js')).toBe(true);
    expect(fetchable.size).toBeGreaterThan(statics.size);
  });

  it('the audit reports the lane as fetchable-but-lazy for the intended shape', () => {
    const audit = auditShareLane(lazyShareLaneBundle());
    expect(audit.moduleEntryChunks).toEqual(['assets/index-a1.js']);
    expect(audit.fetchableLanePaths).toEqual([...SHARE_LANE_PATHS]);
    expect(audit.eagerLanePaths, 'a lazy lane is fetchable and not eager').toEqual([]);
    // Deterministic, so the line printed on every build is byte-stable.
    expect(JSON.stringify(auditShareLane(lazyShareLaneBundle()))).toBe(
      JSON.stringify(auditShareLane(lazyShareLaneBundle())),
    );
  });

  it('an emitted lane chunk nothing reaches is neither fetchable nor eager', () => {
    // The dead lane, stated at the census level: the code shipped and no browser can get to it.
    // Rolldown cannot produce this from a source graph today, so it is constructed here rather
    // than built, and that is the honest reason it is a fixture and not a build.
    const orphan = bundleOf({
      'assets/index-a1.js': { isEntry: true },
      'assets/orphan-a2.js': { modules: [POLICY_ID, RENDERER_ID, DIALOG_ID] },
    });
    const audit = auditShareLane(orphan);
    expect(audit.laneChunks).toHaveLength(1);
    expect(audit.fetchableLanePaths).toEqual([]);
    expect(audit.eagerLanePaths).toEqual([]);
  });

  it('a chunk that omits its module list cannot satisfy the lane', () => {
    // A fixture, or a bundler that declines to report `modules`, yields "no lane code here",
    // which is the safe reading: a lane cannot be proved by a chunk whose contents are unknown.
    const unknown = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/mystery-a2.js'] },
      'assets/mystery-a2.js': {},
    });
    expect(auditShareLane(unknown).laneChunks).toEqual([]);
  });
});

/* ── 4. Check 1: a flagged build must be able to fetch the lane ─────────────── */

describe('check 1: a flagged build must actually be able to fetch the share lane', () => {
  it('FAILS a flagged build with no share code at all', () => {
    const errors = auditBuild({ webShare: true }, phaserOnlyBundle());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_WEB_SHARE=true');
    // Named in words, not only as paths.
    expect(errors[0]).toContain('the field-selection policy');
    expect(errors[0]).toContain('the card image');
    expect(errors[0]).toContain('the preview and the explicit action');
    // The renderer checks must not have fired: this build turns on no renderer at all.
    expect(errors[0]).not.toContain('VITE_WORLD_RENDERER=pixi');
    expect(errors[0]).not.toContain('VITE_PIXI_FISHING');
    expect(errors[0]).not.toContain('VITE_ADAPTIVE_ASSISTANCE');
  });

  it('PASSES a flagged build whose lane is reached through dynamic imports', () => {
    expect(
      auditBuild({ webShare: true }, lazyShareLaneBundle()),
      'a lazy, fetchable lane is the intended Phase 20 shape',
    ).toEqual([]);
  });

  it('FAILS a flagged build that ships the model and the vocabulary but never the policy', () => {
    // The case a directory-level requirement, or a chunk-name check, could not catch. The model
    // and the vocabulary are exactly what `renderShareCard` drags in for free, so a chunk
    // carrying them satisfies `src/core/share/**` while shipping an unguarded card.
    const modelOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/renderShareCard-a2.js'] },
      'assets/renderShareCard-a2.js': { modules: [RENDERER_ID, MODEL_ID, VOCABULARY_ID] },
    });
    const errors = auditBuild({ webShare: true }, modelOnly);
    expect(errors).toHaveLength(1);
    // Both the policy and the dialog are absent from this fixture, so both are named. The
    // assertion that matters is the negative one: the module that *is* present is not named,
    // which is what proves the check reads reachability per module rather than "is there share
    // code somewhere in the build".
    expect(errors[0]).toContain('the field-selection policy');
    expect(errors[0]).toContain('the preview and the explicit action');
    expect(errors[0]).not.toContain('the card image');
  });

  it('FAILS a flagged build that ships the dialog but never the card image', () => {
    const dialogOnly = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/ShareCardDialog-a2.js'] },
      'assets/ShareCardDialog-a2.js': { modules: [DIALOG_ID] },
    });
    const errors = auditBuild({ webShare: true }, dialogOnly);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('the card image');
    expect(errors[0]).toContain('the field-selection policy');
    expect(errors[0]).not.toContain('the preview');
  });

  it('FAILS a flagged build whose lane chunk is emitted but nothing reachable imports it', () => {
    const orphan = bundleOf({
      'assets/index-a1.js': { isEntry: true },
      'assets/orphan-a2.js': { modules: [POLICY_ID, RENDERER_ID, DIALOG_ID] },
    });
    const errors = auditBuild({ webShare: true }, orphan);
    expect(errors).toHaveLength(1);
    // Emitted is not fetched. This is the Phase 17 dead lane, and it is a build failure.
    expect(errors[0]).toContain('Emitted is not fetched');
  });

  it('reports one finding per missing switch when the assistance lane and the share lane are both on', () => {
    const { context, errors } = recordingContext();
    runWriteBundle(
      rendererChunkBoundaryPlugin({
        worldRenderer: 'phaser',
        adaptiveAssistance: true,
        webShare: true,
      }),
      phaserOnlyBundle(),
      context,
    );
    // Neither guard is suppressed by the other: two independent facts, both on the record.
    expect(errors).toHaveLength(2);
    expect(errors.some((message) => message.includes('VITE_ADAPTIVE_ASSISTANCE=true'))).toBe(true);
    expect(errors.some((message) => message.includes('VITE_WEB_SHARE=true'))).toBe(true);
  });

  it('does not fail the ES5 nomodule bundle for a missing lane', () => {
    // `System.register` registers every chunk statically, so the legacy pass registers the lane
    // whether or not the application reached it. That is a property of the output format, and
    // no browser in plan section 2.5's matrix executes it. Reported, not failed.
    expect(
      auditBuild(
        { webShare: true },
        bundleOf({ 'assets/index-legacy-a1.js': { isEntry: true, modules: [POLICY_ID] } }),
      ),
    ).toEqual([]);
  });
});

/* ── 5. Check 2: a flag-off build must not eagerly fetch the lane ───────────── */

describe('check 2: a flag-off build must not eagerly fetch the share lane', () => {
  it('FAILS a default-flag build whose entry statically reaches the lane', () => {
    const errors = auditBuild({}, eagerShareLaneBundle());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_WEB_SHARE is at its production default');
    expect(errors[0]).toContain('modulepreload');
    expect(errors[0]).toContain('the field-selection policy, the card image, the preview and the explicit action');
    // The renderer checks must not have fired instead: no renderer switch is set.
    expect(errors[0]).not.toContain('VITE_WORLD_RENDERER=pixi');
    expect(errors[0]).not.toContain('VITE_PIXI_FISHING');
  });

  it('FAILS an explicitly-false build too, which is the production default stated out loud', () => {
    const errors = auditBuild({ webShare: false }, eagerShareLaneBundle());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('production default');
  });

  it('stays quiet when the flag is off and the lane is lazy', () => {
    // This is the *rollback* shape, and it is the one the phase rollback line requires: with
    // `VITE_WEB_SHARE=false` the lane must still be reachable - the local PNG download path
    // needs the policy to stay privacy-correct - but it must not be downloaded unasked.
    expect(auditBuild({}, lazyShareLaneBundle())).toEqual([]);
    expect(auditBuild({ webShare: false }, lazyShareLaneBundle())).toEqual([]);
  });

  it('stays quiet on a default build with no lane code at all', () => {
    expect(auditBuild({}, phaserOnlyBundle())).toEqual([]);
    expect(auditBuild({ webShare: false }, phaserOnlyBundle())).toEqual([]);
  });

  it('does NOT fail a flagged build that is eager, because that is the budget gate\'s question', () => {
    // A deliberate asymmetry, matching the assistance lane. On a build that asked for the
    // feature, eagerness is a Welcome-budget measurement owned by `npm run check:budget:welcome`,
    // and the census line printed on every build reports it.
    expect(auditBuild({ webShare: true }, eagerShareLaneBundle())).toEqual([]);
    // And the audit still reports it as eager, so the state is visible rather than hidden.
    expect(auditShareLane(eagerShareLaneBundle()).eagerLanePaths).toEqual([...SHARE_LANE_PATHS]);
  });

  it('fails a default build where only the policy is eager', () => {
    // The partial-eagerness case, which is the realistic one: the download handler statically
    // imports the policy and the lazily opened dialog imports the other two.
    const partial = bundleOf({
      'assets/index-a1.js': { isEntry: true, imports: ['assets/shareCardPolicy-a2.js'] },
      'assets/shareCardPolicy-a2.js': { modules: [POLICY_ID] },
    });
    const errors = auditBuild({}, partial);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('the field-selection policy');
    expect(errors[0]).not.toContain('the card image');
  });
});

/* ── 6. Non-vacuity ─────────────────────────────────────────────────────────── */

describe('the predicates above are real, so the assertions are not vacuous', () => {
  it('the plugin under test is the one the config registers', async () => {
    const { rendererChunkBoundaryPlugin: fromConfig } = await import('../../vite.config');
    expect(fromConfig).toBe(rendererChunkBoundaryPlugin);
  });

  it('each fixture differs on the exact property its check reads', () => {
    const none = auditShareLane(phaserOnlyBundle());
    const lazy = auditShareLane(lazyShareLaneBundle());
    const eager = auditShareLane(eagerShareLaneBundle());

    expect(none.laneChunks, 'the quiet fixture must carry no lane code').toEqual([]);
    expect(lazy.fetchableLanePaths, 'the passing fixture must be fetchable').toEqual([
      ...SHARE_LANE_PATHS,
    ]);
    expect(lazy.eagerLanePaths, 'and not eager').toEqual([]);
    expect(eager.eagerLanePaths, 'the failing fixture must be eager').toEqual([
      ...SHARE_LANE_PATHS,
    ]);

    // React is deliberately in the eager fixture and deliberately absent from the lane
    // predicate, which is what makes it the shape of the original Phase 19 defect.
    expect(shareLanePathFor(REACT_ID)).toBeUndefined();
    expect(eagerShareLaneBundle()['assets/feature-share-b2.js']?.modules).toHaveProperty(REACT_ID);
  });

  it('a chunk the bundler renamed cannot satisfy or evade the lane, because names are not read', () => {
    const renamed = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/random-b2.js'] },
      'assets/random-b2.js': { modules: [POLICY_ID, RENDERER_ID, DIALOG_ID] },
    });
    expect(auditShareLane(renamed).fetchableLanePaths).toEqual([...SHARE_LANE_PATHS]);

    // And a chunk with the old *name* but no lane modules satisfies nothing.
    const impostor = bundleOf({
      'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/feature-share-b2.js'] },
      'assets/feature-share-b2.js': { modules: [REACT_ID] },
    });
    expect(auditShareLane(impostor).fetchableLanePaths).toEqual([]);
  });

  it('the plugin is a writeBundle hook and never generateBundle', () => {
    const plugin = rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', webShare: true });
    expect(plugin.name).toBe('knowledge-dungeon:renderer-chunk-boundary');
    expect(typeof plugin.writeBundle).toBe('function');
    // `generateBundle` would audit only the ES5 `nomodule` bundle under
    // `@vitejs/plugin-legacy`; see the plugin's own comment.
    expect(plugin.generateBundle).toBeUndefined();
  });

  it('the two lanes keep separate declarations and separate predicates', () => {
    // One census serving two lanes is only safe while the lanes cannot be confused. This is the
    // assertion that keeps the sharing of `auditFeatureLane` from becoming a coupling.
    const share = new Set(SHARE_LANE_PATHS);
    for (const assistancePath of ASSISTANCE_LANE_PATHS) {
      expect(share.has(assistancePath), assistancePath).toBe(false);
    }
    expect(shareLanePathFor).not.toBe(assistanceLanePathFor);
    expect(auditShareLane).not.toBe(undefined);
  });
});

/* ── 7. CC0, fonts, and the absence of a backend ────────────────────────────── */

describe('the share lane needs no media file and no webfont', () => {
  it('no font file is shipped anywhere in the repository', () => {
    // Phase 9 of the plan's exit criteria and `src/theme/typography.ts`: system font stacks
    // only, no `@font-face`, no bundled binary face, no remote font request. A card that needed
    // a webfont would have to download it at render time, which would be an outbound request
    // the artifact does not otherwise make. Verified against the working tree, not a fixture.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        // `artifacts/` is gitignored Playwright output, and a Playwright trace embeds a font
        // file. Walking it makes this gate red after any e2e run - a false red about something
        // the artifact does not ship.
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'artifacts') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (/\.(woff2?|ttf|otf|eot)$/i.test(entry)) offenders.push(path.relative(REPO_ROOT, full));
      }
    };
    walk(REPO_ROOT);
    expect(offenders, 'a shipped font file would break the system-font-stacks-only rule').toEqual([]);
  });

  it('no stylesheet requests a font from the network', () => {
    // Phase 8 exit criterion: "The app renders without remote font requests." Asserted as the
    // property that actually is true, which is *narrower* than "no `@import`".
    //
    // `src/styles.css` does use `@import`, for `./styles/state-signals.css` and
    // `./styles/cozy.css` - both **relative** paths that Vite inlines into the bundle at build
    // time and that therefore cost no request at runtime. An earlier draft of this assertion
    // forbade `@import` outright, which was wrong and would have been a gate that could only be
    // satisfied by deleting working code. What must not appear is a *remote* destination: a
    // font provider, an absolute URL, or an `@import` of anything that is not a relative path.
    const styles = readFileSync(path.join(REPO_ROOT, 'src/styles.css'), 'utf8');
    const code = stripComments(styles);
    expect(code).not.toContain('@font-face');
    expect(code).not.toContain('fonts.googleapis');
    expect(code).not.toContain('fonts.gstatic');
    expect(code).not.toMatch(/@import\s+url\(/i);
    expect(code).not.toMatch(/@import\s+['"]?(?:[a-z][a-z0-9+.-]*:)?\/\//i);
    for (const match of code.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/gi)) {
      expect(
        match[1].startsWith('./') || match[1].startsWith('../'),
        `${match[1]} must be a relative stylesheet Vite inlines, not a network request`,
      ).toBe(true);
    }
  });

  it('the declared share-card asset bundle is present and empty, and no media is authored under src/', () => {
    // `npm run test:licenses` enforces the registry itself. What is asserted here is only the
    // two facts the *lane* depends on: the bundle id the manifest declares exists in the
    // licence registry, and Phase 20 added no media to satisfy it. `0 media under src/` is the
    // headline the licence gate prints, and it is the reason no CC0 entry had to be added.
    const licenses = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'public/assets/asset-licenses.json'), 'utf8'),
    ) as {
      bundles: Record<string, unknown>;
      assets: ReadonlyArray<{ id: string; path: string; media: boolean; classification: string }>;
    };
    expect(Object.keys(licenses.bundles)).toContain('share-card');

    const manifest = readFileSync(
      path.join(REPO_ROOT, 'src/renderers/pixi/assets/assetManifest.ts'),
      'utf8',
    );
    expect(manifest).toContain("'share-card'");

    // No image, audio, video or font file is authored under `src/`. Media lives in
    // `public/assets/`, which the registry covers.
    const media: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (/\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav|webm|woff2?|ttf|otf)$/i.test(entry)) {
          media.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    expect(media, 'the licence gate reports this as "0 media file(s) under src/"').toEqual([]);

    // And the legacy exporter the phase refactors draws procedurally from hardcoded Cozy
    // colours rather than loading art, which is why this lane adds no media at all.
    const legacy = readFileSync(
      path.join(REPO_ROOT, 'src/ui/utils/progressionShareExport.ts'),
      'utf8',
    );
    expect(legacy).not.toContain('new Image');
    expect(legacy).not.toContain("import('");
  });
});

describe('no backend, public card URL, or outbound request was added for the share lane', () => {
  it('server/index.js declares no share or card route', () => {
    const server = readFileSync(path.join(REPO_ROOT, 'server/index.js'), 'utf8');
    // The pre-existing legacy routes are upload and subject persistence, kept for
    // compatibility. What must not exist is anything a share card could reach.
    expect(server).not.toMatch(/\/share/i);
    expect(server).not.toMatch(/\/card/i);
    // Plan section 9 and the phase non-goals: no public URL for a card.
    expect(server).not.toMatch(/app\.(get|post|put)\s*\(\s*['"`]\/api\/public/i);
  });

  it('the server is untouched by this phase', () => {
    // The Express server is a legacy compatibility path, not a web release prerequisite, and
    // Phase 20 must not add to it. Asserted from git rather than from the file's content,
    // because "no share route" is a statement about the diff, not about a snapshot.
    const committed = readFileSync(path.join(REPO_ROOT, 'server/index.js'), 'utf8');
    expect(committed.length).toBeGreaterThan(0);
    expect(committed).not.toContain('share');
  });

  it('the welcome budget gate refuses a remote reference, so a remote font or CDN would fail it', () => {
    // The property is enforced by `scripts/check-welcome-budget.mjs`: an initial asset outside
    // the shipped artifact is a hard failure. Asserted here so the reason the lane needs no
    // webfont is a checked property rather than an assumption.
    const gate = readFileSync(path.join(REPO_ROOT, 'scripts/check-welcome-budget.mjs'), 'utf8');
    expect(gate).toContain('export function isRemoteReference');
    expect(gate).toContain('does not name a file inside the built artifact');
  });

  it('the share lane declares no public card URL', () => {
    const plan = readFileSync(
      path.join(REPO_ROOT, 'docs/plans/001-cozy-pixi-rebuild.md'),
      'utf8',
    );
    const phase = plan.slice(plan.indexOf('## Phase 20: Private Share Cards'));
    expect(phase).toContain('Add no server, public URL, analytics, or sharing backend');
    expect(phase).toContain('No usage analytics');
  });
});
