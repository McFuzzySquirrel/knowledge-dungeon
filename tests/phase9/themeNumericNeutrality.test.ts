/**
 * Phase 9: the new numeric exports stay renderer-neutral.
 *
 * ## Why the numeric mirrors need their own neutrality gate
 *
 * The Phase 8 gate already walks `src/theme/**` and fails on a renderer, a React, or a
 * DOM reach-through. That gate is a *list* gate: it enumerates the modules declared in
 * `RENDERER_NEUTRAL_THEME_MODULES`, so it covers a new module only because the new
 * module was deliberately added to that list. That is the right mechanism - adding a
 * module to `src/theme/` has to be a decision rather than a smuggled-in file - and it
 * leaves two questions for Phase 9, which added both a module and a set of exports:
 *
 * 1. **Does the new module actually drag anything in?** Not as a claim about a list -
 *    as a claim about the graph. `cozyNumbers.ts` is asserted to be a *leaf*: its
 *    transitive first-party closure is itself and nothing else. A renderer reading a
 *    radius through it therefore cannot pull a colour table, a config module, or a
 *    renderer along behind it, and that is checked rather than assumed.
 * 2. **Do the numbers survive a realm with no DOM and no React?** A value test in a
 *    jsdom suite can only prove the numbers are correct where a DOM exists. The host
 *    that will read them - a PixiJS application on a canvas, or the same bundle in a
 *    worker - has no `document`, no `window`, and no React at all. So the barrel is
 *    bundled on its own, run in a fresh Node process with every DOM global replaced by
 *    a throwing getter, and the numbers are read there, through the same boot sequence
 *    a host would use, with no CSS-unit parsing anywhere in it.
 *
 * That second half is the Phase 9 exit criterion stated as a test: "the host reads
 * Cozy geometry, typography, and motion as numbers, with no CSS-unit parsing in
 * renderer code". The first half is the precondition for it - a token module that
 * needed a DOM could not produce those numbers there.
 *
 * ## Hermeticity
 *
 * Three properties Phase 8 shipped gates lacked, and this file holds all three:
 *
 * - **No history.** Nothing here resolves a commit, so the verdict is the same in a
 *   fresh clone, a depth-1 clone, and a working tree.
 * - **No location.** The bundle and the probe live in a fresh directory under the OS
 *   temp folder, and the probe's report is asserted to contain no path at all - the
 *   test compares `stdout` against the working directory string, so a future field
 *   carrying a path fails here rather than in a reviewer's CI.
 * - **No `dist/`.** Nothing reads a build output. A checkout with no `dist/` and a
 *   checkout with a stale one get the same verdict.
 *
 * Privacy: no learner data, no network, no storage. The probe reads the theme bundle
 * and nothing else; every input is a token table or a hard-coded name.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const THEME_DIR = path.join(REPO_ROOT, 'src', 'theme');
const PROBE_PATH = path.join(REPO_ROOT, 'tests', 'phase9', 'support', 'numericTokenProbe.mjs');

/**
 * Packages a renderer-neutral module may never import.
 *
 * `pixi.js` and `@pixi/*` are the ones Phase 9 makes relevant: they are installed now,
 * so a stray import would resolve, bundle, and work in a dev build while making the
 * token source unusable from a worker or from anything that is not a Pixi host.
 */
const FORBIDDEN_SPECIFIERS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'phaser',
  'pixi.js',
  '@pixi/',
  'three',
  'konva',
  'fabric',
  'zustand',
] as const;

/** Node built-ins that mean the module is not a worker-safe library. */
const FORBIDDEN_NODE_BUILTINS = [
  'node:fs',
  'node:path',
  'node:os',
  'node:child_process',
  'node:worker_threads',
] as const;

/**
 * Globals a renderer-neutral module may not reach for as a value.
 *
 * Comments are stripped before the scan, so a module is free to *explain* that it
 * never touches a `document`; what it may not do is touch one.
 */
const FORBIDDEN_GLOBALS = [
  'document',
  'window',
  'self',
  'navigator',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
  'Phaser',
  'PIXI',
  'process',
  'eval',
] as const;

/** The module that holds the conversion, and the two it serves. */
const NUMBERS_MODULE = 'cozyNumbers.ts';
const CONSUMERS = ['cozyTokens.ts', 'motion.ts'] as const;

function themeFile(name: string): string {
  return path.join(THEME_DIR, name);
}

/** Strips block and line comments, keeping a protocol-relative URL inside a string. */
function liveCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

/** Import specifiers, ignoring anything inside a block or line comment. */
function importSpecifiers(source: string): string[] {
  const code = liveCode(source);
  const specifiers: string[] = [];
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ]) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveFirstParty(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
  ]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // keep probing
    }
  }
  return null;
}

/** The transitive first-party import closure, keyed by absolute file path. */
function firstPartyClosure(entries: readonly string[]): Map<string, readonly string[]> {
  const seen = new Map<string, readonly string[]>();
  const queue: { file: string; via: readonly string[] }[] = entries.map((file) => ({
    file,
    via: [],
  }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.file)) continue;
    seen.set(next.file, next.via);
    for (const specifier of importSpecifiers(readFileSync(next.file, 'utf8'))) {
      const resolved = resolveFirstParty(next.file, specifier);
      if (resolved && !seen.has(resolved)) {
        queue.push({ file: resolved, via: [...next.via, specifier] });
      }
    }
  }
  return seen;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The reasons a source reaches for `global`, as a list, so a caller can assert on
 * the finding rather than on a regex.
 *
 * Matched as a *value*, not merely named: no leading word character, `$`, or quote,
 * so `process.env` and a mention inside a string literal do not match. Comments are
 * expected to be stripped by the caller, which is what lets a module explain the
 * rule without tripping it.
 */
function globalsReferencedIn(source: string, global: string): string[] {
  const pattern = new RegExp(`(?<![\\w$.'"\\\`])${escapeRegExp(global)}\\b`);
  return pattern.test(source) ? [`references the '${global}' global`] : [];
}

describe('the conversion module is a leaf, so a number cannot drag anything in', () => {
  it('has no imports at all', async () => {
    const source = await readFile(themeFile(NUMBERS_MODULE), 'utf8');
    expect(importSpecifiers(source), `${NUMBERS_MODULE} imports something`).toEqual([]);
    // The graph form of the same claim, which is what a renderer actually pays for:
    // one module, no edges.
    const closure = firstPartyClosure([themeFile(NUMBERS_MODULE)]);
    expect([...closure.keys()].map((file) => path.basename(file))).toEqual([NUMBERS_MODULE]);
  });

  it('is reached only by the two token modules it serves', () => {
    const importers: string[] = [];
    for (const name of [...CONSUMERS, 'cozyCss.ts', 'cozyColor.ts', 'cozyScope.ts', 'typography.ts']) {
      for (const specifier of importSpecifiers(readFileSync(themeFile(name), 'utf8'))) {
        if (specifier === './cozyNumbers') importers.push(name);
      }
    }
    expect(importers.sort()).toEqual([...CONSUMERS].sort());
  });
});

describe('the numeric exports reach no renderer, no React, and no DOM', () => {
  it('keeps the whole first-party closure of the token core free of them', () => {
    const entries = [...CONSUMERS, NUMBERS_MODULE].map(themeFile);
    const closure = firstPartyClosure(entries);
    // Non-vacuous: the walk found the modules it was pointed at, and the token
    // modules' own dependencies too.
    expect(closure.size).toBeGreaterThanOrEqual(entries.length);
    for (const entry of entries) expect(closure.has(entry)).toBe(true);

    const offenders: string[] = [];
    for (const [file, via] of closure) {
      const relative = path.relative(REPO_ROOT, file);
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        for (const forbidden of [...FORBIDDEN_SPECIFIERS, ...FORBIDDEN_NODE_BUILTINS]) {
          if (specifier === forbidden || specifier.startsWith(forbidden)) {
            const trail = via.length > 0 ? ` (reached via ${via.join(' -> ')})` : '';
            offenders.push(`${relative} imports '${specifier}'${trail}`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('names no DOM, renderer, or server global in the new module', () => {
    const source = liveCode(readFileSync(themeFile(NUMBERS_MODULE), 'utf8'));
    const offenders: string[] = [];
    for (const forbidden of FORBIDDEN_GLOBALS) {
      offenders.push(...globalsReferencedIn(source, forbidden).map((why) => `${NUMBERS_MODULE} ${why}`));
    }
    if (/\bFunction\s*\(/.test(source)) offenders.push(`${NUMBERS_MODULE} builds a function`);
    expect(offenders, offenders.join('\n')).toEqual([]);

    // The control, so "no offender" above is a scan that found nothing rather than a
    // scan that cannot find anything: a real reach-through is flagged, a mention in a
    // comment is not (the caller strips comments first, which is what lets a module
    // explain the rule without tripping it), and a mention inside a string is not.
    expect(globalsReferencedIn('const el = document.createElement("div");', 'document')).toEqual([
      "references the 'document' global",
    ]);
    expect(globalsReferencedIn("const url = 'https://example.invalid/a.js';", 'document')).toEqual([]);
    expect(globalsReferencedIn(liveCode('/* a renderer has no document here */ const n = 1;'), 'document')).toEqual(
      [],
    );
    expect(globalsReferencedIn('const w = window.innerWidth;', 'window')).toEqual([
      "references the 'window' global",
    ]);
    // A bare `process.env` *is* a finding, which is the point: reading the
    // environment from a renderer-neutral module is exactly what this rule exists to
    // forbid. What the leading-character guard excludes is a *property* of the same
    // name, so `import.meta.env`-style member access is not a false positive.
    expect(globalsReferencedIn('const p = process.env;', 'process')).toEqual([
      "references the 'process' global",
    ]);
    expect(globalsReferencedIn('const e = meta.process;', 'process')).toEqual([]);
  });

  it('keeps the mirrors in the token modules, not in a renderer-shaped module', () => {
    // A mirror declared inside `src/renderers/**` would be invisible to every gate
    // that reads `src/theme/**`, and the game-engineer's host would become the only
    // source of a scale token. So: the names live here, in the neutral core.
    const tokens = readFileSync(themeFile('cozyTokens.ts'), 'utf8');
    const motion = readFileSync(themeFile('motion.ts'), 'utf8');
    for (const name of [
      'COZY_RADIUS_PX',
      'COZY_SPACE_PX',
      'COZY_BORDER_WIDTH_PX',
      'COZY_FOCUS_PX',
      'COZY_FONT_SIZE_PX',
      'COZY_LINE_HEIGHT_NUMBER',
      'COZY_FONT_WEIGHT_NUMBER',
    ]) {
      expect(tokens, `${name} is not declared in cozyTokens.ts`).toContain(
        `export const ${name}`,
      );
    }
    expect(motion).toContain('export const COZY_MOTION_EASING_CURVE');
    // And the barrel re-exports every one, because `@/theme` is the surface a host
    // imports and a name that is only reachable one module deep is a name a host
    // cannot find.
    const barrel = readFileSync(path.join(THEME_DIR, 'index.ts'), 'utf8');
    for (const name of [
      'COZY_RADIUS_PX',
      'COZY_SPACE_PX',
      'COZY_BORDER_WIDTH_PX',
      'COZY_FOCUS_PX',
      'COZY_FONT_SIZE_PX',
      'COZY_LINE_HEIGHT_NUMBER',
      'COZY_FONT_WEIGHT_NUMBER',
      'COZY_MOTION_EASING_CURVE',
      'COZY_MOTION_UNKNOWN_VALUE',
    ]) {
      expect(barrel, `${name} is not re-exported from @/theme`).toContain(name);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The same numbers, in a realm with no DOM, no React, and no renderer          */
/* -------------------------------------------------------------------------- */

interface NumericReport {
  readonly schemaVersion: string;
  readonly mirrors: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly mirrorTypes: Readonly<Record<string, string>>;
  readonly stringTables: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly touchTarget: number;
  readonly panel: Readonly<Record<string, number>>;
  readonly label: Readonly<Record<string, number>>;
  readonly tint: number;
  readonly easingStrings: Readonly<Record<string, string>>;
  readonly easingCurves: Readonly<Record<string, readonly number[]>>;
  readonly durationTable: Readonly<Record<string, number>>;
  readonly fullDurations: Readonly<Record<string, number>>;
  readonly reducedDurations: Readonly<Record<string, number>>;
  readonly unknownDurationMs: Readonly<Record<string, number>>;
  readonly unknownReducedDurationMs: Readonly<Record<string, number>>;
  readonly unknownTravelPx: Readonly<Record<string, number>>;
  readonly unknownNameTypes: Readonly<Record<string, string>>;
  readonly unknownValue: number;
  readonly profileFrozen: boolean;
  readonly profileIdentityStable: boolean;
  readonly reducedIdentityStable: boolean;
  readonly mirrorFrozen: boolean;
  readonly easingFrozen: boolean;
  readonly easingTupleFrozen: boolean;
}

describe('a host reads the numbers with no DOM, no React, and no renderer', () => {
  let scratch = '';
  let stdout = '';
  let report: NumericReport;
  let bundleModules: readonly string[] = [];

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'kd-phase9-numeric-'));
    // A synthetic entry re-exporting the barrel, written *outside* the repository so
    // nothing this gate creates can be mistaken for a source change.
    const entryPath = path.join(scratch, 'theme-entry.mjs');
    await writeFile(
      entryPath,
      `export * from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'theme', 'index.ts'))};\n`,
      'utf8',
    );
    // `platform: 'neutral'` forbids a Node- or browser-specific default, so a `node:`
    // import or a `window` reference inside the theme graph fails the build here
    // rather than at runtime in a browser.
    const build = await rolldown({ input: entryPath, platform: 'neutral', treeshake: true });
    const { output } = await build.generate({ format: 'esm' });
    await build.close();
    const chunk = output[0];
    const outFile = path.join(scratch, 'theme-numeric.mjs');
    await writeFile(outFile, chunk.code, 'utf8');
    bundleModules = Object.keys(chunk.modules ?? {})
      .map((name) => name.replace(`${REPO_ROOT}/`, ''))
      .sort();
    stdout = execFileSync(process.execPath, [PROBE_PATH, outFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
    report = JSON.parse(stdout) as NumericReport;
  }, 60_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('bundles the barrel on its own, adding no module to the token graph', () => {
    expect(bundleModules.length).toBeGreaterThan(0);
    for (const name of bundleModules) {
      if (name.endsWith('theme-entry.mjs')) continue;
      expect(name, `${name} leaked into the theme bundle`).toMatch(
        /^(src\/theme\/[\w-]+\.ts$|src\/config\/runtimeConfig\.ts$)/,
      );
    }
    // The new module is in the bundle, which is what "a host can import it" means.
    expect(bundleModules).toContain('src/theme/cozyNumbers.ts');
    // And no renderer rode along with it.
    expect(bundleModules.some((name) => name.includes('pixi'))).toBe(false);
    expect(bundleModules.some((name) => name.includes('phaser'))).toBe(false);
    expect(bundleModules.some((name) => name.includes('react'))).toBe(false);
  });

  it('reports nothing that depends on where the checkout lives', () => {
    // The hermeticity control. If the probe ever echoed a path - a module name, a
    // temp directory, a stack trace - this fails here, in every checkout, rather
    // than passing in the author's tree and failing in a reviewer's.
    expect(stdout).not.toContain(REPO_ROOT);
    expect(stdout).not.toContain(path.basename(REPO_ROOT));
    expect(stdout).not.toContain(scratch);
    expect(stdout).not.toContain('node_modules');
    expect(stdout.trim().startsWith('{')).toBe(true);
  });

  it('hands a host every scale family as a number, with no CSS-unit parsing', () => {
    // Seven families, seven numbers. The record is read whole rather than sampled, so
    // a token that came back as a string anywhere fails here.
    for (const [family, values] of Object.entries(report.mirrors)) {
      expect(Object.keys(values).length, `${family} is empty`).toBeGreaterThan(0);
      for (const [name, value] of Object.entries(values)) {
        expect(typeof value, `${family}.${name} is ${typeof value}`).toBe('number');
        expect(Number.isFinite(value), `${family}.${name} is not finite`).toBe(true);
        // And each one is the number its string table holds - the derivation holds in
        // the DOM-free realm too, not only in the jsdom suite.
        expect(value, `${family}.${name}`).toBe(
          Number.parseFloat(report.stringTables[family][name]),
        );
      }
    }
    for (const [family, type] of Object.entries(report.mirrorTypes)) {
      expect(type, `${family} is ${type}`).toBe('number');
    }
  });

  it('gives a shape and a label their geometry and typography, unparsed', () => {
    // A `roundRect` and a `TextStyle` built from these values, in the order a host
    // would build them. Phase 8's probe produced the same numbers by calling
    // `parseFloat` on six CSS strings; there is no parse here at all.
    expect(report.panel).toEqual({ width: 48, height: 40, radius: 18, borderWidth: 3, focusRingWidth: 3 });
    expect(report.label).toEqual({ fontSize: 16, fontWeight: 700, lineHeight: 1.5 });
    expect(Number.isInteger(report.tint)).toBe(true);
    expect(report.tint).toBeGreaterThan(0);
    expect(report.touchTarget).toBe(44);
    expect(report.schemaVersion).toBe('1.0.0');
  });

  it('hands a tween the same easing curve the stylesheet uses', () => {
    expect(Object.keys(report.easingCurves).sort()).toEqual(
      Object.keys(report.easingStrings).sort(),
    );
    for (const [name, curve] of Object.entries(report.easingCurves)) {
      expect(curve, `${name} length`).toHaveLength(4);
      for (const point of curve) expect(Number.isFinite(point), `${name}`).toBe(true);
      // The reverse check, in the realm that matters: the tuple renders back to the
      // exact CSS string the token table holds.
      expect(`cubic-bezier(${curve.map((point) => String(point)).join(', ')})`, name).toBe(
        report.easingStrings[name],
      );
    }
    expect(report.easingCurves.standard).toEqual([0.2, 0, 0, 1]);
  });

  it('answers an unknown motion name with zero seconds, not NaN', () => {
    expect(report.unknownValue).toBe(0);
    for (const [name, value] of Object.entries(report.unknownDurationMs)) {
      expect(value, `full profile, ${name}`).toBe(0);
      expect(value / 1000, `full profile, ${name} in seconds`).toBe(0);
      expect(Number.isNaN(value), `full profile, ${name} is NaN`).toBe(false);
    }
    for (const [name, value] of Object.entries(report.unknownReducedDurationMs)) {
      expect(value, `reduced profile, ${name}`).toBe(0);
    }
    for (const [name, value] of Object.entries(report.unknownTravelPx)) {
      expect(value, `travel, ${name}`).toBe(0);
    }
    for (const [name, type] of Object.entries(report.unknownNameTypes)) {
      expect(type, `${name} resolved to ${type}`).toBe('number');
    }
    // And the declared names are untouched in the same realm, so the fallback did not
    // replace a table with zeros.
    expect(report.fullDurations).toEqual(report.durationTable);
    expect(report.reducedDurations).toEqual(
      Object.fromEntries(Object.keys(report.durationTable).map((name) => [name, 0])),
    );
  });

  it('hands over frozen singletons, so a per-frame read still costs nothing', () => {
    expect(report.profileFrozen).toBe(true);
    expect(report.profileIdentityStable).toBe(true);
    expect(report.reducedIdentityStable).toBe(true);
    expect(report.mirrorFrozen).toBe(true);
    expect(report.easingFrozen).toBe(true);
    expect(report.easingTupleFrozen).toBe(true);
  });
});
