/**
 * The build-time world-renderer switch, and the Phase 9 hermeticity guard.
 *
 * ## The switch
 *
 * Plan section 11 lists `VITE_WORLD_RENDERER=phaser|pixi` among the planned build-time
 * flags, `src/config/runtimeConfig.ts` already parses it, and `FEATURE_FLAG_MATRIX`
 * already assigns it to Phase 9. This phase adds no second mechanism and changes no
 * production default, so what needed holding was not the existence of the flag but the
 * three properties that make it safe to keep:
 *
 * 1. **The default is unchanged.** Unset means Phaser, in the parser, in the flag
 *    matrix, and in the build scripts. Phase 9 explicitly makes "no default renderer
 *    cutover" a non-goal, so a flag that quietly defaulted to Pixi would be a plan
 *    violation rather than an improvement.
 * 2. **Both values parse, and an invalid value fails the build.** A malformed flag
 *    must stop the build at configuration load, not produce an artifact that silently
 *    fell back.
 * 3. **A flag never carries learner data.** The parser deliberately does not echo the
 *    raw value in its diagnostics; this file asserts that, because the error path is
 *    exactly where a value that *should* have been a flag could leak something that
 *    is not.
 *
 * ## The hermeticity half
 *
 * Phase 8 shipped two gates green in a working tree and red in CI, both because they
 * depended on state a clean checkout does not have: one baselined against
 * `git show HEAD:...`, and another only ever ran from a tree under `/tmp`.
 * `tests/phase8/qa-hermeticity.test.ts` is the guard written afterwards, and this file
 * carries the same rule for Phase 9 - no Phase 9 gate resolves a commit. What it cannot
 * cheaply assert for itself is whether a test needs a `dist/`; so the assertion here is
 * the source-level rule, and the behavioural proof is that this file, and every other
 * Phase 9 gate, runs a synthetic tree through a `--dist=` override.
 *
 * Privacy: this file reads `package.json`, the workflow, the flag parser, and the
 * Phase 9 sources. It resolves no commit, reads no `dist`, and asserts on no learner
 * data. The flag parser's own test inputs are flag names and renderer names.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_CONFIG,
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
  WORLD_RENDERERS,
} from '../../src/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '../../src/config/featureFlags';

import { parseWorkflowJobs, REPO_ROOT, sourceOf, stripComments } from './support/phase9Build';

const PHASE9_ROOT = path.join(REPO_ROOT, 'tests', 'phase9');

const npmScripts = (JSON.parse(sourceOf('package.json')) as { scripts: Record<string, string> }).scripts;
const ciJobs = parseWorkflowJobs(readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

describe('the renderer flag has one mechanism, and its production default is the application host', () => {
  it('accepts exactly the two values the plan names', () => {
    expect([...WORLD_RENDERERS]).toEqual(['phaser', 'pixi']);
    expect(RUNTIME_FLAG_ENV_KEYS.worldRenderer).toBe('VITE_WORLD_RENDERER');
  });

  it('parses both values', () => {
    expect(parseRuntimeConfig({ VITE_WORLD_RENDERER: 'phaser' }).worldRenderer).toBe('phaser');
    expect(parseRuntimeConfig({ VITE_WORLD_RENDERER: 'pixi' }).worldRenderer).toBe('pixi');
    // Trimmed and case-normalised, so a CI matrix cannot fail on shell whitespace.
    expect(parseRuntimeConfig({ VITE_WORLD_RENDERER: '  PIXI \n' }).worldRenderer).toBe('pixi');
  });

  it('defaults to the application host (phaser); pixi selects the Phase 9 test host', () => {
    // This flag does not move at the Phase 23 cutover. It is a retained host switch, not a
    // world-renderer cutover: the real PixiJS worlds come from the per-world flags, and
    // `pixi` here selects the Phase 9 test host (`PixiWorldHost`), not a production world.
    expect(parseRuntimeConfig({}).worldRenderer).toBe('phaser');
    expect(DEFAULT_RUNTIME_CONFIG.worldRenderer).toBe('phaser');
    expect(FEATURE_FLAG_MATRIX.worldRenderer.productionDefault).toBe('phaser');
    expect(FEATURE_FLAG_MATRIX.worldRenderer.ownerPhase).toBe(9);
    expect(FEATURE_FLAG_MATRIX.worldRenderer.valueKind).toBe('enum');
    // The test-host value is a real option, and selecting it is explicit.
    expect(parseRuntimeConfig({ VITE_WORLD_RENDERER: 'pixi' }).worldRenderer).toBe('pixi');
  });

  it('fails the build on a value that is neither', () => {
    // Not a fallback: a malformed flag must stop configuration load, because a
    // silently defaulted flag produces an artifact that does not match what the
    // operator asked for. An explicitly empty value is malformed rather than unset -
    // `VITE_WORLD_RENDERER=` in a CI matrix is a mistake worth a red build, not a
    // silent reversion to the production default.
    expect(() => parseRuntimeConfig({ VITE_WORLD_RENDERER: 'threejs' })).toThrow(/VITE_WORLD_RENDERER/);
    expect(() => parseRuntimeConfig({ VITE_WORLD_RENDERER: 'phaser, pixi' })).toThrow(/VITE_WORLD_RENDERER/);
    expect(() => parseRuntimeConfig({ VITE_WORLD_RENDERER: true })).toThrow(/VITE_WORLD_RENDERER/);
    expect(() => parseRuntimeConfig({ VITE_WORLD_RENDERER: '' })).toThrow(/VITE_WORLD_RENDERER/);
  });

  it('never echoes a raw flag value, so a flag cannot become a channel for anything', () => {
    // The privacy half, asserted on the failure path: the diagnostic names the key
    // and the allowed values, never what was passed. A value that should not have been
    // a flag would otherwise appear in a build log through this line.
    let message = '';
    try {
      parseRuntimeConfig({ VITE_WORLD_RENDERER: 'a-note-the-operator-pasted' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('VITE_WORLD_RENDERER');
    expect(message).toContain('phaser, pixi');
    expect(message).not.toContain('a-note-the-operator-pasted');
  });

  it('keeps the explicit Pixi builds as delegations, and isolates the per-world switches', () => {
    expect(npmScripts['build:web']).toBe('npm run build');
    expect(npmScripts['build']).not.toContain('VITE_WORLD_RENDERER');
    // The Pixi build delegates to the production script with one variable changed,
    // which is what keeps the two builds from drifting apart. After the Phase 23
    // cutover this is an explicit pin of the value the production default already has.
    expect(npmScripts['build:web:pixi']).toBe('VITE_WORLD_RENDERER=pixi npm run build:web');
    // The Phase 11 village build is the same delegation for the renderer-neutral
    // village switch, but the cutover makes every per-world switch default on, so the
    // isolation is explicit: the host stays phaser and the other two worlds are off, so
    // the village is the only Pixi world switched on and the Phase 9 renderer check
    // cannot cover it.
    expect(npmScripts['build:web:pixi-village']).toBe(
      'VITE_WORLD_RENDERER=phaser VITE_PIXI_VILLAGE=true VITE_PIXI_DUNGEON=false VITE_PIXI_FISHING=false npm run build:web',
    );
  });

  it('is a build-time variable, not a runtime setting a learner can change', () => {
    const flag = FEATURE_FLAG_MATRIX.worldRenderer;
    expect(flag.purpose).toContain('adapter');
    // A host switch, documented as such: the default is the application host and `pixi`
    // is the Phase 9 test host, not a production world.
    expect(flag.rollback).toBe(
      'Not a cutover: keep VITE_WORLD_RENDERER unset (or `phaser`) for the application host. `VITE_WORLD_RENDERER=pixi` selects the Phase 9 test host and is not a production world renderer.',
    );
    // Nothing writes it into local storage or into a URL. The one place the flag is
    // read is the build-time parser and the module that parses it once.
    const parser = sourceOf('src/config/runtimeConfig.ts');
    expect(parser).toContain('Build-time environment contract. These values must never contain learner data.');
    // A build-time flag has no runtime storage and no place in a URL, because both are
    // readable by the application and either would turn a compile-time decision into
    // something a learner or a link could change.
    for (const runtimeChannel of ['sessionStorage', 'URLSearchParams', 'setItem', 'document.cookie']) {
      expect(parser, runtimeChannel).not.toContain(runtimeChannel);
    }
  });
});

/**
 * The Phase 11 village switch, and how it relates to the Phase 9 renderer switch.
 *
 * ## The property that matters
 *
 * `VITE_PIXI_VILLAGE` is a second, independent build-time contract. A build can set
 * it while `VITE_WORLD_RENDERER` stays `phaser`, which is exactly what
 * `build:web:pixi-village` does: the village is the only thing switched on. So the
 * flag cannot be folded into the renderer enum, and the chunk audit needed its own
 * additive check.
 *
 * What is asserted here is the parser side - default off, both booleans parse, a
 * malformed value fails configuration load - and the bundler-visible shape on the
 * screen: a literal comparison with no normalising call before it, and two dynamic
 * imports, so the default build can delete the Pixi arm and its chunk. The plugin's
 * own truth table lives in `tests/phase9/renderer-chunk-boundary.test.ts`.
 */
describe('the village switch is additive to the renderer switch, and defaults on after the cutover', () => {
  const dynamicImports = (source: string): string[] =>
    [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);

  it('parses with the cutover default, and never moves any other flag', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.pixiVillage).toBe('VITE_PIXI_VILLAGE');
    expect(parseRuntimeConfig({}).pixiVillage).toBe(true);
    expect(DEFAULT_RUNTIME_CONFIG.pixiVillage).toBe(true);
    expect(parseRuntimeConfig({ VITE_PIXI_VILLAGE: 'true' }).pixiVillage).toBe(true);
    expect(parseRuntimeConfig({ VITE_PIXI_VILLAGE: 'false' }).pixiVillage).toBe(false);
    expect(parseRuntimeConfig({ VITE_PIXI_VILLAGE: ' TRUE ' }).pixiVillage).toBe(true);
    // Setting the village flag does not move any other flag: the contracts are
    // independent, and a build that set several would be an explicit choice.
    const withVillage = parseRuntimeConfig({ VITE_PIXI_VILLAGE: 'true' });
    const defaults = parseRuntimeConfig({});
    for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
      if (key === 'pixiVillage') continue;
      expect(withVillage[key], key).toBe(defaults[key]);
    }
    expect(() => parseRuntimeConfig({ VITE_PIXI_VILLAGE: 'yes' })).toThrow(/VITE_PIXI_VILLAGE/);
  });

  it('is registered against this phase and documents its rollback', () => {
    expect(FEATURE_FLAG_MATRIX.pixiVillage.environmentVariable).toBe('VITE_PIXI_VILLAGE');
    expect(FEATURE_FLAG_MATRIX.pixiVillage.valueKind).toBe('boolean');
    expect(FEATURE_FLAG_MATRIX.pixiVillage.productionDefault).toBe(true);
    expect(FEATURE_FLAG_MATRIX.pixiVillage.ownerPhase).toBe(11);
    expect(FEATURE_FLAG_MATRIX.pixiVillage.rollback).toContain('VITE_PIXI_VILLAGE=false');
  });

  it('is compared against a literal, so the default build can delete the Pixi branch', () => {
    const screen = sourceOf('src/ui/screens/VillageScreen.tsx');
    expect(screen).toContain("import.meta.env.VITE_PIXI_VILLAGE === 'true'");
    // A normalisation step before the comparison defeats dead-branch elimination and
    // leaves the default build carrying a Pixi chunk it will never fetch. Measured,
    // not assumed, in `src/ui/App.tsx` for the renderer switch; the same rule applies.
    const branch = screen.slice(screen.indexOf("import.meta.env.VITE_PIXI_VILLAGE === 'true'"));
    const beforeNextStatement = branch.split('\n').slice(1, 6).join('\n');
    expect(
      beforeNextStatement,
      'normalise the flag in runtimeConfig, not in the bundler-visible comparison',
    ).not.toMatch(/\.(trim|toLowerCase|toUpperCase)\s*\(/);
    // Both arms are dynamic imports: the flagged arm is the Pixi chunk, the default
    // arm is the Phaser village. A static import of either would put an engine in the
    // village route's first paint.
    const imports = dynamicImports(screen);
    expect(imports).toContain('@/renderers/pixi/village/VillageWorld');
    expect(imports).toContain('@/game/createVillageGame');
    // And no *value* static import names either engine's module. A type-only import
    // is erased at build time and cannot put an engine in a chunk, so the Pixi type
    // import (asserted separately in `pixi-host-boundary.test.ts`) is not a value
    // reach and is deliberately not matched here.
    expect(screen).not.toMatch(/^\s*import\s+(?!type\b)[^\n]*['"]@\/renderers\/pixi\/village\/VillageWorld['"]/m);
    expect(screen).not.toMatch(/^\s*import\s+(?!type\b)[^\n]*['"]@\/game\/createVillageGame['"]/m);
  });

  it('documents the flag as build-time only, with its post-cutover default and rollback', () => {
    const example = sourceOf('.env.example');
    expect(example).toContain('VITE_PIXI_VILLAGE');
    // Phase 23 flips the default on; the file must state both the default and the
    // rollback value a release operator would set.
    expect(example).toMatch(/build-time flag/i);
    expect(example).toMatch(/Default: true/i);
    expect(example).toContain('VITE_PIXI_VILLAGE=false');
  });
});

describe('no Phase 9 gate resolves a commit', () => {
  function phase9Sources(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...phase9Sources(full));
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
    return found.sort();
  }

  const HISTORY_SUBCOMMANDS = [
    'show', 'log', 'diff', 'cat-file', 'rev-parse', 'ls-tree', 'rev-list',
    'merge-base', 'describe', 'blame', 'hash-object', 'status', 'checkout', 'stash', 'fetch',
  ];
  const HISTORY_READ = new RegExp(
    `(['"\`]git['"\`][^\\n]{0,200}?\\b(?:${HISTORY_SUBCOMMANDS.join('|')})\\b)` +
      `|(\\bgit\\s+(?:${HISTORY_SUBCOMMANDS.join('|')})\\b)`,
    'i',
  );

  const scanned = phase9Sources(PHASE9_ROOT);

  it('walks a real set of sources, so the scan below is not an empty walk', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(5);
    for (const file of scanned) expect(readFileSync(file, 'utf8').length, file).toBeGreaterThan(0);
    // And at least one of them spawns a process, which is the only way a gate could
    // read history in the first place.
    expect(
      scanned.some((file) => /child_process/.test(stripComments(readFileSync(file, 'utf8')))),
    ).toBe(true);
  });

  it('flags a history read and allows a working-tree query, so the rule has teeth', () => {
    // Assembled from fragments, comment delimiters included: this file scans itself,
    // and a control written as one literal would either be a real match in its own
    // source or be eaten by this file's own comment stripper.
    const controls: ReadonlyArray<{ what: string; code: readonly string[]; flagged: boolean }> = [
      {
        what: 'a spawn with a history subcommand in the argument list',
        code: ["execFileSync('g", "it', ['show', 'HEAD:package.json'])"],
        flagged: true,
      },
      {
        what: 'a command line inside a string',
        code: ['await run("g', 'it log --oneline");'],
        flagged: true,
      },
      {
        what: 'a working-tree ignore query, which resolves no commit',
        code: ["execFileSync('g", "it', ['check-ignore', '--quiet', '--', 'dist'])"],
        flagged: false,
      },
      {
        what: 'a line comment that mentions the rule',
        code: ['// a gate must not read g', 'it history\nconst limit = 1;'],
        flagged: false,
      },
      {
        what: 'an https URL in a string literal',
        code: ['const reference = "https://example.invalid/a.js";'],
        flagged: false,
      },
    ];
    for (const control of controls) {
      expect(HISTORY_READ.test(stripComments(control.code.join(''))), control.what).toBe(control.flagged);
    }
  });

  it('has no offender', () => {
    const offenders = scanned
      .filter((file) => HISTORY_READ.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders, 'a phase 9 gate resolves a commit').toEqual([]);
  });

  it('depends on no build output, so it passes on a clean checkout before a build', () => {
    // The behavioural half of the same rule. Every Phase 9 gate that reads an artifact
    // takes `--dist=` and is exercised against a synthetic tree, so none of them
    // requires a `dist/` that a clean checkout does not have.
    const memoryGate = npmScripts['check:memory'];
    expect(memoryGate).toBe('node scripts/check-memory.mjs');
    expect(sourceOf('scripts/check-memory.mjs')).toContain('--dist=DIR');
    expect(sourceOf('scripts/check-welcome-budget.mjs')).toContain('--dist=DIR');
    // And no Phase 9 gate spawns a build. The check is on the spawn, not on the text:
    // several of these files assert that a CI step *contains* `npm run build:web`, and
    // a substring scan would fail on the assertion that is doing the holding.
    const spawnsABuild =
      /(?:spawnSync|execFileSync|execSync)\s*\(\s*(?:process\.execPath|'npm'|"npm"|`npm`)[\s\S]{0,160}?(?:build:web|build:storage|vite build)/;
    for (const file of scanned) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(spawnsABuild.test(source), file).toBe(false);
    }
    // Controls, assembled from fragments because this file scans itself: a positive,
    // the same spawn reached without `npm`, and the assertion text that must not match.
    const verb = 'spawn' + 'Sync';
    const pkg = "'" + 'npm' + "'";
    const script = 'build' + ':web';
    expect(spawnsABuild.test(`${verb}(${pkg}, ['run', '${script}'])`)).toBe(true);
    expect(spawnsABuild.test(`${verb}(process.execPath, ['${'node_modules/npm/bin/npm-cli.js'}', 'run', '${script}'])`)).toBe(
      true,
    );
    expect(spawnsABuild.test(`expect(buildJob).toContain('npm run ${script}')`)).toBe(false);
  });
});

describe('the CI wiring and the local commands name the same things', () => {
  it('the Pixi build and both preflight steps are in the one job that already installs', () => {
    const buildJob = ciJobs.get('web-build') ?? '';
    expect(buildJob).toContain('Build the Phase 9 Pixi-flagged artifact');
    expect(buildJob).toContain('Enforce the renderer memory preflight on the Pixi-flagged artifact');
    expect(buildJob).toContain('npm run build:web:pixi');
  });
});
