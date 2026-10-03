/**
 * The dungeon flag, the chunk gate, and the UI/Phaser boundary Phase 11 left open.
 *
 * ## What this file is
 *
 * Three things a reviewer of Phase 13 has to be able to check without reading the diff,
 * each of which was a *deliberate act* somewhere in the last two phases and so has to be
 * a red run rather than a comment:
 *
 * 1. **The flag.** `VITE_PIXI_DUNGEON` is a build-time switch, its production default is
 *    still `false`, and the screen that reads it compares against the *literal* `'true'`
 *    so the bundler can delete the other arm. A normalising call (`String(raw).trim()`)
 *    reads the same at run time and defeats the folding, which would leave a Pixi dungeon
 *    chunk in the default artifact.
 * 2. **The chunk gate.** `build:web:pixi-dungeon` sets only `VITE_PIXI_DUNGEON` and leaves
 *    `VITE_WORLD_RENDERER=phaser`, so the Phase 9 renderer check cannot cover it. The
 *    Phase 11 village gate was widened for exactly that reason and this one is the same
 *    addition; this file asserts the wiring is actually present.
 * 3. **The exception is gone.** Phase 11 recorded `GameScreen.tsx` as the one tolerated
 *    static Phaser reach under `src/ui/**`, "migrated in Phase 13". This phase is that
 *    migration, so the enumeration must now be *empty* - a stronger gate than the one it
 *    replaces, because a gate that allowed a file cannot fail when that file is fixed and
 *    has to be edited to notice.
 *
 * ## Hermeticity
 *
 * Reads repository source only. No `dist/`, no build, no network, no process. The chunk
 * *graph* is `vite.config.ts`'s job and `tests/phase9/renderer-chunk-boundary.test.ts`'s;
 * what is asserted here is that the plugin is wired to read this flag at all, which a
 * build cannot prove for a flag that is not read.
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

const GAME_SCREEN = 'src/ui/screens/GameScreen.tsx';

/** Every static specifier `GameScreen` names, with comments stripped. */
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

/** Every `.ts`/`.tsx` file under a directory, sorted, so a walk is deterministic. */
function sourceFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesIn(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

describe('VITE_PIXI_DUNGEON is a build-time switch whose default is still off', () => {
  it('is declared with the Phase 13 owner and an unchanged production default', () => {
    const definition = FEATURE_FLAG_MATRIX.pixiDungeon;
    expect(definition.environmentVariable).toBe('VITE_PIXI_DUNGEON');
    expect(definition.valueKind).toBe('boolean');
    // The plan's rollback line is "set VITE_PIXI_DUNGEON=false", which only means
    // something if the default is already false.
    expect(definition.productionDefault).toBe(false);
    expect(definition.ownerPhase).toBe(13);
    expect(definition.rollback).toContain('VITE_PIXI_DUNGEON=false');
  });

  it('parses exactly as the village flag parses, in all three spellings', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.pixiDungeon).toBe('VITE_PIXI_DUNGEON');
    expect(DEFAULT_RUNTIME_CONFIG.pixiDungeon).toBe(false);
    expect(parseRuntimeConfig({}).pixiDungeon).toBe(false);
    expect(parseRuntimeConfig({ VITE_PIXI_DUNGEON: 'false' }).pixiDungeon).toBe(false);
    expect(parseRuntimeConfig({ VITE_PIXI_DUNGEON: 'true' }).pixiDungeon).toBe(true);
    expect(parseRuntimeConfig({ VITE_PIXI_DUNGEON: ' TRUE ' }).pixiDungeon).toBe(true);
  });

  it('the screen compares against the literal, so the default build can delete the branch', () => {
    const screen = sourceOf(GAME_SCREEN);
    // Two arms, each with a dynamic import, each behind the same literal comparison.
    // Normalising the flag first (`String(raw).trim().toLowerCase()`) reads the same at
    // run time and defeats dead-branch elimination, which is what would leave a Pixi
    // dungeon chunk in the default artifact. Phase 9 found this on the renderer switch
    // and the village screen repeats it deliberately.
    const occurrences = screen.match(/import\.meta\.env\.VITE_PIXI_DUNGEON === 'true'/g) ?? [];
    expect(occurrences.length, 'the switch must be a literal comparison in one place').toBe(2);

    const arm = screen.slice(screen.indexOf("import.meta.env.VITE_PIXI_DUNGEON === 'true'"));
    expect(arm.slice(0, 240)).toMatch(/import\('@\/renderers\/pixi\/dungeon\/DungeonWorld'\)/);
    expect(arm.slice(0, 600)).toMatch(/import\('@\/game\/createGame'\)/);

    // And no normalisation between the flag and the comparison.
    const beforeComparison = screen.slice(0, screen.indexOf("import.meta.env.VITE_PIXI_DUNGEON === 'true'"));
    expect(beforeComparison).not.toMatch(/VITE_PIXI_DUNGEON[^\n]*\.(trim|toLowerCase|toUpperCase)\s*\(/);
  });

  it('the parsed flag, not the raw value, is what the screen reports on', () => {
    const screen = sourceOf(GAME_SCREEN);
    // The run-time decision reads the parsed config, so a malformed environment value
    // produces a defined mismatch message instead of a silent fallback.
    expect(screen).toContain('runtimeConfig.pixiDungeon');
    // And the mismatch branch must name the condition rather than echo what was passed.
    const mismatch = screen.slice(screen.indexOf('pixiDungeonMismatch'));
    expect(mismatch).toContain('VITE_PIXI_DUNGEON=true');
    expect(mismatch.slice(0, 400)).not.toMatch(/\{[^}]*import\.meta\.env[^}]*\}/);
  });
});

describe('the flagged build has a chunk gate of its own', () => {
  it('the build script sets the dungeon flag and nothing else', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts['build:web:pixi-dungeon']).toBe(
      'VITE_PIXI_DUNGEON=true npm run build:web',
    );
    // `VITE_WORLD_RENDERER` deliberately stays `phaser`, which is what makes a separate
    // gate necessary: the Phase 9 renderer check cannot see this switch.
    expect(manifest.scripts['build:web:pixi-dungeon']).not.toContain('VITE_WORLD_RENDERER');
  });

  it('the build plugin is handed the parsed dungeon flag', () => {
    const viteConfig = sourceOf('vite.config.ts');
    // On the call shape and each argument rather than one exact line, matching the Phase 11
    // addition. Both village and dungeon keys are asserted, because a call that dropped
    // one would silently disable that check while every other gate stayed green.
    expect(viteConfig).toContain('rendererChunkBoundaryPlugin({');
    expect(viteConfig).toContain('worldRenderer: runtimeConfig.worldRenderer');
    expect(viteConfig).toContain('pixiVillage: runtimeConfig.pixiVillage');
    expect(viteConfig).toContain('pixiDungeon: runtimeConfig.pixiDungeon');
  });

  it('the plugin declares the dungeon option and fails a flagged build with no Pixi chunk', async () => {
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
    const run = (options: { pixiDungeon?: boolean }): void => {
      const plugin = rendererChunkBoundaryPlugin({ worldRenderer: 'phaser', ...options });
      const hook = plugin.writeBundle as (
        options: unknown,
        bundle: unknown,
      ) => void;
      hook.call(context, {}, phaserOnly);
    };

    // A build that asked for the dungeon and emitted no Pixi chunk has set a variable and
    // read nothing, which is the shape of a check that measures nothing.
    run({ pixiDungeon: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('VITE_PIXI_DUNGEON=true');
    expect(errors[0]).not.toContain('VITE_PIXI_VILLAGE');

    // The default build is unaffected.
    errors.length = 0;
    run({});
    expect(errors).toEqual([]);
  });
});

describe('Phase 11 exception is closed: no UI component statically imports Phaser', () => {
  const PHASER_STATIC_REACHES: readonly RegExp[] = [
    /^phaser(?:\/|$)/,
    /^@\/game\/scenes(?:\/|$)/,
    /^@\/game\/adapters(?:\/|$)/,
    /^@\/game\/create/,
  ];

  it('the dungeon screen reaches Phaser only through a dynamic import', () => {
    const screen = sourceOf(GAME_SCREEN);
    for (const specifier of staticSpecifiers(screen)) {
      expect(PHASER_STATIC_REACHES.some((pattern) => pattern.test(specifier)), specifier).toBe(
        false,
      );
    }
    // The allowed form, and the one the build-time literal gates.
    expect(dynamicSpecifiers(screen)).toContain('@/game/createGame');
  });

  it('the dungeon screen names the Pixi handle in type position only', () => {
    const screen = sourceOf(GAME_SCREEN);
    // A type-only import from a renderer module is erased at build time, so it cannot put
    // PixiJS in a chunk. Asserted explicitly so the decision is on the record rather than
    // inferred from a scan that never looked at it.
    expect(screen).toContain(
      "import type { DungeonWorldHandle } from '@/renderers/pixi/dungeon/DungeonWorld';",
    );
    const typeImport = screen.slice(
      screen.indexOf('import type { DungeonWorldHandle }'),
    );
    expect(typeImport.slice(0, 160)).not.toMatch(/^import\s*\{/);
  });

  it('no UI file statically reaches Phaser at all, so the exception list is empty', () => {
    const offenders: string[] = [];
    for (const file of sourceFilesIn(path.join(REPO_ROOT, 'src', 'ui'))) {
      for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
        if (PHASER_STATIC_REACHES.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${path.relative(REPO_ROOT, file).split(path.sep).join('/')} -> ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      'Phase 13 migrated the dungeon route, so the Phase 11 exception must be empty',
    ).toEqual([]);
  });
});

describe('the dungeon renderer tree stays inside its boundary', () => {
  it('the three new PixiJS importers are the ones the Phase 9 gate names', async () => {
    // The Phase 9 gate compares its own list against the files that actually import
    // `pixi.js`, so adding one here without adding one there is a red run there. This
    // asserts the three dungeon modules are the *only* new ones, so a fourth cannot slip
    // in between the two lists being updated together.
    const gate = readFileSync(path.join(REPO_ROOT, 'tests/phase9/pixi-host-boundary.test.ts'), 'utf8');
    const importersBlock = gate.slice(
      gate.indexOf('const PIXIJS_IMPORTERS'),
      gate.indexOf('];', gate.indexOf('const PIXIJS_IMPORTERS')),
    );
    for (const file of [
      'src/renderers/pixi/dungeon/createDungeonScene.ts',
      'src/renderers/pixi/dungeon/RoomNode.ts',
      'src/renderers/pixi/dungeon/CorridorLayer.ts',
    ]) {
      expect(importersBlock, `${file} must be an enumerated PixiJS importer`).toContain(`'${file}'`);
    }
    expect(importersBlock, 'the exception list must be empty after Phase 13').not.toContain(
      'src/ui/screens/GameScreen.tsx',
    );
  });

  it('the pure controller imports no renderer, which is the phase deliverable', () => {
    const source = stripComments(
      readFileSync(
        path.join(REPO_ROOT, 'src/renderers/pixi/dungeon/WalkabilityController.ts'),
        'utf8',
      ),
    );
    for (const specifier of staticSpecifiers(source)) {
      expect(
        specifier === 'pixi.js' || specifier.startsWith('phaser'),
        `WalkabilityController.ts must stay renderer-free, but imports ${specifier}`,
      ).toBe(false);
      expect(specifier.startsWith('@/game')).toBe(false);
    }
  });

  it('no core module gained a renderer import, and the dungeon modules read core by type only', () => {
    // Plan 6.1: neither `src/core/` nor a renderer-neutral application module may import a
    // renderer. Phase 13 adds nothing to core, so this re-derives the whole check rather
    // than trusting the Phase 9 gate to still hold.
    for (const layer of ['src/core', 'src/application', 'src/theme']) {
      for (const file of sourceFilesIn(path.join(REPO_ROOT, layer))) {
        for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
          expect(
            specifier === 'phaser' ||
              specifier.startsWith('phaser/') ||
              specifier.startsWith('pixi.js') ||
              specifier.startsWith('@pixi/') ||
              specifier.startsWith('@/renderers') ||
              specifier.startsWith('@/game'),
            `${path.relative(REPO_ROOT, file)} -> ${specifier}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe('the walk above is real, so the boundary assertions are not vacuous', () => {
  it('finds the UI tree, the core layers, and a planted Phaser reach', () => {
    expect(sourceFilesIn(path.join(REPO_ROOT, 'src', 'ui')).length).toBeGreaterThan(20);
    expect(sourceFilesIn(path.join(REPO_ROOT, 'src', 'core')).length).toBeGreaterThan(25);
    expect(sourceFilesIn(path.join(REPO_ROOT, 'src', 'application')).length).toBeGreaterThan(5);
    expect(sourceFilesIn(path.join(REPO_ROOT, 'src', 'theme')).length).toBeGreaterThan(5);

    // The scanner finds the reach it is looking for in a planted line, so the three
    // assertions above cannot pass by never matching anything.
    expect(staticSpecifiers("import { createGame } from '@/game/createGame';")).toEqual([
      '@/game/createGame',
    ]);
    expect(staticSpecifiers("import Phaser from 'phaser';")).toEqual(['phaser']);
    // A dynamic import is found by the dynamic scan and *not* by the static one, which is
    // the distinction the whole chunk boundary rests on.
    expect(staticSpecifiers("const f = () => import('@/game/createGame');")).toEqual([]);
    expect(dynamicSpecifiers("const f = () => import('@/game/createGame');")).toEqual([
      '@/game/createGame',
    ]);
    // A comment naming a package does not count: a gate is allowed to explain its rule.
    expect(staticSpecifiers(stripComments("// import { createGame } from '@/game/createGame';\n"))).toEqual(
      [],
    );
  });
});
