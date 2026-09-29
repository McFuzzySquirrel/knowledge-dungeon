/**
 * The renderer boundary, enforced on the Phase 9 source tree.
 *
 * ## Why a boundary test and not a comment
 *
 * Plan 6.1 says neither `src/core/` nor a renderer-neutral application module may
 * import Phaser or PixiJS. The mechanism the repository already has for that is
 * `no-restricted-imports` in `eslint.config.js`, and it is a real one - but it covers
 * a *list* of layers, and it cannot see a new shape of leak. Three of the four things
 * below are invisible to it:
 *
 * 1. **A renderer type escaping upward.** `createPixiWorldHost` is written in
 *    renderer-neutral terms, and nothing stops a later edit from letting
 *    `Application` into its signature. Then `createWorldHost.ts` becomes a module
 *    above the boundary that *is* the boundary, and the contract stops being
 *    renderer-neutral while every import still looks fine.
 * 2. **A CSS unit parsed in renderer code.** Phase 9's exit criterion is "the host
 *    reads Cozy geometry, typography, and motion as numbers, with no CSS-unit
 *    parsing in renderer code". `parseFloat('10px')` passes every existing gate and
 *    silently quarters a panel the day a token is authored in `rem`.
 * 3. **A second `pixi.js` import.** One file importing the engine is a binding; two
 *    is a convention. A scene that imports `pixi.js` directly instead of receiving
 *    an `Application` is how the port quietly stops being the port.
 *
 * So the rules are stated here over the *graph*, walked from source, and re-derived
 * rather than listed: the set of files that import `pixi.js` is compared against the
 * set this file's header names, so adding a fourth one is a red run rather than a
 * silent widening.
 *
 * ## The one thing this file cannot prove
 *
 * It reads source, so it cannot prove the built artifact is lazy. That is
 * `tests/phase9/renderer-chunk-boundary.test.ts`'s job for the graph logic, the
 * `writeBundle` audit in `vite.config.ts` for a real build, and this phase's
 * verification runs for the artifact. What this file adds is the part a build cannot
 * see: that the seam is the right *shape* before anyone tries to build it.
 *
 * ## Hermeticity
 *
 * Reads only files inside the repository. No `dist/`, no commit, no process, no
 * network, and no location-dependent value. Privacy: no learner data, and the only
 * identifiers it inspects are import specifiers and element tag names.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isEditableElement } from '../../src/ui/utils/editableElement';
import { isHandledElsewhere } from '../../src/renderers/pixi/runtime/createPixiWorldHost';
import { REPO_ROOT, sourceOf, stripComments } from './support/phase9Build';

const RENDERER_TREE = path.join(REPO_ROOT, 'src', 'renderers');

/**
 * The only two files in `src/renderers/**` permitted to import `pixi.js`.
 *
 * Named rather than "any file under `src/renderers`", because the whole point of
 * the port is that there is exactly one place the engine is named. A scene that
 * imports `pixi.js` itself has decided the application it receives is not enough,
 * and that decision belongs in a review rather than in a diff.
 */
const PIXIJS_IMPORTERS: readonly string[] = [
  'src/renderers/pixi/runtime/createPixiApplication.ts',
  'src/renderers/pixi/testworld/createTestWorld.ts',
];

/** Layers that must not reach a renderer, matching `eslint.config.js`. */
const RENDERER_NEUTRAL_LAYERS: readonly string[] = [
  'src/core',
  'src/application',
  'src/theme',
];

function sourceFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesIn(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

function repositoryRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * Static import specifiers: the forms a bundler follows when it emits
 * `modulepreload` links.
 *
 * A dynamic `import()` is deliberately excluded, because it is the *only* form that
 * keeps a chunk off the first paint and folding it in here would make the
 * "reached only through a dynamic import" assertion below impossible to state.
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // The `from` form covers a value import, a type-only import, and a side-effect
    // import alike, which is the point: a type-only reach-through is coupling too.
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Dynamic import specifiers, matched separately so the two are never confused. */
function dynamicImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
}

const rendererSources = sourceFilesIn(RENDERER_TREE).map((file) => ({
  file,
  relative: repositoryRelative(file),
  source: readFileSync(file, 'utf8'),
}));

describe('the renderer tree is walked, so the scans below are not vacuous', () => {
  it('found the Phase 9 modules this file is about', () => {
    expect(rendererSources.length).toBeGreaterThanOrEqual(8);
    const relatives = rendererSources.map((entry) => entry.relative);
    for (const expected of [
      'src/renderers/pixi/runtime/PixiWorldHost.tsx',
      'src/renderers/pixi/runtime/PixiCanvas.tsx',
      'src/renderers/pixi/runtime/createPixiApplication.ts',
      'src/renderers/pixi/runtime/createPixiWorldHost.ts',
      'src/renderers/pixi/runtime/cozyWorldTheme.ts',
      'src/renderers/pixi/runtime/types.ts',
      'src/renderers/pixi/runtime/useWorldQuality.ts',
      'src/renderers/pixi/runtime/worldEnvironment.ts',
      'src/renderers/pixi/testworld/createTestWorld.ts',
      'src/renderers/pixi/testworld/TestWorldActions.tsx',
    ]) {
      expect(relatives, expected).toContain(expected);
    }
  });

  it('the specifier scan finds both static and dynamic imports, so the rule has teeth', () => {
    // Controls, because a scanner that only matched `from '...'` would report a
    // clean tree for a file that reaches a renderer through `await import(...)`.
    const control = [
      "import { Application } from 'pixi.js';",
      "import 'pixi.js/events';",
      "import type { Container } from 'pixi.js';",
    ].join('\n');
    expect(importSpecifiers(control).sort()).toEqual(['pixi.js', 'pixi.js', 'pixi.js/events']);
    // A dynamic import is found by the dynamic scan and *not* by the static one,
    // which is the whole distinction the chunk boundary rests on.
    const lazy = "const f = () => import('@/renderers/pixi/runtime/PixiWorldHost');";
    expect(importSpecifiers(lazy)).toEqual([]);
    expect(dynamicImportSpecifiers(lazy)).toEqual(['@/renderers/pixi/runtime/PixiWorldHost']);
    // A comment that names a package must not count, for the same reason a test is
    // allowed to explain the rule it enforces.
    expect(importSpecifiers(stripComments("// import { Application } from 'pixi.js';\nconst a = 1;"))).toEqual([]);
  });
});

describe('exactly two files in the renderer tree name PixiJS', () => {
  it('the engine is imported by the binding and the scene, and by nothing else', () => {
    const importers = rendererSources
      .filter((entry) =>
        importSpecifiers(stripComments(entry.source)).some(
          (specifier) => specifier === 'pixi.js' || specifier.startsWith('pixi.js/'),
        ),
      )
      .map((entry) => entry.relative)
      .sort();
    expect(importers, 'a new file importing pixi.js has to be a decision, not a diff').toEqual(
      [...PIXIJS_IMPORTERS].sort(),
    );
  });

  it('no file imports the v7 `@pixi/*` sub-packages, which v8 merged back in', () => {
    const offenders = rendererSources
      .filter((entry) =>
        importSpecifiers(stripComments(entry.source)).some((specifier) =>
          specifier.startsWith('@pixi/'),
        ),
      )
      .map((entry) => entry.relative);
    expect(offenders, 'pixi.js 8 is a single package').toEqual([]);
  });

  it('no renderer-neutral module in the host lifecycle names the engine', () => {
    // The lifecycle, the port, the theme, the environment, and the canvas component
    // are the modules a Phase 11 scene author reads. If any of them names PixiJS,
    // the "renderer-neutral host with a concrete Pixi binding behind it" is not true
    // and the next scene inherits the coupling.
    const neutral = rendererSources.filter(
      (entry) =>
        !PIXIJS_IMPORTERS.includes(entry.relative) &&
        entry.relative.endsWith('.ts') === !entry.relative.endsWith('.tsx'),
    );
    const offenders = rendererSources
      .filter(
        (entry) =>
          entry.relative.startsWith('src/renderers/pixi/runtime/') &&
          !PIXIJS_IMPORTERS.includes(entry.relative),
      )
      .filter((entry) =>
        importSpecifiers(stripComments(entry.source)).some((specifier) =>
          specifier.startsWith('pixi.js'),
        ),
      )
      .map((entry) => entry.relative);
    expect(offenders, 'only the binding names the engine; the lifecycle speaks the port').toEqual(
      [],
    );
    // And the walk is real: the runtime directory exists and holds several files.
    expect(neutral.length + 2).toBeGreaterThanOrEqual(6);
  });
});

describe('a renderer-neutral layer never reaches a renderer', () => {
  it('none of the neutral layers imports a renderer or the renderer tree', () => {
    const offenders: string[] = [];
    for (const layer of RENDERER_NEUTRAL_LAYERS) {
      for (const file of sourceFilesIn(path.join(REPO_ROOT, layer))) {
        for (const specifier of importSpecifiers(stripComments(readFileSync(file, 'utf8')))) {
          if (
            specifier === 'phaser' ||
            specifier.startsWith('phaser/') ||
            specifier === 'pixi.js' ||
            specifier.startsWith('pixi.js/') ||
            specifier.startsWith('@pixi/') ||
            specifier.startsWith('@/renderers') ||
            specifier.startsWith('@/game')
          ) {
            offenders.push(`${repositoryRelative(file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(
      offenders,
      'plan 6.1: a renderer-neutral module may describe a world, but only an adapter may name an engine',
    ).toEqual([]);
  });

  it('the theme barrel, which the host reads, stays renderer-free', () => {
    const barrel = importSpecifiers(stripComments(sourceOf('src/theme/index.ts')));
    expect(barrel.filter((specifier) => specifier.startsWith('pixi'))).toEqual([]);
    expect(barrel.filter((specifier) => specifier.startsWith('.'))).not.toHaveLength(0);
  });
});

describe('the host is reached only through a dynamic import', () => {
  it('the entry module names the host nowhere but in an `import()`', () => {
    const app = sourceOf('src/ui/App.tsx');
    // Static specifiers first: any of these would put PixiJS in the entry closure.
    const staticSpecifiers = importSpecifiers(stripComments(app)).filter(
      (specifier) => specifier.includes('renderers/pixi'),
    );
    expect(
      staticSpecifiers,
      'a plain import of the host would make Vite modulepreload the Pixi chunk on Welcome',
    ).toEqual([]);
    // And the dynamic one is present, because a build asked for Pixi has to emit
    // the chunk that `writeBundle` audits.
    expect(dynamicImportSpecifiers(app)).toContain('@/renderers/pixi/runtime/PixiWorldHost');
  });

  it('the switch is a build-time literal, so the default build can delete the branch', () => {
    const app = sourceOf('src/ui/App.tsx');
    // A normalisation step before the comparison defeats dead-branch elimination,
    // because no bundler evaluates `String(raw).trim().toLowerCase()`. That was
    // measured, not assumed, and the measured result is that the default build
    // keeps a lazy Pixi chunk it will never fetch.
    expect(app).toContain("import.meta.env.VITE_WORLD_RENDERER === 'pixi'");
    const branch = app.slice(app.indexOf("import.meta.env.VITE_WORLD_RENDERER === 'pixi'"));
    const beforeNextStatement = branch.split('\n').slice(1, 6).join('\n');
    expect(
      beforeNextStatement,
      'normalise the flag in runtimeConfig, not in the bundler-visible comparison',
    ).not.toMatch(/\.(trim|toLowerCase|toUpperCase)\s*\(/);
  });

  it('the run-time decision reads the parsed flag, and never echoes a raw value', () => {
    const app = sourceOf('src/ui/App.tsx');
    expect(app).toContain("runtimeConfig.worldRenderer === 'pixi'");
    // The mismatch branch must describe the condition, not print what was passed.
    const mismatch = app.slice(app.indexOf('pixiWorldHostFactory === null'));
    expect(mismatch).toContain('VITE_WORLD_RENDERER=pixi');
    expect(mismatch.slice(0, 400)).not.toMatch(/\{[^}]*import\.meta\.env[^}]*\}/);
  });
});

describe('no renderer code parses a CSS unit', () => {
  it('no `parseFloat`, `parseInt`, or unit regex appears in the renderer tree', () => {
    // Comments are stripped, because a test is allowed to explain the rule. A
    // renderer comment that says "do not `parseFloat` this" is not a violation.
    const offenders = rendererSources
      .filter((entry) => {
        const code = stripComments(entry.source);
        return (
          /\bparseFloat\s*\(/.test(code) ||
          /\bparseInt\s*\(/.test(code) ||
          /px['"`)]/.test(code) &&
            /(replace|match|split|test|exec)\s*\([^)]*px/.test(code)
        );
      })
      .map((entry) => entry.relative);
    expect(
      offenders,
      "a renderer that parses '10px' will quietly turn a future rem token into a quarter-size panel",
    ).toEqual([]);
  });

  it('the renderer tree reads the numeric mirrors, never the CSS string tables', () => {
    const offenders = rendererSources
      .filter((entry) =>
        /\b(COZY_RADIUS|COZY_SPACE|COZY_FONT_SIZE|COZY_BORDER_WIDTH|COZY_FOCUS|COZY_LINE_HEIGHT|COZY_FONT_WEIGHT)\b(?!_PX|_NUMBER)/.test(
          stripComments(entry.source),
        ),
      )
      .map((entry) => entry.relative);
    expect(offenders, 'read the `_PX` / `_NUMBER` mirrors; the string table is the stylesheet\'s').toEqual(
      [],
    );
  });

  it('no renderer module names an asset file, because Phase 10 owns those', () => {
    const offenders = rendererSources
      .filter((entry) => {
        const code = stripComments(entry.source);
        return /['"`][^'"`]*\.(png|jpg|jpeg|svg|webp|mp3|ogg|wav|woff2?|ttf)['"`]/i.test(code);
      })
      .map((entry) => entry.relative);
    expect(
      offenders,
      'Phase 9 adds no media, and the CC0 gate covers src/** - an unregistered file would fail it',
    ).toEqual([]);
  });
});

describe('the duplicate keyboard guard agrees with the DOM copy it stands in for', () => {
  /**
   * The elements a keystroke can land in. Deliberately built with `document` rather
   * than read from the application's own markup, because the property under test is
   * a function of a tag name, a type, and a flag.
   */
  const cases: ReadonlyArray<{ what: string; make: () => Element; expected: boolean }> = [
    // `contenteditable` is excluded from the pinned expectations because jsdom does
    // not implement `isContentEditable` - both copies answer `undefined` and both
    // read the same absent property, which is agreement but not a claim worth
    // pinning. It is exercised separately, below, with the property present.
    { what: 'a plain button', make: () => document.createElement('button'), expected: false },
    { what: 'a text input', make: () => document.createElement('input'), expected: true },
    { what: 'a checkbox', make: () => makeInput('checkbox'), expected: false },
    { what: 'a range', make: () => makeInput('range'), expected: false },
    { what: 'a textarea', make: () => document.createElement('textarea'), expected: true },
    { what: 'a select', make: () => document.createElement('select'), expected: true },
    { what: 'a div', make: () => document.createElement('div'), expected: false },
    { what: 'an anchor', make: () => document.createElement('a'), expected: false },
  ];

  function makeInput(type: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    return input;
  }

  it('answers the same for every element shape a keystroke can land in', () => {
    const mirror = document.createElement('div');
    for (const testCase of cases) {
      const element = testCase.make();
      const elsewhere = isEditableElement(element);
      const host = isHandledElsewhere(element, mirror);
      expect(elsewhere, `${testCase.what}: src/ui copy`).toBe(testCase.expected);
      expect(host, `${testCase.what}: renderer host copy`).toBe(testCase.expected);
      // And the element is *not* the mirror, so nothing here is passing because the
      // containment check short-circuited.
      expect(mirror.contains(element)).toBe(false);
    }
  });

  it('both copies read `isContentEditable`, and agree when it is present', () => {
    // jsdom omits the property, so the element carries it explicitly. The claim is
    // that the two implementations consult the *same* property, not that either
    // hard-codes a tag name.
    const element = document.createElement('div');
    Object.defineProperty(element, 'isContentEditable', { configurable: true, get: () => true });
    const mirror = document.createElement('div');
    expect(isEditableElement(element)).toBe(true);
    expect(isHandledElsewhere(element, mirror)).toBe(true);
    Object.defineProperty(element, 'isContentEditable', { configurable: true, get: () => false });
    expect(isEditableElement(element)).toBe(false);
    expect(isHandledElsewhere(element, mirror)).toBe(false);
  });

  it('claims an element inside the mirror and nothing else', () => {
    const mirror = document.createElement('div');
    const inside = document.createElement('button');
    const outside = document.createElement('button');
    mirror.appendChild(inside);
    document.body.appendChild(mirror);
    document.body.appendChild(outside);
    try {
      expect(isHandledElsewhere(inside, mirror)).toBe(true);
      expect(isHandledElsewhere(outside, mirror)).toBe(false);
      // With no mirror element there is nothing to claim, and the guard must not
      // throw on a null.
      expect(isHandledElsewhere(inside, null)).toBe(false);
      expect(isHandledElsewhere(null, mirror)).toBe(false);
    } finally {
      mirror.remove();
      outside.remove();
    }
  });
});
