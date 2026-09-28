/**
 * The renderer-neutral layer list in `eslint.config.js` reaches the Cozy token tree.
 *
 * `RENDERER_NEUTRAL_LAYERS` is what makes plan section 6.1's rule - "Neither
 * `src/core/` nor renderer-neutral application modules may import Phaser or
 * PixiJS" - mechanical. Phase 8 added the shared Cozy token source in
 * `src/theme/`, a module both React DOM and a future PixiJS host read, so it
 * belongs in that list.
 *
 * This file exists because a layer entry is a *claim about the tree* written in
 * a config file, and nothing in a config file reports its own failure. A glob
 * with a typo, or a layer that is declared but never wired to the rule, is
 * indistinguishable from a working one until someone imports Phaser into a token
 * module. So this file fails if:
 *
 * 1. `src/theme/**` is no longer a declared layer, or is written in a different
 *    glob form from its siblings.
 * 2. The layer list is not what the `knowledge-dungeon/renderer-boundary` block
 *    applies, so a layer can be declared and silently left unenforced.
 * 3. **The layer matches nothing.** A glob that ESLint does not honor is worse
 *    than no entry, because it reads as coverage. This is checked by asking
 *    ESLint itself, via `--print-config`, rather than by trusting this file's
 *    own reading of the config.
 * 4. The check in 3 cannot tell a layer from a non-layer. `src/game/adapters/`
 *    is the negative control: it imports Phaser on purpose, so it must not
 *    resolve to the rule, and a `print-config` probe that reported the rule
 *    everywhere would be reporting nothing.
 * 5. The theme layer is given a weaker rule than its siblings - a forbidden
 *    specifier quietly dropped from the shared pattern group.
 *
 * The declared layers are read from the config's own source text rather than by
 * importing it, because `tsconfig.app.json` type-checks `tests` without
 * `allowJs`. Point 3 is what keeps that weaker, parser-based reading honest.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data, network
 * state, or a persisted preference. It reads `eslint.config.js` and the `src`
 * file listing, and it spawns the local ESLint binary twice with `--print-config`
 * only. It performs no lint, no build, and no request of any kind.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const ESLINT_CONFIG_PATH = path.join(REPO_ROOT, 'eslint.config.js');
const THEME_DIR = path.join(REPO_ROOT, 'src', 'theme');

/** The config block that carries the renderer-import restriction. */
const BOUNDARY_BLOCK_NAME = 'knowledge-dungeon/renderer-boundary';

/** The layer this file is about, in the glob form its siblings use. */
const THEME_LAYER = 'src/theme/**/*.{ts,tsx}';

/**
 * Siblings that must survive any edit to the list. They are pinned so a change
 * that trades one layer for another fails here instead of quietly narrowing the
 * boundary.
 */
const SIBLING_LAYERS = [
  'src/core/**/*.{ts,tsx}',
  'src/application/**/*.{ts,tsx}',
  'src/services/persistence/v2/**/*.{ts,tsx}',
  'src/services/persistence/products/**/*.{ts,tsx}',
];

/** Renderer specifiers the boundary must keep refusing, as `patterns[].group` entries. */
const REQUIRED_FORBIDDEN_SPECIFIERS = [
  'phaser',
  'phaser/**',
  'pixi.js',
  'pixi.js/**',
  '@pixi/*',
  '@pixi/**',
  '@/game',
  '@/game/*',
  '@/game/**',
  '**/../game',
  '**/../game/**',
];

const eslintConfigSource = readFileSync(ESLINT_CONFIG_PATH, 'utf8');

/** The quoted entries of a named array literal in the config, in order. */
function configArray(name: string): string[] {
  const list = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(eslintConfigSource);
  if (list === null) throw new Error(`eslint.config.js has no ${name} array.`);
  return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** The source text of one named config block, braces balanced from `name:` to the end. */
function blockSource(name: string): string {
  const start = eslintConfigSource.indexOf(`name: '${name}'`);
  if (start === -1) throw new Error(`eslint.config.js has no block named ${name}.`);
  const rest = eslintConfigSource.slice(start);
  let depth = 0;
  for (let index = rest.indexOf('{'); index < rest.length; index += 1) {
    if (rest[index] === '{') depth += 1;
    if (rest[index] === '}') depth -= 1;
    if (depth === 0) return rest.slice(0, index + 1);
  }
  throw new Error(`The ${name} block is not brace-balanced.`);
}

/**
 * Translates one `RENDERER_NEUTRAL_LAYERS` entry into a path matcher, so the list
 * can be checked against the files actually on disk. Deliberately small: it
 * covers the `**\/`, trailing `\/**`, `*`, and `{a,b}` forms the siblings use and
 * nothing else, so an unsupported form fails loudly instead of matching nothing.
 */
function layerMatcher(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; ) {
    const rest = glob.slice(index);
    if (rest.startsWith('**/')) {
      pattern += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (rest.startsWith('/**')) {
      pattern += '(?:/.*)?';
      index += 3;
      continue;
    }
    const brace = /^\{([^{}]+)\}/.exec(rest);
    if (brace !== null) {
      pattern += `(?:${brace[1].split(',').join('|')})`;
      index += brace[0].length;
      continue;
    }
    if (rest.startsWith('*')) {
      pattern += '[^/]*';
      index += 1;
      continue;
    }
    if (rest.startsWith('?')) {
      pattern += '[^/]';
      index += 1;
      continue;
    }
    pattern += rest[0].replace(/[.+^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

function themeFilesOnDisk(): string[] {
  return readdirSync(THEME_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => `src/theme/${entry.name}`)
    .sort();
}

/**
 * The rule as ESLint resolved it for one file, or `null` when the rule is absent.
 * `--print-config` is the authoritative answer: it runs the real config, so a
 * glob this file misreads still reports the truth here.
 */
function resolvedRuleFor(repoRelativePath: string): { severity: number } | null {
  const output = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      '--print-config',
      repoRelativePath,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
  );
  const rule = (JSON.parse(output) as { rules: Record<string, unknown> }).rules[
    'no-restricted-imports'
  ];
  if (rule === undefined) return null;
  return { severity: Array.isArray(rule) ? (rule[0] as number) : (rule as number) };
}

describe('src/theme is a declared renderer-neutral layer', () => {
  it('lists the theme tree alongside its siblings, in the same glob form', () => {
    const layers = configArray('RENDERER_NEUTRAL_LAYERS');

    expect(layers, 'src/theme is not a renderer-neutral layer').toContain(THEME_LAYER);
    // One glob form for the whole list, so a layer cannot be added in a form the
    // rest of the file does not use - and cannot quietly stop matching.
    const offForm = layers.filter((layer) => !layer.endsWith('/**/*.{ts,tsx}'));
    expect(offForm, 'a layer uses a different glob form from its siblings').toEqual([]);
    for (const sibling of SIBLING_LAYERS) {
      expect(layers, `${sibling} was dropped from the list`).toContain(sibling);
    }
  });

  it('matches every Cozy token module that is actually on disk', () => {
    const onDisk = themeFilesOnDisk();
    // Not an empty-directory guard dressed up as a check: these are the Phase 8
    // modules the rule exists to protect.
    expect(onDisk.length).toBeGreaterThanOrEqual(8);
    expect(onDisk).toContain('src/theme/cozyTokens.ts');
    expect(onDisk).toContain('src/theme/index.ts');

    const matcher = layerMatcher(THEME_LAYER);
    const unmatched = onDisk.filter((file) => !matcher.test(file));
    expect(unmatched, 'these files are not covered by the layer glob').toEqual([]);

    // Negative controls, so a matcher that matches everything cannot pass.
    expect(matcher.test('src/theme/styles.css')).toBe(false);
    expect(matcher.test('src/core/layout/rooms.ts')).toBe(false);
    expect(matcher.test('src/themeical/nested.ts')).toBe(false);
  });
});

describe('the theme layer is enforced, not merely declared', () => {
  it('is the very list the renderer-boundary block applies', () => {
    const block = blockSource(BOUNDARY_BLOCK_NAME);
    // The block references the list by name, so there is one list to keep true.
    // A copied second array is what would let a layer be declared and left off.
    expect(block).toMatch(/files:\s*RENDERER_NEUTRAL_LAYERS\b/);
    expect(block).toContain("'no-restricted-imports'");
    expect(block).toMatch(/'no-restricted-imports':\s*\[\s*'error'/);
  });

  it('refuses the same renderer specifiers the sibling layers refuse', () => {
    // The block references the forbidden list by name, so there is one list of
    // renderer specifiers for every layer: a layer cannot be quietly given a
    // weaker set than its siblings.
    expect(blockSource(BOUNDARY_BLOCK_NAME)).toMatch(/group:\s*FORBIDDEN_RENDERER_IMPORTS\b/);

    const specifiers = configArray('FORBIDDEN_RENDERER_IMPORTS');
    for (const required of REQUIRED_FORBIDDEN_SPECIFIERS) {
      expect(specifiers, `the boundary no longer refuses '${required}'`).toContain(required);
    }
    // One group, so a single import that matches several globs still reports once
    // and the rule is not narrowed per layer.
    expect(blockSource(BOUNDARY_BLOCK_NAME).match(/group:/g)).toHaveLength(1);
  });

  it('resolves to the rule on a real token module, and not on the Phaser adapter', () => {
    // Type-aware parsing makes each probe cost a few seconds; the budget is here
    // so a cold CI cache is a slow test rather than a failed one.
    const themeProbe = 'src/theme/cozyTokens.ts';
    const controlProbe = 'src/game/adapters/phaserDungeonRenderer.ts';
    expect(existsSync(path.join(REPO_ROOT, themeProbe)), themeProbe).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, controlProbe)), controlProbe).toBe(true);

    // The layer is live: ESLint applies the restriction to a real token module.
    expect(resolvedRuleFor(themeProbe), `the rule does not reach ${themeProbe}`).not.toBeNull();
    expect(resolvedRuleFor(themeProbe)?.severity).toBe(2);

    // The probe discriminates. Without this, a probe that reported the rule for
    // every file in the repository would satisfy the assertion above vacuously.
    expect(resolvedRuleFor(controlProbe), 'the probe reports the rule for a non-layer file').toBeNull();
  }, 60_000);
});
