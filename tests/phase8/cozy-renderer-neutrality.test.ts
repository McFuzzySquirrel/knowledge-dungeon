/**
 * Phase 8: the renderer-neutrality gate for the shared token module.
 *
 * The plan's global rule 8 is "Do not allow renderer imports into `src/core/` or
 * renderer-neutral application modules", and the Phase 8 deliverable is a token
 * source that React DOM and a future PixiJS host both read. A token module that
 * reached for `document`, imported React, or imported a renderer would make that
 * impossible: a worker-hosted Pixi application has no DOM, and pulling React into
 * a render bundle is a bundle-size regression.
 *
 * So the boundary is asserted rather than described. This file:
 *
 * 1. Enumerates every module declared in `RENDERER_NEUTRAL_THEME_MODULES` and
 *    fails if one is missing, or if a file sits in `src/theme/` without being
 *    classified at all - a new module cannot escape by simply not being listed.
 * 2. Walks the transitive *first-party* import graph from each declared module
 *    and fails on any import of React, ReactDOM, a renderer (Phaser, PixiJS), a
 *    DOM library, or a server-only Node built-in.
 * 3. Fails if a declared module's own source mentions a DOM global, a renderer
 *    global, or dynamic code evaluation. Reading `matchMedia` inside the token
 *    module would break the same worker case the import graph protects.
 * 4. Bundles the token core on its own and runs it in a fresh Node process with
 *    `document`, `window`, `matchMedia`, `navigator`, and `localStorage` replaced
 *    by throwing getters. jsdom installs them for every other test in the suite,
 *    so "it happened to work here" would not be evidence.
 * 5. Confirms the renderer-facing accessors return numbers, not CSS strings -
 *    the property a PixiJS host actually depends on.
 *
 * Privacy: nothing here reads learner data, network state, or a persisted
 * preference. It reads repository source and a scratch directory in the OS temp
 * folder, and it spawns a child Node process with no arguments beyond a path.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RENDERER_NEUTRAL_THEME_MODULES,
  THEME_BARREL_MODULES,
} from '@/theme/cozyTokens';
import {
  bundleTokenCore,
  createScratchDir,
  removeScratchDir,
} from './support/tokenCoreBundle';

const REPO_ROOT = process.cwd();
const THEME_DIR = path.join(REPO_ROOT, 'src', 'theme');
const PROBE_PATH = path.join(REPO_ROOT, 'tests', 'phase8', 'support', 'domFreeProbe.mjs');

/** Packages a renderer-neutral module may never import. */
const FORBIDDEN_SPECIFIERS = [
  'react',
  'react-dom',
  'phaser',
  'pixi.js',
  '@pixi/',
  'three',
  'konva',
  'fabric',
  'jquery',
  'lit',
  'zustand',
  'immer',
] as const;

/** Node built-ins that mean the module is not a worker-safe library. */
const FORBIDDEN_NODE_BUILTINS = [
  'node:fs',
  'node:path',
  'node:os',
  'node:child_process',
  'node:worker_threads',
] as const;

/** Globals that would fail in a worker or any other non-DOM context. */
const FORBIDDEN_GLOBALS = [
  'document',
  'window',
  'self',
  'navigator',
  'matchMedia',
  'HTMLElement',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
  'Phaser',
  'PIXI',
  'process',
  'eval',
] as const;

function themeFile(name: string): string {
  return path.join(THEME_DIR, name);
}

/** Import specifiers, ignoring anything inside a block or line comment. */
function importSpecifiers(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
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

function forbiddenReason(specifier: string): string | null {
  for (const forbidden of FORBIDDEN_SPECIFIERS) {
    if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
      return 'renderer or UI-framework dependency';
    }
  }
  for (const builtin of FORBIDDEN_NODE_BUILTINS) {
    if (specifier === builtin || specifier.startsWith(`${builtin}/`)) {
      return 'server-only Node built-in';
    }
  }
  if ((FORBIDDEN_GLOBALS as readonly string[]).includes(specifier)) return 'DOM global';
  return null;
}

describe('Phase 8 renderer-neutrality gate', () => {
  it('classifies every file that lives directly in src/theme', () => {
    const classified = new Set([...RENDERER_NEUTRAL_THEME_MODULES, ...THEME_BARREL_MODULES]);
    const onDisk = readdirSync(THEME_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    expect(onDisk, 'an unclassified module exists in src/theme').toEqual([...classified].sort());
    for (const name of RENDERER_NEUTRAL_THEME_MODULES) {
      expect(onDisk, `${name} is declared but missing`).toContain(name);
    }
  });

  it('imports no renderer, no React, and no DOM library, transitively', () => {
    const closure = firstPartyClosure([...RENDERER_NEUTRAL_THEME_MODULES].map(themeFile));
    expect(closure.size).toBeGreaterThanOrEqual(RENDERER_NEUTRAL_THEME_MODULES.length);

    const offenders: string[] = [];
    for (const [file, via] of closure) {
      const relative = path.relative(REPO_ROOT, file);
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const reason = forbiddenReason(specifier);
        if (reason === null) continue;
        const trail = via.length > 0 ? ` (reached via ${via.join(' -> ')})` : '';
        offenders.push(`${relative} imports '${specifier}': ${reason}${trail}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('mentions no DOM, renderer, or server global in its own source', () => {
    const offenders: string[] = [];
    for (const name of RENDERER_NEUTRAL_THEME_MODULES) {
      const code = readFileSync(themeFile(name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const forbidden of FORBIDDEN_GLOBALS) {
        // Used as a value, not merely named: no leading word character, `$`, or
        // quote, so `process.env` and a mention inside a string do not match.
        const pattern = new RegExp(`(?<![\\w$.'"\`])${escapeRegExp(forbidden)}\\b`);
        if (pattern.test(code)) offenders.push(`${name} references the '${forbidden}' global`);
      }
      if (/\bFunction\s*\(/.test(code)) offenders.push(`${name} builds a function from a string`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the token core free of Node built-ins that need a server', () => {
    const closure = firstPartyClosure([...RENDERER_NEUTRAL_THEME_MODULES].map(themeFile));
    const offenders: string[] = [];
    for (const file of closure.keys()) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        for (const builtin of FORBIDDEN_NODE_BUILTINS) {
          if (specifier === builtin || specifier.startsWith(`${builtin}/`)) {
            offenders.push(`${path.relative(REPO_ROOT, file)} imports '${specifier}'`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('bundles standalone and evaluates in a DOM-free realm', async () => {
    // Bundling is the stronger half of the claim: the token core must be a
    // standalone build target for a PixiJS host or a worker, not just a set of
    // files that happen to import cleanly under Vite.
    const scratch = await createScratchDir('kd-cozy-token-core-');
    try {
      const bundle = await bundleTokenCore(REPO_ROOT, scratch);
      expect(bundle.bytes).toBeGreaterThan(0);
      // The synthetic entry is a `export *` barrel over the token core, so the
      // bundle must contain the token modules, the config module one of them
      // reads, and nothing else - no React, no renderer, no third-party package.
      for (const name of bundle.modules) {
        if (name.endsWith('token-core-entry.mjs')) continue;
        expect(name, `${name} leaked into the token-core bundle`).toMatch(
          /^(src\/theme\/[\w-]+\.ts$|src\/config\/runtimeConfig\.ts$)/,
        );
      }

      const output = execFileSync(process.execPath, [PROBE_PATH, bundle.outFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
      const report = JSON.parse(output) as Record<string, unknown>;

      expect(report.contrast as number).toBeGreaterThan(4.5);
      expect(report.highContrast as number).toBeGreaterThanOrEqual(7);

      // Renderer-facing accessors must be numbers, not CSS strings: that is the
      // property a PixiJS host actually depends on.
      expect(Number.isInteger(report.tint)).toBe(true);
      expect(report.tint as number).toBeGreaterThan(0);
      expect(report.luminance as number).toBeGreaterThanOrEqual(0);
      expect(report.luminance as number).toBeLessThanOrEqual(1);
      expect(report.mix).toMatch(/^#[0-9a-f]{6}$/i);
      const unit = report.unit as number[];
      expect(unit).toHaveLength(4);
      for (const channel of unit) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }

      expect(report.variable).toBe('--cozy-c-surface-panel');
      expect(report.stylesheetHead).toContain('/* Document-level Cozy defaults');
      expect(report.stylesheetScoped).toBe(true);

      expect(report.reducedScale).toBe(0);
      expect(report.reducedDuration).toBe(0);
      expect(report.reducedTravel).toBe(0);
      expect(report.fullScale).toBe(1);

      expect(report.font).toContain('ui-rounded');
      expect(report.canvasFont).toContain('ui-monospace');
      expect(report.theme).toBe('cozy-parchment');
      expect(report.fallback).toBe('cozy-ink');
      expect(report.schema).toBe('1.0.0');
      expect(report.tokenCount as number).toBeGreaterThanOrEqual(24);
    } finally {
      await removeScratchDir(scratch);
    }
  });
});
