import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Files that must stay renderer-neutral. Nothing under these trees may reach for
 * a rendering engine, directly or transitively through a type.
 */
const RENDERER_NEUTRAL_LAYERS = ['src/core/**/*.{ts,tsx}', 'src/application/**/*.{ts,tsx}'];

/**
 * Renderer packages and renderer trees that are forbidden inside the
 * renderer-neutral layers.
 *
 * `no-restricted-imports` matches these with gitignore semantics, so a bare
 * entry covers the package root and a recursive glob entry covers every
 * subpath. Both forms are listed so the list keeps working if the matcher's
 * directory behavior ever changes:
 * - `pixi.js` and the recursive `pixi.js` glob also cover `pixi.js/unsafe-eval`.
 * - `@pixi/<package>` and the recursive `@pixi` glob cover every subpath.
 * - `@/game` matches the alias Vite resolves to `src/game`; the `..`-relative
 *   globs close the `../../game/...` equivalent so the boundary cannot be
 *   sidestepped by switching to a relative specifier.
 */
const FORBIDDEN_RENDERER_IMPORTS = [
  // Phaser: the current renderer, replaced through an adapter and removed in Phase 24.
  'phaser',
  'phaser/**',
  // PixiJS: the Phase 9 renderer. It must not leak in ahead of the adapter.
  'pixi.js',
  'pixi.js/**',
  '@pixi/*',
  '@pixi/**',
  // The renderer tree itself, reached through the `@` alias...
  '@/game',
  '@/game/*',
  '@/game/**',
  // ...or through a relative path.
  '**/../game',
  '**/../game/**',
];

/**
 * Reported for every forbidden renderer import. `no-restricted-imports` already
 * names the offending specifier; this adds the layer, the reason, and the way out.
 * It deliberately makes no distinction between value and type-only imports:
 * `import type { Phaser } from 'phaser'` is renderer coupling too.
 */
const FORBIDDEN_RENDERER_IMPORT_MESSAGE =
  '`src/core/**` and `src/application/**` are renderer-neutral and must not import a renderer. ' +
  'Depend on the interfaces in `src/application/contracts/` and let a renderer adapter ' +
  '(`src/game/**` for Phaser today, the PixiJS host later) bind the concrete engine. ' +
  'Value and type-only imports are both forbidden.';

export default [
  {
    ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**', 'coverage/**', '.agents/**', 'scripts/**', 'artifacts/**'],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json', './tsconfig.electron.json'],
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Phase 2 renderer boundary: core and application code may describe a world,
    // but only a renderer adapter may name an engine. Built-in rule only, no plugin.
    name: 'knowledge-dungeon/renderer-boundary',
    files: RENDERER_NEUTRAL_LAYERS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // One pattern group holding every forbidden renderer specifier, so a
          // single import that matches several globs still reports once.
          patterns: [
            {
              group: FORBIDDEN_RENDERER_IMPORTS,
              message: FORBIDDEN_RENDERER_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
];
