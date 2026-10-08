import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Files that must stay renderer-neutral. Nothing under these trees may reach for
 * a rendering engine, directly or transitively through a type.
 *
 * The storage-v2 persistence tree is included because plan section 3 of Phase 3
 * declares it renderer-neutral, and that is a boundary worth enforcing
 * mechanically rather than by convention: it is the tree the Phase 4 cutover
 * makes reachable from the application.
 */
const RENDERER_NEUTRAL_LAYERS = [
  'src/core/**/*.{ts,tsx}',
  'src/application/**/*.{ts,tsx}',
  'src/services/persistence/v2/**/*.{ts,tsx}',
  // The data-product tree (Phase 5 onward) writes and reads archives for the
  // storage-v2 model above, so it is renderer-neutral for the same reason. It is
  // listed here rather than left to convention because it is the tree a Data
  // Center will import, and a product module reaching for an engine would put
  // rendering inside the backup path.
  'src/services/persistence/products/**/*.{ts,tsx}',
  // The Cozy token tree (Phase 8) is the shared source React DOM and a future
  // PixiJS host both read, so it must not name either renderer. It is listed here
  // so the rule, not only `tests/phase8/cozy-renderer-neutrality.test.ts`, is what
  // holds the boundary: a test that can be deleted is not a gate.
  'src/theme/**/*.{ts,tsx}',
];

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
 * - `@/game` matches the alias Vite resolves to `src/game`, and `@/renderers`
 *   matches the alias Vite resolves to `src/renderers`; the `..`-relative globs
 *   close the `../../game/...` and `../../renderers/...` equivalents so the
 *   boundary cannot be sidestepped by switching to a relative specifier.
 *
 * Both renderer trees are named, and naming only one of them was a real gap:
 * `src/game/**` was listed from Phase 2 and `src/renderers/**` was introduced by
 * Phase 9, and an entry that stops for the tree the current renderer lives in is
 * not defence in depth. A neutral layer importing `@/renderers/pixi/runtime/...`
 * or `../renderers/...` was reported by no mechanism except the `writeBundle`
 * chunk audit, which is a backstop for what *ships* and not a statement about the
 * layer. The two backstops that remain are unchanged and still armed: the
 * emitted-graph audit in `vite.config.ts` and the boundary scan in
 * `tests/phase9/pixi-host-boundary.test.ts`.
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
  // The renderer trees themselves, reached through the `@` alias...
  '@/game',
  '@/game/*',
  '@/game/**',
  // `src/renderers/**` is the Phase 9 PixiJS host, and the reason this rule exists -
  // keeping a renderer tree unreachable from a neutral layer - is exactly as true of
  // it as of `src/game/**`. Listed here rather than left to be caught downstream,
  // because a downstream catch happens only once the leak ships.
  '@/renderers',
  '@/renderers/*',
  '@/renderers/**',
  // ...or through a relative path.
  '**/../game',
  '**/../game/**',
  '**/../renderers',
  '**/../renderers/**',
];

/**
 * Reported for every forbidden renderer import. `no-restricted-imports` already
 * names the offending specifier; this adds the layer, the reason, and the way out.
 * It deliberately makes no distinction between value and type-only imports:
 * `import type { Phaser } from 'phaser'` is renderer coupling too.
 */
const FORBIDDEN_RENDERER_IMPORT_MESSAGE =
  'This layer is renderer-neutral and must not import a renderer: ' +
  '`src/core/**`, `src/application/**`, `src/services/persistence/v2/**`, ' +
  '`src/services/persistence/products/**`, and `src/theme/**`. ' +
  'Depend on the interfaces in `src/application/contracts/` and let a renderer adapter ' +
  '(`src/game/**` for Phaser today, `src/renderers/**` for the PixiJS host) bind the ' +
  'concrete engine. Value and type-only imports are both forbidden.';

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
    // The hand-written service worker (Phase 22) runs in a service-worker global
    // scope, not in Node and not in a page: `self`, `caches`, `importScripts`,
    // `clients`, and `skipWaiting` are its real environment. It is copied from
    // `public/` into `dist/` and never bundled, so it is the one source file that
    // needs these globals rather than the app's DOM/Node union.
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
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
    // Renderer boundary, Phase 2 onward. Every layer in RENDERER_NEUTRAL_LAYERS may
    // describe a world, but only a renderer adapter may name an engine. Built-in
    // rule only, no plugin.
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
