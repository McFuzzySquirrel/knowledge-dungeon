/**
 * The Phase 17 flag gate: `VITE_PIXI_FISHING` is a build-time switch, and the default
 * artifact ships no Pixi fishing chunk.
 *
 * ## What this file asserts, and what only a build can
 *
 * Phase 13's `tests/phase13/dungeon-flag-boundary.test.ts` is the pattern, and the reason
 * its checks are *source* checks is stated in its own header: a source scan cannot prove the
 * built artifact is lazy. It can prove the switch is a foldable literal, which is the
 * mechanism the folding depends on, and it can prove the parsed flag is what produces the
 * mismatch message. So this file asserts:
 *
 * 1. the flag's declaration - Phase 17 owner, production default still `false`, and a rollback
 *    line that means something;
 * 2. `runtimeConfig.pixiFishing` parses in all three spellings, identically to `pixiDungeon`;
 * 3. the switch is a **literal** `=== 'true'` comparison, with no normalisation before it -
 *    the reason the folding works;
 * 4. both arms of the switch exist: the Pixi dynamic import and the Phaser dynamic import,
 *    each behind the same literal;
 * 5. the fishing host resolution goes through `resolveFishingHost`, which prefers the Pixi
 *    lane and falls back to the Phaser one - the binding `src/ui/village/villageStudyFlow.ts`
 *    exists to provide.
 *
 * ## What it deliberately does not claim
 *
 * **That the default artifact contains no chunk.** That is verified against the built files,
 * the way Phase 15 and 16 verified rollback, and it is reported in this phase's evidence
 * rather than asserted here: a unit test that read `dist/` would fail on a checkout that has
 * not been built, and `tests/e2e/web-artifact-manifest.test.ts` is the artifact-shaped gate.
 * What this file contributes is the mechanism: if the literal is foldable, the fold removes
 * the `import()`, and with it the chunk.
 *
 * **That a `VITE_PIXI_FISHING=true` build fails without a chunk.** That used to be an
 * open gap, recorded here as a known limitation rather than assumed: `vite.config.ts`'s
 * `rendererChunkBoundaryPlugin` had a `pixiVillage` and a `pixiDungeon` option and no
 * `pixiFishing` option, and `package.json` had no `build:web:pixi-fishing` script, both
 * because build infra is owned outside this phase. Both have landed, so the gap assertions
 * at the foot of this file became **positive gates**: the plugin is handed the parsed
 * fishing flag and fails a fishing-flagged build that emitted no Pixi chunk, and the build
 * script exists and sets exactly the one flag. A flagged build with no chunk is now a
 * build *failure*, not a green run that measured nothing.
 *
 * Hermeticity: reads repository source and the flag tables. No `dist/`, no build, no network.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_MATRIX } from '../../src/config/featureFlags';
import {
  DEFAULT_RUNTIME_CONFIG,
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
} from '../../src/config/runtimeConfig';
import { REPO_ROOT, sourceOf, stripComments } from '../phase9/support/phase9Build';

/**
 * The screen that holds the switch, and the flow module that holds the host resolution.
 *
 * Two files, deliberately. `VillageScreen.tsx` owns the build-time switches - it already owned
 * `VITE_PIXI_VILLAGE`, and Phase 12's exit criterion refuses *any* `@/renderers` reach from
 * `src/ui/village/**`, so a switch there would have required weakening a gate. The flow module
 * owns `resolveFishingHost`, which is the part that is renderer-neutral.
 */
const VILLAGE_SCREEN = 'src/ui/screens/VillageScreen.tsx';
/**
 * The module that actually holds the flag and the chunk import.
 *
 * A third file, and it is not an accident of tidiness: Phase 12's exit criterion refuses any
 * `@/renderers` reach from `src/ui/village/**`, and its length gate holds
 * `VillageScreen.tsx` under 900 lines. So the switch sits in a module under
 * `src/ui/screens/`, which is neither.
 */
const FISHING_LANE = 'src/ui/screens/PixiFishingLane.tsx';
const VILLAGE_FLOW = 'src/ui/village/villageStudyFlow.ts';
/** The chunk target the switch reaches. */
const PIXI_FISHING_CHUNK = '@/renderers/pixi/fishing/FishingWorld';

/** Static specifiers with comments stripped, so a documented reach is not a live one. */
function staticSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const code = stripComments(source);
  for (const match of code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1] as string);
  for (const match of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1] as string);
  return specifiers;
}

/** Dynamic import specifiers, matched separately so the two are never confused. */
function dynamicSpecifiers(source: string): string[] {
  return [...stripComments(source).matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1] as string,
  );
}

function sourceFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesIn(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

describe('VITE_PIXI_FISHING is a build-time switch whose default is still off', () => {
  it('is declared with the Phase 17 owner and an unchanged production default', () => {
    const definition = FEATURE_FLAG_MATRIX.pixiFishing;
    expect(definition.environmentVariable).toBe('VITE_PIXI_FISHING');
    expect(definition.valueKind).toBe('boolean');
    // The plan's rollback line is "set VITE_PIXI_FISHING=false", which only means something
    // if the default is already false.
    expect(definition.productionDefault).toBe(false);
    expect(definition.ownerPhase).toBe(17);
    expect(definition.rollback).toContain('VITE_PIXI_FISHING=false');
  });

  it('parses exactly as the dungeon flag parses, in all three spellings', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.pixiFishing).toBe('VITE_PIXI_FISHING');
    expect(DEFAULT_RUNTIME_CONFIG.pixiFishing).toBe(false);
    expect(parseRuntimeConfig({}).pixiFishing).toBe(false);
    expect(parseRuntimeConfig({ VITE_PIXI_FISHING: 'false' }).pixiFishing).toBe(false);
    expect(parseRuntimeConfig({ VITE_PIXI_FISHING: 'true' }).pixiFishing).toBe(true);
    expect(parseRuntimeConfig({ VITE_PIXI_FISHING: ' TRUE ' }).pixiFishing).toBe(true);
  });
});

describe('the switch is a literal comparison, so the default build can delete the branch', () => {
  it('reads VITE_PIXI_FISHING exactly once, in one place, against a literal', () => {
    const flow = sourceOf(FISHING_LANE);
    const occurrences = flow.match(/import\.meta\.env\.VITE_PIXI_FISHING === 'true'/g) ?? [];
    expect(occurrences.length, 'the comparison must be a literal in one place').toBe(1);

    // The arm after the comparison is the Pixi chunk, and the *other* arm is `null` - not a
    // second dynamic import of a Phaser factory, because the fishing world is entered from the
    // village's own world rather than by swapping a Phaser scene.
    const arm = flow.slice(flow.indexOf("import.meta.env.VITE_PIXI_FISHING === 'true'"));
    expect(arm.slice(0, 240)).toMatch(
      new RegExp(`import\\('${PIXI_FISHING_CHUNK.replace('/', '\\/')}'\\)`),
    );

    // And no normalisation between the flag and the comparison: `String(raw).trim()` reads the
    // same at run time and defeats dead-branch elimination, which is exactly what would leave a
    // Pixi fishing chunk in the default artifact.
    const beforeComparison = flow.slice(
      0,
      flow.indexOf("import.meta.env.VITE_PIXI_FISHING === 'true'"),
    );
    expect(beforeComparison).not.toMatch(
      /VITE_PIXI_FISHING[^\n]*\.(trim|toLowerCase|toUpperCase)\s*\(/,
    );
  });

  it('the chunk target is reached only through that dynamic import', () => {
    // A *static* import of `FishingWorld` anywhere in the entry graph would put the pond in
    // the default artifact regardless of the flag.
    // A *static* import of `FishingWorld` anywhere in the entry graph would put the pond in the
    // default artifact regardless of the flag, so the target must appear in exactly one place
    // and only inside a `dynamic import`.
    const hits: Array<[string, 'static' | 'dynamic']> = [];
    for (const file of sourceFilesIn(path.join(REPO_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(PIXI_FISHING_CHUNK)) continue;
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (dynamicSpecifiers(source).includes(PIXI_FISHING_CHUNK)) hits.push([relative, 'dynamic']);
      if (staticSpecifiers(source).includes(PIXI_FISHING_CHUNK)) hits.push([relative, 'static']);
    }

    // The screen's second entry is the *type-only* handle import, which `readSpecifiers`-style
    // matching cannot distinguish from a value import by shape alone. It is legal and it is
    // erased at build time - `GameScreen` has the same shape for `DungeonWorldHandle` - so the
    // assertion is on the *form*: exactly one dynamic reach, at most one type-only static
    // reach, and never a value import of the chunk.
    expect(hits.filter(([, form]) => form === 'dynamic')).toEqual([[FISHING_LANE, 'dynamic']]);
    // A static reach of *any* kind would put the pond in the default artifact regardless of the
    // flag, so there must be none: the lane reaches the chunk only through `lazy()`.
    expect(hits.filter(([, form]) => form === 'static')).toEqual([]);
  });

  it('the parsed value is what the lane reports on, and no raw env value is interpolated', () => {
    const flow = sourceOf(FISHING_LANE);
    // The literal decides what the bundler may delete; the *parsed* value is what produces a
    // defined mismatch message rather than a silent fallback.
    expect(flow).toContain("import.meta.env.VITE_PIXI_FISHING === 'true'");
    // And no raw `import.meta.env` value is interpolated into any user-visible string, which
    // would put an environment value into a message.
    expect(stripComments(flow)).not.toMatch(/\{[^}]*import\.meta\.env[^}]*\}/);
  });
});

describe('the fishing host resolves through one function, Pixi first', () => {
  it('isMounted, enter, and exit all go through resolveFishingHost', () => {
    const flow = sourceOf(VILLAGE_FLOW);
    const code = stripComments(flow);

    // One resolver, three call sites. Three independent resolutions would be three chances for
    // `isMounted` and `enter` to disagree about whether a world exists - the Phase 9
    // "one dispatch path" rule, restated for the fishing port.
    expect(code.match(/resolveFishingHost\(\)/g) ?? []).toHaveLength(4);

    // And the resolution prefers the Pixi lane, so a `VITE_PIXI_FISHING=true` build never
    // reaches for a Phaser scene, while the default build - where the Pixi host is `null` -
    // behaves exactly as it did before Phase 17.
    expect(code).toContain(
      'options.readPixiFishingHost() ?? options.readPhaserHandle()?.fishing?.() ?? null',
    );
  });

  it('the stale "no fishing world yet" claim is gone from the module that made it', () => {
    const flow = sourceOf(VILLAGE_FLOW);
    // The comment Phase 17 falsified said the Pixi lane has no fishing world. Asserting its
    // absence means the next reader cannot be misled by a leftover from before the phase.
    expect(flow).not.toContain('The Phase 11 Pixi village has no fishing world yet');
    expect(flow).not.toContain('the Pixi path has no fishing world yet');
  });

  it('the screen supplies both lanes, so neither resolve path is dead code', () => {
    const screen = sourceOf('src/ui/screens/VillageScreen.tsx');
    expect(screen).toContain('readPixiFishingHost:');
    expect(screen).toContain('readPhaserHandle:');

    // And the flow module is the part that is renderer-neutral: no engine, no renderer tree.
    expect(
      staticSpecifiers(sourceOf(VILLAGE_FLOW)).some((specifier) =>
        specifier.startsWith('@/renderers'),
      ),
    ).toBe(false);

    // The Pixi host is owned by the *lane* module, not the screen, because the screen's own
    // length gate holds it under 900 lines and Phase 12's refuses any `@/renderers` reach from
    // `src/ui/village/**`. The screen reads the lane and hands the flow one line.
    expect(screen).toContain('readPixiFishingHost: pixiFishingLane.readHost');
    expect(readFileSync(path.join(REPO_ROOT, FISHING_LANE), 'utf8')).toContain('readonly readHost');
  });
});

describe('the Pixi host is published from the build flag, not from a session', () => {
  /**
   * The defect the flagged browser lane caught and no unit test could.
   *
   * `usePixiFishingLane` assigned `hostRef.current` inside the `useEffect` guarded by
   * `session !== null`, and `session` was set **only** by calling `hostRef.current.enter(...)`.
   * So the ref was never assigned, `enter` was never reachable, the effect never ran, and
   * `resolveFishingHost()`'s `??` always fell through to the Phaser handle - on
   * `build:web:pixi-fishing`, which leaves the village on Phaser. The flagged artifact ran the
   * rollback lane and every Phase 17 exit criterion went unmeasured.
   *
   * The order is the whole of the bug, so the order is what is asserted here.
   */
  it('the lane publishes a host whenever the chunk exists, with no session in sight', () => {
    const lane = stripComments(readFileSync(path.join(REPO_ROOT, FISHING_LANE), 'utf8'));
    const host = lane.slice(
      lane.indexOf('const host = useMemo'),
      lane.indexOf('const hostRef = useRef'),
    );

    // Conditioned on the build flag and the built chunk - and on nothing else. A `session` test
    // in this guard is the regression, so it is refused by name.
    expect(host).toContain('if (!pixiFishing || LazyPixiFishingWorld === null) return null;');
    expect(host).not.toContain('session');
    // No `isMounted` test either: "there is a host" and "a pond is running" are different
    // questions, and collapsing them is what would make a build with no pond claim to be fishing.
    expect(host).not.toContain('isMounted');
  });

  it('the ref is written during render, so the first village interaction finds a host', () => {
    const lane = readFileSync(path.join(REPO_ROOT, FISHING_LANE), 'utf8');
    // `useRef(host)` initialised, then reassigned each render. An effect would leave a window in
    // which `readHost()` answered `null` on a build that has a pond.
    expect(lane).toContain('const hostRef = useRef<VillageFishingHost | null>(host);');
    expect(lane).toContain('hostRef.current = host;');
  });

  it('"a host exists" and "a pond is running" are separate members, and the docs say so', () => {
    const lane = readFileSync(path.join(REPO_ROOT, FISHING_LANE), 'utf8');
    // Two names, so the distinction cannot be lost by reading one as the other.
    expect(lane).toContain('readonly readHost: () => VillageFishingHost | null;');
    expect(lane).toContain('readonly session: PixiFishingSession | null;');
    // And the surface renders on `session` alone, so a pre-session host renders nothing - which
    // is what keeps `data-world` from claiming a pond that was never mounted.
    expect(lane).toContain(
      'if (!pixiFishing || LazyPixiFishingWorld === null || session === null) return null;',
    );
  });

  it('the host resolves through the same order on both lanes', () => {
    const flow = stripComments(sourceOf(VILLAGE_FLOW));
    // Untouched by the fix, and asserted here so a future "make it not do double duty" edit is a
    // red run rather than a quiet rollback regression. A `VITE_PIXI_FISHING=false` build publishes
    // no Pixi host at all, so `??` reaches the Phaser `FishingScene` exactly as it did before.
    expect(flow).toContain(
      'options.readPixiFishingHost() ?? options.readPhaserHandle()?.fishing?.() ?? null',
    );
  });
});

describe('the renderer tree holds the chunk, the flag, and no Phaser', () => {
  it('the pond is a PixiJS importer the Phase 9 gate names', () => {
    // `createFishingScene.ts` imports the engine to draw with. `tests/phase9/pixi-host-boundary`
    // compares its own list against the files that actually import `pixi.js`, so a new importer
    // is a red run there; this asserts the fishing module is *in* that list, which is the
    // review Phase 17 had to ask for explicitly.
    const gate = readFileSync(
      path.join(REPO_ROOT, 'tests/phase9/pixi-host-boundary.test.ts'),
      'utf8',
    );
    const importersBlock = gate.slice(
      gate.indexOf('const PIXIJS_IMPORTERS'),
      gate.indexOf('];', gate.indexOf('const PIXIJS_IMPORTERS')),
    );
    expect(importersBlock).toContain('src/renderers/pixi/fishing/createFishingScene.ts');
  });

  it('no module in the fishing renderer tree reaches Phaser', () => {
    const offenders: string[] = [];
    for (const file of sourceFilesIn(path.join(REPO_ROOT, 'src/renderers/pixi/fishing'))) {
      for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('@/game') || specifier.startsWith('phaser')) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
        }
      }
    }
    // `FishingScene.ts` is the rollback lane and stays untouched; a Pixi module reaching it
    // would couple the two renderers Phase 24 is meant to separate.
    expect(offenders, 'the Pixi pond must not reach the Phaser rollback lane').toEqual([]);
  });

  it('the flag is read by nothing else, so there is one switch to reason about', () => {
    const readers: string[] = [];
    for (const file of sourceFilesIn(path.join(REPO_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      // `runtimeConfig.pixiFishing` is a legitimate second read (the parsed value), and it is
      // asserted separately; the *literal* comparison is the one that must be unique.
      if (source.includes("import.meta.env.VITE_PIXI_FISHING === 'true'")) {
        readers.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'));
      }
    }
    expect(readers).toEqual([FISHING_LANE]);
  });
});

/* ── The build-side wiring, which now closes the loop this phase could only record ── */

describe('the flagged build has a script and a chunk gate of its own', () => {
  it('there is a build:web:pixi-fishing script, and it sets exactly the fishing flag', () => {
    // The three sibling lanes each have one. The shape is load-bearing rather than
    // cosmetic: `build:web:pixi-fishing` sets only `VITE_PIXI_FISHING`, so the *other*
    // three chunk checks (the renderer switch, the village, the dungeon) all sit on
    // their production defaults and none of them can see this build. That is what makes
    // a fishing-specific chunk gate necessary rather than redundant.
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts['build:web:pixi-village']).toBeDefined();
    expect(manifest.scripts['build:web:pixi-dungeon']).toBeDefined();
    expect(manifest.scripts['build:web:pixi-fishing']).toBe(
      'VITE_PIXI_FISHING=true npm run build:web',
    );
    expect(manifest.scripts['build:web:pixi-fishing']).not.toContain('VITE_WORLD_RENDERER');
    expect(manifest.scripts['build:web:pixi-fishing']).not.toContain('VITE_PIXI_VILLAGE');
    expect(manifest.scripts['build:web:pixi-fishing']).not.toContain('VITE_PIXI_DUNGEON');
  });

  it('the build plugin is handed the parsed fishing flag', () => {
    const viteConfig = sourceOf('vite.config.ts');
    // On the call shape and each argument rather than on one exact line, matching the
    // Phase 11 and Phase 13 additions. A call that dropped `pixiFishing` would silently
    // disable the Phase 17 check while every other gate stayed green - which is exactly
    // what this file previously recorded as a gap.
    expect(viteConfig).toContain('rendererChunkBoundaryPlugin({');
    expect(viteConfig).toContain('worldRenderer: runtimeConfig.worldRenderer');
    expect(viteConfig).toContain('pixiVillage: runtimeConfig.pixiVillage');
    expect(viteConfig).toContain('pixiDungeon: runtimeConfig.pixiDungeon');
    expect(viteConfig).toContain('pixiFishing: runtimeConfig.pixiFishing');
  });

  it('the plugin declares the fishing option and fails a flagged build with no Pixi chunk', async () => {
    const { rendererChunkBoundaryPlugin } = await import('../../vite.config');
    const errors: string[] = [];
    const context = {
      error(message: string) {
        errors.push(message);
      },
    };
    const phaserOnly = {
      'assets/index-a1.js': {
        isEntry: true,
        fileName: 'assets/index-a1.js',
        imports: ['assets/vendor-phaser-b2.js'],
      },
      'assets/vendor-phaser-b2.js': { fileName: 'assets/vendor-phaser-b2.js' },
    };
    const run = (options: { pixiFishing?: boolean }): void => {
      const plugin = rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', ...options });
      const hook = plugin.writeBundle as (options: unknown, bundle: unknown) => void;
      hook.call(context, {}, phaserOnly);
    };

    // A build that asked for the pond and emitted no Pixi chunk has set a variable and
    // read nothing, which is the shape of a check that measures nothing.
    run({ pixiFishing: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_PIXI_FISHING=true');
    // The renderer check owns the other three switches' verdict and must not have fired
    // instead: the fishing build leaves `VITE_WORLD_RENDERER=phaser`.
    expect(errors[0]).not.toContain('VITE_WORLD_RENDERER=pixi');
    expect(errors[0]).not.toContain('VITE_PIXI_VILLAGE');
    expect(errors[0]).not.toContain('VITE_PIXI_DUNGEON');

    // The default build is unaffected, and so is an explicitly-off flag: the production
    // default is a Phaser build with no pond in it and must keep passing.
    errors.length = 0;
    run({});
    expect(errors).toEqual([]);
    errors.length = 0;
    run({ pixiFishing: false });
    expect(errors).toEqual([]);
  });

  it('a fishing-flagged build that DID emit a lazy Pixi chunk passes', async () => {
    const { rendererChunkBoundaryPlugin } = await import('../../vite.config');
    const errors: string[] = [];
    const plugin = rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', pixiFishing: true });
    const hook = plugin.writeBundle as (options: unknown, bundle: unknown) => void;
    hook.call(
      { error: (message: string) => errors.push(message) },
      {},
      {
        'assets/index-a1.js': {
          isEntry: true,
          fileName: 'assets/index-a1.js',
          imports: ['assets/vendor-phaser-b2.js'],
          dynamicImports: ['assets/vendor-pixi-b2.js'],
        },
        'assets/vendor-phaser-b2.js': { fileName: 'assets/vendor-phaser-b2.js' },
        'assets/vendor-pixi-b2.js': { fileName: 'assets/vendor-pixi-b2.js' },
      },
    );
    // The intended Phase 17 shape: a lazy pond chunk reached through a dynamic import.
    // The Pixi chunk being *present* is what the fishing check requires; plan section
    // 10.2's "no eager Pixi on Welcome" rule is checked independently above it.
    expect(errors, 'a lazy fishing chunk is the intended Phase 17 shape').toEqual([]);
  });
});

/* ── Non-vacuity for the scanner above ──────────────────────────────────────── */

describe('the specifier scanners above are real, so the boundary assertions are not vacuous', () => {
  it('finds a planted static and dynamic reach, and ignores a commented one', () => {
    expect(staticSpecifiers("import { createGame } from '@/game/createGame';")).toEqual([
      '@/game/createGame',
    ]);
    expect(staticSpecifiers("const f = () => import('@/renderers/pixi/fishing/FishingWorld');")).toEqual(
      [],
    );
    expect(dynamicSpecifiers("const f = () => import('@/renderers/pixi/fishing/FishingWorld');")).toEqual(
      [PIXI_FISHING_CHUNK],
    );
    // A comment naming the chunk does not count: a gate is allowed to explain its rule.
    expect(
      dynamicSpecifiers(stripComments("// import('@/renderers/pixi/fishing/FishingWorld');\n")),
    ).toEqual([]);

    // And the two files the file-level assertions read both exist, so a rename cannot leave the
    // assertions passing against nothing.
    expect(existsFile(VILLAGE_FLOW)).toBe(true);
    expect(existsFile(VILLAGE_SCREEN)).toBe(true);
    expect(existsFile(FISHING_LANE)).toBe(true);
    expect(existsFile('src/renderers/pixi/fishing/FishingWorld.tsx')).toBe(true);
    expect(existsFile('src/renderers/pixi/fishing/createFishingScene.ts')).toBe(true);
  });
});

function existsFile(repoRelativePath: string): boolean {
  try {
    readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8');
    return true;
  } catch {
    return false;
  }
}