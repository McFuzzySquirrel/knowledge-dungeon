/**
 * Phase 2 contract test: the renderer-neutral import boundary and the
 * compatibility re-exports.
 *
 * `eslint.config.js` already restricts renderer imports inside
 * `src/core/**` and `src/application/**`. This file is the non-lint half of
 * that gate: it reads the source tree, so `npm test` alone catches a regression
 * even if someone edits the ESLint config, skips lint, or the forbidden import
 * only appears in a type position.
 *
 * Two things are pinned:
 *
 * 1. **Boundary.** No file under `src/core/**` or `src/application/**` may
 *    reach a renderer - `phaser`, `pixi.js`, `@pixi/*` - or the renderer tree
 *    itself, whether through a bare package specifier, the `@/game` alias, or a
 *    relative path such as `../game/scenes/DungeonScene`. Type-only imports
 *    and dynamic `import()` count, because renderer coupling is coupling.
 *    A positive control (the Phaser adapter *does* import the engine) proves
 *    the detector is not silently matching nothing.
 *
 * 2. **Compatibility re-exports.** The five modules that moved out of
 *    `src/game/systems/*` keep a shim at the old path. Each shim must be a pure
 *    re-export of its `src/core` original, and every runtime export must be the
 *    *same value* (`Object.is`), not merely an equal one - so the old path and
 *    the new path can never resolve to two divergent copies. First-party source
 *    must import the moved modules from their new `src/core` locations.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// Imported statically on purpose: the identity assertions below must resolve
// the *same module records* the application resolves, so a computed
// specifier would defeat the point.
import * as legacyBossRooms from '@/game/systems/bossRooms';
import * as legacyDungeonGenerator from '@/game/systems/dungeonGenerator';
import * as legacyDungeonTypes from '@/game/systems/dungeonTypes';
import * as legacyFishingMechanics from '@/game/systems/fishingMechanics';
import * as legacyFishingTypes from '@/game/systems/fishingTypes';
import * as coreBossRooms from '@/core/layout/bossRooms';
import * as coreDungeonGenerator from '@/core/layout/dungeonGenerator';
import * as coreDungeonTypes from '@/core/layout/dungeonTypes';
import * as coreFishingMechanics from '@/core/fishing/fishingMechanics';
import * as coreFishingTypes from '@/core/fishing/fishingTypes';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const CORE_DIR = join(SRC, 'core');
const APPLICATION_DIR = join(SRC, 'application');
const GAME_DIR = join(SRC, 'game');

/** Renderer-neutral trees: nothing renderer-shaped may be imported from here. */
const RENDERER_NEUTRAL_DIRS = [CORE_DIR, APPLICATION_DIR];

/** Renderer packages, including the PixiJS subpackage forms. */
const RENDERER_PACKAGES = ['phaser', 'pixi.js'];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const ALL_SOURCE_FILES = listSourceFiles(SRC);
const RENDERER_NEUTRAL_FILES = RENDERER_NEUTRAL_DIRS.flatMap((dir) => listSourceFiles(dir));

/**
 * Every module specifier a source file references, from static imports/exports
 * (including `import type`) and dynamic `import()`. The capture is
 * specifier-only; the statements themselves are irrelevant to the boundary.
 */
function readSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** The `@/game` alias or a relative path resolved against the repo's `src`. */
function resolveFirstPartyPath(file: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return resolve(SRC, specifier.slice(2));
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier);
  return null;
}

function isInside(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep + '..') && !rel.startsWith(`..${sep}`);
}

function describeFile(file: string): string {
  return relative(ROOT, file);
}

/** One offending import, formatted for an assertion message. */
interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

function rendererViolations(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const specifier of readSpecifiers(file)) {
      const bare = specifier.startsWith('@pixi/')
        ? specifier
        : RENDERER_PACKAGES.find(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          );
      if (bare) {
        violations.push({
          file: describeFile(file),
          specifier,
          reason: 'renderer package import',
        });
        continue;
      }
      const firstParty = resolveFirstPartyPath(file, specifier);
      if (firstParty && isInside(GAME_DIR, firstParty)) {
        violations.push({
          file: describeFile(file),
          specifier,
          reason: 'import from the renderer tree (src/game)',
        });
      }
    }
  }
  return violations;
}

/**
 * Moved modules: old compatibility path -> the `src/core` original, with both
 * namespace objects already resolved.
 */
const MOVED_MODULES: ReadonlyArray<{
  legacy: string;
  original: string;
  legacyModule: Record<string, unknown>;
  originalModule: Record<string, unknown>;
}> = [
  {
    legacy: 'src/game/systems/dungeonGenerator.ts',
    original: 'src/core/layout/dungeonGenerator.ts',
    legacyModule: legacyDungeonGenerator,
    originalModule: coreDungeonGenerator,
  },
  {
    legacy: 'src/game/systems/dungeonTypes.ts',
    original: 'src/core/layout/dungeonTypes.ts',
    legacyModule: legacyDungeonTypes,
    originalModule: coreDungeonTypes,
  },
  {
    legacy: 'src/game/systems/bossRooms.ts',
    original: 'src/core/layout/bossRooms.ts',
    legacyModule: legacyBossRooms,
    originalModule: coreBossRooms,
  },
  {
    legacy: 'src/game/systems/fishingTypes.ts',
    original: 'src/core/fishing/fishingTypes.ts',
    legacyModule: legacyFishingTypes,
    originalModule: coreFishingTypes,
  },
  {
    legacy: 'src/game/systems/fishingMechanics.ts',
    original: 'src/core/fishing/fishingMechanics.ts',
    legacyModule: legacyFishingMechanics,
    originalModule: coreFishingMechanics,
  },
];

function stripModuleExtension(path: string): string {
  return path.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 2 renderer-neutral import boundary', () => {
  it('scans a non-trivial slice of src/core and src/application', () => {
    expect(RENDERER_NEUTRAL_FILES.length).toBeGreaterThan(20);
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(RENDERER_NEUTRAL_FILES.length);
    const specifiers = RENDERER_NEUTRAL_FILES.flatMap((file) => readSpecifiers(file));
    expect(specifiers.length).toBeGreaterThan(30);
  });

  it('keeps phaser, PixiJS, and src/game out of src/core and src/application', () => {
    const violations = rendererViolations(RENDERER_NEUTRAL_FILES);

    expect(
      violations,
      violations.map((v) => `${v.file}: '${v.specifier}' (${v.reason})`).join('\n'),
    ).toEqual([]);
  });

  it('detects both renderer package imports and renderer-tree paths (positive control)', () => {
    // The Phaser adapter is *supposed* to name the engine, so if these are not
    // flagged the detector above is broken and the boundary test is vacuous.
    const adapter = join(SRC, 'game', 'adapters', 'phaserDungeonRenderer.ts');
    const violations = rendererViolations([adapter]);

    expect(violations).toEqual(
      expect.arrayContaining([
        {
          file: join('src', 'game', 'adapters', 'phaserDungeonRenderer.ts'),
          specifier: 'phaser',
          reason: 'renderer package import',
        },
        {
          file: join('src', 'game', 'adapters', 'phaserDungeonRenderer.ts'),
          specifier: '@/game/scenes/DungeonScene',
          reason: 'import from the renderer tree (src/game)',
        },
      ]),
    );
    expect(rendererViolations(listSourceFiles(GAME_DIR)).length).toBeGreaterThan(0);
  });

  it('resolves the @/game alias and relative paths to the same renderer tree', () => {
    const file = join(APPLICATION_DIR, 'contracts', 'world.ts');

    // Extensionless specifiers resolve as written; the boundary decision only
    // needs the directory, so no extension probing is required.
    expect(resolveFirstPartyPath(file, '@/game/createGame')).toBe(join(SRC, 'game', 'createGame'));
    expect(resolveFirstPartyPath(file, '@/game/scenes/DungeonScene')).toBe(
      join(SRC, 'game', 'scenes', 'DungeonScene'),
    );
    // From `src/application/contracts/` the renderer tree is two levels up;
    // from `src/application/` it is one.
    expect(resolveFirstPartyPath(file, '../../game/scenes/DungeonScene')).toBe(
      join(SRC, 'game', 'scenes', 'DungeonScene'),
    );
    expect(resolveFirstPartyPath(file, '../game/scenes/DungeonScene')).toBe(
      join(SRC, 'application', 'game', 'scenes', 'DungeonScene'),
    );
    expect(
      resolveFirstPartyPath(
        join(APPLICATION_DIR, 'studyFlow.ts'),
        '../game/scenes/DungeonScene',
      ),
    ).toBe(join(SRC, 'game', 'scenes', 'DungeonScene'));
    expect(resolveFirstPartyPath(file, './world')).toBe(
      join(APPLICATION_DIR, 'contracts', 'world'),
    );
    expect(resolveFirstPartyPath(file, 'zustand')).toBeNull();

    // A relative escape that climbs back out of src/game is still inside it.
    expect(isInside(GAME_DIR, join(SRC, 'game', 'createGame'))).toBe(true);
    expect(isInside(GAME_DIR, join(SRC, 'game'))).toBe(false);
    expect(isInside(GAME_DIR, join(APPLICATION_DIR, 'contracts', 'events.ts'))).toBe(false);
    expect(isInside(GAME_DIR, join(CORE_DIR, 'layout', 'dungeonGenerator.ts'))).toBe(false);
  });

  it('keeps the contract files free of renderer types in type-only positions', () => {
    // `import type { Phaser } from 'phaser'` is renderer coupling too, and the
    // specifier scan above already covers it; this pins the specific shape that
    // is easiest to reintroduce.
    for (const file of RENDERER_NEUTRAL_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, describeFile(file)).not.toMatch(
        /import\s+type\s*\{[^}]*\}\s*from\s*['"](phaser|pixi\.js|@pixi\/)/,
      );
    }
  });
});

describe('Phase 2 compatibility re-exports', () => {
  it('keeps a shim at every legacy src/game/systems path', () => {
    for (const { legacy } of MOVED_MODULES) {
      expect(statSync(join(ROOT, legacy)).isFile(), legacy).toBe(true);
    }
  });

  it('makes every shim a pure re-export of its src/core original', () => {
    for (const { legacy, original } of MOVED_MODULES) {
      const source = readFileSync(join(ROOT, legacy), 'utf8');
      const reExport = source.match(/export\s+\*\s+from\s+'([^']+)'/);
      expect(reExport, `${legacy} must re-export something`).not.toBeNull();
      const expected = `@/${original.replace(/^src\//, '').replace(/\.ts$/, '')}`;
      expect(reExport?.[1], legacy).toBe(expected);
      // Nothing but the re-export: no shim may grow its own implementation.
      expect(source.replace(/export\s+\*\s+from\s+'[^']+';/, '').replace(/\/\*[\s\S]*?\*\//g, ''),
        legacy).toMatch(/^\s*$/);
    }
  });

  it.each(MOVED_MODULES)(
    'resolves $legacy to the same runtime bindings as $original',
    ({ legacy, original, legacyModule, originalModule }) => {
      // Identity, not re-reading values: the same function/const object, so a
      // second copy of the module can never exist behind the legacy path.
      expect(Object.keys(legacyModule).sort()).toEqual(Object.keys(originalModule).sort());
      for (const name of Object.keys(originalModule)) {
        expect(
          Object.is(legacyModule[name], originalModule[name]),
          `${legacy} must re-export the very same ${original}#${name}`,
        ).toBe(true);
      }
    },
  );

  it('imports the moved modules from their src/core paths in first-party source', () => {
    const movedPaths = new Set(
      MOVED_MODULES.map(({ legacy }) => stripModuleExtension(join(ROOT, legacy))),
    );
    const offenders: string[] = [];

    for (const file of ALL_SOURCE_FILES) {
      for (const specifier of readSpecifiers(file)) {
        const firstParty = resolveFirstPartyPath(file, specifier);
        if (!firstParty) continue;
        if (movedPaths.has(stripModuleExtension(firstParty))) {
          offenders.push(`${describeFile(file)}: '${specifier}'`);
        }
      }
    }

    expect(
      offenders,
      `first-party source must import the moved modules from src/core:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the modules that did not move at their existing src/game/systems paths', () => {
    for (const file of [
      'src/game/systems/playerClasses.ts',
      'src/game/systems/proceduralTextures.ts',
    ]) {
      expect(statSync(join(ROOT, file)).isFile(), file).toBe(true);
    }
  });
});
