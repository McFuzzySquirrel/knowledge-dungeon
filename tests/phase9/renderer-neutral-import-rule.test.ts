/**
 * The ESLint renderer-boundary rule, probed the way ESLint resolves it.
 *
 * ## Why this file exists
 *
 * `FORBIDDEN_RENDERER_IMPORTS` in `eslint.config.js` is a list of glob patterns in a
 * config file, and a list in a config file reports nothing about itself. When Phase 9
 * introduced a second renderer tree at `src/renderers/**`, the list kept its `src/game/**`
 * entries and gained no `src/renderers/**` ones - so a renderer-neutral layer could
 * import `@/renderers/pixi/runtime/types` or `../renderers/pixi/runtime/types` and
 * ESLint reported nothing. QA's independent pass probed eight violating files and found
 * exactly that: every pre-existing specifier was caught, and both forms of the new one
 * were not.
 *
 * The reason this was serious rather than a shipped defect is worth keeping on the
 * record, because it is the same shape as several other findings in this repository: a
 * leak that actually *ships* was caught by the `writeBundle` chunk audit, so the
 * load-bearing gate held. What was missing was defence in depth on the exact layer the
 * rule exists to police, and a reader of the config would reasonably have believed
 * `src/renderers/**` was covered. The asymmetry with `src/game/**` was the tell.
 *
 * ## What this file does, and deliberately does not, do
 *
 * It resolves the rule through ESLint itself (`--print-config`, the same mechanism
 * `tests/phase8/renderer-neutral-layer-wiring.test.ts` uses) for one real file in every
 * declared renderer-neutral layer, and then runs the *resolved* rule over synthetic
 * import statements with the `Linter` API. So it tests what the rule resolves to, not
 * this file's reading of the source text.
 *
 * It writes nothing into the repository. A probe file in `src/core/` would prove the same
 * thing, and it is what QA did by hand, but a gate that creates and deletes a source file
 * on every commit is a gate that can leave one behind - and a stray violating file in a
 * neutral layer is exactly the defect this gate exists to prevent. The evidence for the
 * real build is in the verification report; the throwaway-file probe is reproduced there
 * verbatim.
 *
 * ## Hermeticity
 *
 * Reads `eslint.config.js`, resolves the config for paths that exist on disk, and runs
 * lint over in-memory source text. No build, no `dist`, no browser, no network, no
 * resolution of a commit. It passes on a clean checkout.
 *
 * Privacy: nothing here reads, writes, or names learner data. The only inputs are a
 * config file, a directory listing, and a handful of import specifiers.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceOf, stripComments } from './support/phase9Build';

/** A real file in each declared layer, so `--print-config` is asked about a path that exists. */
const LAYER_PROBES: readonly { layer: string; file: string }[] = [
  { layer: 'src/core/**/*.{ts,tsx}', file: 'src/core/fishing/fishCollectionService.ts' },
  { layer: 'src/application/**/*.{ts,tsx}', file: 'src/application/studyFlow.ts' },
  { layer: 'src/services/persistence/v2/**/*.{ts,tsx}', file: 'src/services/persistence/v2/archive.ts' },
  {
    layer: 'src/services/persistence/products/**/*.{ts,tsx}',
    file: 'src/services/persistence/products/idRemapping.ts',
  },
  { layer: 'src/theme/**/*.{ts,tsx}', file: 'src/theme/cozyTokens.ts' },
];

/**
 * One real file inside the renderer tree, which must stay *out* of scope.
 *
 * This is the control for the whole file. The renderer host imports `pixi.js` on
 * purpose - two files do, by design - so if the boundary ever covered `src/renderers/**`
 * the application would stop linting at all, and the rule would be refusing the code it
 * exists to protect.
 */
const RENDERER_TREE_CONTROL = 'src/renderers/pixi/runtime/createPixiApplication.ts';

const eslintConfigSource = sourceOf('eslint.config.js');

/** The quoted entries of a named array literal in the config, in order. */
function configArray(name: string): string[] {
  const list = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(eslintConfigSource);
  if (list === null) throw new Error(`eslint.config.js has no ${name} array.`);
  return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/**
 * The rule as ESLint resolved it for one path, or `undefined` when it is absent.
 *
 * `--print-config` is the authoritative answer: it runs the real config, so a glob
 * this file misreads still reports the truth here.
 */
function resolvedRuleFor(repoRelativePath: string): unknown {
  const output = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      '--print-config',
      repoRelativePath,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
  );
  return (JSON.parse(output) as { rules: Record<string, unknown> }).rules['no-restricted-imports'];
}

interface ResolvedRule {
  readonly severity: number;
  /** The one `patterns[].group` the boundary block applies, verbatim. */
  readonly group: readonly string[];
  readonly message: string;
}

/** Pulls the single pattern group out of a resolved `no-restricted-imports` rule. */
function groupOf(resolved: unknown): ResolvedRule {
  if (!Array.isArray(resolved)) throw new Error('The rule did not resolve to an array.');
  const [severity, options] = resolved as [number, { patterns?: { group: string[]; message: string }[] }];
  const patterns = options?.patterns;
  if (!Array.isArray(patterns) || patterns.length !== 1) {
    throw new Error('The rule does not hold exactly one pattern group.');
  }
  return { severity, group: patterns[0].group, message: patterns[0].message };
}

/**
 * Lints one synthetic import against a resolved rule, in memory.
 *
 * The `files` entry is load-bearing rather than boilerplate: with no `files` glob, a flat
 * config the `Linter` is handed directly matches nothing and every call reports
 * "No matching configuration found" - which is a *pass* for every assertion here unless
 * the caller also checks `ruleId`, because the message is not a rule violation. So the
 * rule's own `ruleId` is what this filters on, and the control below asserts that this
 * helper reports a violation at all.
 */
function reportsFor(
  resolved: ResolvedRule,
  filePath: string,
  specifier: string,
  kind: 'value' | 'type' = 'value',
): string[] {
  const source =
    kind === 'value'
      ? `import { Thing } from '${specifier}';\nexport const used = Thing;\n`
      : `import type { Thing } from '${specifier}';\nexport const used = (v: Thing): unknown => v;\n`;
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    source,
    {
      files: ['**/*.ts', '**/*.tsx'],
      // The repository's own parser, so a `import type` fixture parses. Without it the
      // probe's own source is a syntax error and the type-only case - the exact shape
      // of the Phase 9 defect - could not be exercised at all.
      languageOptions: { parser: tsParser },
      rules: {
        'no-restricted-imports': [
          resolved.severity as 0 | 1 | 2,
          { patterns: [{ group: [...resolved.group], message: resolved.message }] },
        ],
      },
    },
    filePath,
  );
  const violations = messages.filter((message) => message.ruleId === 'no-restricted-imports');
  // A configuration that matched nothing would otherwise read as a clean lint.
  const unmatched = messages.filter((message) => message.ruleId === null);
  if (unmatched.length > 0) throw new Error(`The flat config matched nothing for ${filePath}: ${unmatched[0].message}`);
  return violations.map((message) => message.message);
}

describe('the rule covers the renderer tree Phase 9 introduced, in every declared layer', () => {
  it('resolves to one group that refuses both renderer trees, aliased and relative', () => {
    // The specifiers QA's independent pass probed and ESLint did not report on. Both
    // are here, plus the bare-root and single-segment forms the `src/game/**` entries
    // already used, so the two trees are held by the same shapes.
    const mustRefuse = [
      '@/renderers',
      '@/renderers/*',
      '@/renderers/**',
      '**/../renderers',
      '**/../renderers/**',
      '@/game',
      '@/game/*',
      '@/game/**',
      '**/../game',
      '**/../game/**',
    ];
    const group = configArray('FORBIDDEN_RENDERER_IMPORTS');
    for (const specifier of mustRefuse) {
      expect(group, `the boundary list has no '${specifier}' entry`).toContain(specifier);
    }
    // The pre-existing engine packages, so this file cannot pass by the list having
    // been narrowed rather than widened.
    for (const specifier of ['phaser', 'phaser/**', 'pixi.js', 'pixi.js/**', '@pixi/*', '@pixi/**']) {
      expect(group, specifier).toContain(specifier);
    }
  });

  it('each layer resolves to the rule, and the rule bites on the new tree', () => {
    // Resolved per layer rather than read from the source text, so a layer that is
    // declared but not wired to the rule fails here instead of reading as coverage.
    for (const { layer, file } of LAYER_PROBES) {
      const resolved = resolvedRuleFor(file);
      expect(resolved, `the rule does not reach ${file} (${layer})`).toBeDefined();
      const rule = groupOf(resolved);
      expect(rule.severity, layer).toBe(2);

      for (const specifier of [
        '@/renderers/pixi/runtime/types',
        '../renderers/pixi/runtime/types',
        'pixi.js',
        'pixi.js/unsafe-eval',
      ]) {
        const reports = reportsFor(rule, file, specifier);
        expect(reports.length, `${file} importing '${specifier}'`).toBe(1);
        expect(reports[0], file).toContain('renderer-neutral');
      }
    }
  }, 120_000);

  it('refuses a type-only import of the renderer tree, which is renderer coupling too', () => {
    // The whole shape of the Phase 9 defect was a `import type` in a neutral layer, so
    // the type-only case is the one that has to hold here rather than the value case.
    const rule = groupOf(resolvedRuleFor('src/core/fishing/fishCollectionService.ts'));
    const reports = reportsFor(rule, 'src/core/fishing/fishCollectionService.ts', '@/renderers/pixi/runtime/types', 'type');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('type-only imports are both forbidden');
  }, 60_000);

  it('the renderer tree itself stays out of scope, and is clean', () => {
    // The control. `src/renderers/**` is where the engine is *supposed* to be named, so
    // covering it would refuse the code the rule exists to protect. Asserted in two
    // directions: the rule does not resolve there, and a real renderer module has no
    // boundary finding of its own.
    expect(
      resolvedRuleFor(RENDERER_TREE_CONTROL),
      `the boundary rule now covers ${RENDERER_TREE_CONTROL}`,
    ).toBeUndefined();

    const binding = stripComments(sourceOf(RENDERER_TREE_CONTROL));
    // Non-vacuity on the real tree: the control file is one of the two modules that
    // names `pixi.js` on purpose, so the "stays out of scope" assertion above is a
    // statement about a file that genuinely has the import in it.
    expect(binding).toMatch(/from ['"]pixi\.js['"]/);
  }, 60_000);
});

describe('the rule message names every layer it now covers', () => {
  it('lists all five layers, and both renderer trees, in the message ESLint prints', () => {
    // The message is what a developer sees on a red lint, and it used to name two
    // layers out of five and one renderer tree out of two. A message that understates
    // its own scope teaches the reader that the rest of the config is decoration, which
    // is how a missing entry survives a review.
    const rule = groupOf(resolvedRuleFor('src/core/fishing/fishCollectionService.ts'));
    for (const layer of configArray('RENDERER_NEUTRAL_LAYERS')) {
      // The layer globs carry a `/**/*.{ts,tsx}` suffix; the message names the tree.
      const tree = layer.replace(/\/\*\*\/\*\.\{ts,tsx\}$/, '').replace(/\/$/, '');
      expect(rule.message, `the message does not name ${tree}`).toContain(tree);
    }
    for (const tree of ['src/game/**', 'src/renderers/**']) {
      expect(rule.message, `the message does not name ${tree}`).toContain(tree);
    }
    // And the claim it is making, which is what the layers share.
    expect(rule.message).toContain('renderer-neutral');
    expect(rule.message).toContain('Value and type-only imports are both forbidden');
  }, 60_000);

  it('the config comments state that both trees are covered, so the source is not the only record', () => {
    // The file's own prose. A config entry with no comment is the thing this whole
    // finding is about, so the comment has to carry the reason as well as the pattern.
    // Matched across line breaks rather than against one exact wrapping, so a reflow of
    // the comment cannot silently un-hold the assertion.
    expect(eslintConfigSource).toMatch(/`@\/renderers`\s*\n \*\s*matches the alias Vite resolves to `src\/renderers`/);
    expect(eslintConfigSource).toContain('was listed from Phase 2 and `src/renderers/**` was introduced by');
    expect(eslintConfigSource).toContain('a downstream catch happens only once the leak ships');
  });
});

describe('a sibling test file covers only the aliased form, and that is a reported gap', () => {
  it('REPORTED GAP: the boundary scan prefix-matches specifiers instead of resolving them', () => {
    // `tests/phase9/pixi-host-boundary.test.ts` walks the neutral layers and matches
    // `specifier.startsWith('@/renderers')` and `specifier.startsWith('@/game')`. It
    // therefore catches `@/renderers/...` and misses `../renderers/...` and
    // `../../src/renderers/...` entirely, because a relative specifier shares no prefix
    // with the tree it reaches. That file is not this phase's infrastructure to edit, so
    // the gap is pinned here instead of closed there: if it is ever closed, this test
    // goes red and the note is removed in the same change.
    //
    // What covers the `..`-relative form today is the ESLint rule (asserted above, over
    // every declared layer) and the emitted-graph audit in `vite.config.ts`, which
    // catches a reach-through that actually ships. Neither is the boundary scan, so the
    // scan's claim is narrower than its name suggests.
    //
    // Read raw rather than through `stripComments`: that helper's block-comment pass
    // is non-greedy, and a `/*` inside a string or a regex literal earlier in the file
    // pairs with a later `*/` and removes the middle of the file. That is a property of
    // the helper, not of the scan, and it is why this assertion does not depend on it.
    const boundaryScan = sourceOf('tests/phase9/pixi-host-boundary.test.ts');
    const caseStart = boundaryScan.indexOf("specifier.startsWith('@/renderers')");
    expect(caseStart, 'the boundary scan no longer has the case this gap describes').toBeGreaterThan(0);
    const neutralLayerCase = boundaryScan.slice(caseStart, boundaryScan.indexOf('});', caseStart));
    expect(neutralLayerCase).toContain("specifier.startsWith('@/game')");
    // The shape of the gap, stated as the thing it is: prefix matching on the literal
    // specifier, with no resolution step, so no `..`-relative specifier can be told
    // apart from an unrelated relative one. The condition names the two aliased roots
    // and nothing that a relative path would produce.
    expect(neutralLayerCase).toMatch(/specifier\.startsWith\('@\/renderers'\) \|\|/);
    expect(neutralLayerCase).not.toMatch(/path\.resolve/);
    expect(neutralLayerCase).not.toContain("specifier.startsWith('..')");
    // And the control this file keeps instead: the ESLint rule resolves, and a relative
    // reach-through into the renderer tree is reported by it. `../renderers/...` and
    // `../../renderers/...` are both caught, which is the form a real relative import
    // takes.
    const rule = groupOf(resolvedRuleFor('src/core/fishing/fishCollectionService.ts'));
    for (const specifier of [
      '../renderers/pixi/runtime/types',
      '../../renderers/pixi/runtime/types',
    ]) {
      expect(reportsFor(rule, 'src/core/fishing/fishCollectionService.ts', specifier), specifier).toHaveLength(1);
    }
  }, 60_000);

  it('REPORTED LIMITATION: a specifier that re-enters `src` by name is not matched, in either tree', () => {
    // `../../src/renderers/...` and `../../src/game/...` resolve to the renderer tree
    // and are not refused. The `**/../<tree>` globs need the tree segment to follow
    // `..` directly, and these have `src/` in between.
    //
    // Reported rather than fixed, and deliberately not fixed: the shape has existed for
    // `src/game/**` since Phase 2 and no code in the repository writes it - a relative
    // specifier that walks up past the root and back down into `src` resolves identically
    // through the alias. Adding a pattern for it would cover one form of a mistake nobody
    // makes while the same mistake through the alias is refused, which reads as thorough
    // and is not. The backstop is unchanged: `vite.config.ts`'s `writeBundle` audit fails
    // the build if a renderer reaches the entry's static closure, which is what a shipped
    // leak looks like. Pinned so the limitation stays visible rather than being rediscovered.
    const rule = groupOf(resolvedRuleFor('src/core/fishing/fishCollectionService.ts'));
    for (const specifier of ['../../src/renderers/pixi/runtime/types', '../../src/game/scenes/VillageScene']) {
      expect(reportsFor(rule, 'src/core/fishing/fishCollectionService.ts', specifier), specifier).toEqual([]);
    }
    // And the alias form of the identical reach, which is refused.
    expect(reportsFor(rule, 'src/core/fishing/fishCollectionService.ts', '@/renderers/pixi/runtime/types')).toHaveLength(1);
  }, 60_000);
});
