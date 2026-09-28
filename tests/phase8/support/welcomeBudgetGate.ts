/**
 * Test support for the Welcome budget gate.
 *
 * The gate is a CLI, so it is tested as one: every case is a real
 * `node scripts/check-welcome-budget.mjs` run against a throwaway `dist` tree, and
 * every assertion is about the process exit code and the report it printed. That is
 * deliberate. A test that reimplemented the budget arithmetic in TypeScript would keep
 * passing while the script CI actually runs computed something else, which is exactly
 * the failure a wiring gate exists to prevent.
 *
 * Why a synthetic tree and not the real `dist`
 * --------------------------------------------
 * The real `dist` exists only after a build, and a test suite that needs one fails on a
 * clean checkout - at which point a failing suite is indistinguishable from a real
 * regression, and the budget gate reads as broken before it has ever run. So each case
 * writes its own `index.html` and its own asset files into a temporary directory and
 * points the script at it with `--dist`. The real `dist` is measured by
 * `npm run check:budget:welcome` in CI, where a build already exists by construction.
 *
 * Privacy: the fixtures are filler bytes in a temporary directory. Nothing here reads,
 * copies, or reproduces learner data, and no subject, note, attachment, progression,
 * statistic, or preference is read or named. Nothing is written inside the repository.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = process.cwd();
export const ENFORCER = path.join(REPO_ROOT, 'scripts', 'check-welcome-budget.mjs');

/** The only place the budget lives. Asserted here and in the wiring gate, once each. */
export const WELCOME_BUDGET_BYTES = 300 * 1024;
export const WELCOME_BUDGET_KIB = 300;

export interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Everything the process printed, in the order a reader would see it. */
  output: string;
}

export interface DistOptions {
  /** `src` values for `<script type="module">` tags. */
  module?: readonly string[];
  /** `href` values for `<link rel="modulepreload">` tags. */
  preloads?: readonly string[];
  /** `href` values for `<link rel="stylesheet">` tags. */
  styles?: readonly string[];
  /** `src` values for `<script nomodule>` tags - the ES5 fallback. */
  legacy?: readonly string[];
  /** Extra tags appended verbatim, for the cases that need an unusual document. */
  extraHead?: readonly string[];
  /** An inline module script, as Vite emits. On by default. */
  inline?: boolean;
}

export interface SyntheticDist {
  root: string;
  distDir: string;
  run(): GateResult;
  cleanup(): void;
}

/** Renders an entry document shaped like the one Vite emits. */
export function entryHtml(options: DistOptions = {}): string {
  const module = (options.module ?? []).map(
    (src) => `    <script type="module" crossorigin src="${src}"></script>`,
  );
  const preloads = (options.preloads ?? []).map(
    (href) => `    <link rel="modulepreload" crossorigin href="${href}">`,
  );
  const styles = (options.styles ?? []).map(
    (href) => `    <link rel="stylesheet" crossorigin href="${href}">`,
  );
  const legacy = (options.legacy ?? []).map((src) => `    <script nomodule crossorigin src="${src}"></script>`);
  const inline = options.inline === false ? [] : ['    <script type="module">console.log(1)</script>'];
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    ...module,
    '    <meta charset="UTF-8" />',
    '    <link rel="icon" href="/favicon.ico">',
    ...inline,
    ...preloads,
    ...styles,
    ...legacy,
    ...(options.extraHead ?? []),
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/** Highly compressible filler, for a case that needs a file to be *small* on the wire. */
export function filler(bytes: number): string {
  return 'a'.repeat(bytes);
}

/**
 * Deterministic, high-entropy filler, for a case that needs a file to be *large* on the
 * wire.
 *
 * `filler` is the wrong tool for the over-budget cases: a run of identical characters
 * gzips to almost nothing, so a "400 KB" fixture measured a few hundred bytes and the
 * gate correctly passed it. A case can only prove the limit if it can actually reach it.
 *
 * A 32-bit LCG over a 64-character alphabet, so the fixture is reproducible - no
 * `Math.random`, no clock - while its period runs far past gzip's 32 KiB window, so it
 * does not compress. The ratio is about 0.8:1, which the cases above account for.
 */
export function incompressible(bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = 0x2f6e2b1 >>> 0;
  let out = '';
  for (let index = 0; index < bytes; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[(state >>> 24) & 63];
  }
  return out;
}

/**
 * Builds a throwaway `dist` and returns a runner for the gate against it.
 *
 * `files` maps a dist-relative path to its bytes. Any path the document references but
 * `files` does not contain is deliberately left absent, which is how the
 * "the document names a file the build lacks" case is provoked.
 */
export function makeDist(options: DistOptions = {}, files: Record<string, string> = {}): SyntheticDist {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kd-welcome-budget-'));
  const distDir = path.join(root, 'dist');

  writeFileSync(path.join(root, 'placeholder'), 'not a dist', 'utf8');
  mkdirSync(distDir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(distDir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  writeFileSync(path.join(distDir, 'index.html'), entryHtml(options), 'utf8');

  return {
    root,
    distDir,
    run() {
      const result = spawnSync(process.execPath, [ENFORCER, `--dist=${distDir}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      return {
        code: result.status ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        output: `${result.stdout}${result.stderr}`,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A `dist` directory with no `index.html`, for the "nothing to measure" case. */
export function makeEmptyDist(): SyntheticDist {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kd-welcome-budget-empty-'));
  const distDir = path.join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  return {
    root,
    distDir,
    run() {
      const result = spawnSync(process.execPath, [ENFORCER, `--dist=${distDir}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      return {
        code: result.status ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        output: `${result.stdout}${result.stderr}`,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The `total counted` byte figure from a passing run, as a number. */
export function countedBytes(result: GateResult): number {
  const match = /total counted\s+[\d.]+ KiB \((\d+) bytes\)/.exec(result.output);
  if (!match) throw new Error(`No counted total in the report:\n${result.output}`);
  return Number(match[1]);
}

/** The `limit` byte figure from a run, as a number. */
export function limitBytes(result: GateResult): number {
  const match = /limit\s+[\d.]+ KiB \((\d+) bytes\)/.exec(result.output);
  if (!match) throw new Error(`No limit in the report:\n${result.output}`);
  return Number(match[1]);
}
