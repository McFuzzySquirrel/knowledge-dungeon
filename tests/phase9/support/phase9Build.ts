/**
 * Shared fixtures for the Phase 9 gates.
 *
 * Everything here is synthetic and lives outside the repository, on purpose. Two
 * defects reached review in Phase 8 for depending on state a clean checkout does not
 * have - one test baselined against `git show HEAD:...`, another only ever ran from a
 * tree under `/tmp` - and `tests/phase8/qa-hermeticity.test.ts` is the guard written
 * afterwards. Nothing in this directory reads the checkout's history, reads the
 * checkout's `dist/`, or depends on where the checkout lives on disk: a synthetic
 * `dist` is built in a temp directory and the committed scripts are invoked against
 * it with an explicit path.
 *
 * Privacy: no learner data, no subject, note, attachment, progression, statistic, or
 * preference appears in any fixture, and no fixture is ever written inside the
 * repository.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { gzipSync } from 'node:zlib';

export const REPO_ROOT = process.cwd();

/** Scratch roots created during a run, removed by `cleanupScratch()`. */
const SCRATCH_ROOTS: string[] = [];

/** A fresh empty directory outside the repository. */
export function scratch(prefix = 'kd-phase9-'): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  SCRATCH_ROOTS.push(root);
  return root;
}

/** Removes every scratch root this module created. Call from `afterAll`. */
export function cleanupScratch(): void {
  for (const root of SCRATCH_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * Deterministic, incompressible bytes.
 *
 * A seeded generator rather than `Math.random`, because gzip output is the number
 * this gate reports and an irreproducible fixture would make an irreproducible
 * measurement. SHA-256 in counter mode rather than an LCG: a linear congruential
 * generator's low byte has a short period, so a 900 000-byte "random" buffer from one
 * gzipped to under 4 KiB and the size ceiling silently stopped binding. The control
 * in `memory-preflight.test.ts` measures the ratio so that cannot happen again.
 */
export function incompressible(byteLength: number, seed = 1): Buffer {
  const blocks: Buffer[] = [];
  let produced = 0;
  for (let counter = 0; produced < byteLength; counter += 1) {
    const block = createHash('sha256').update(`${seed}:${counter}`).digest();
    blocks.push(block);
    produced += block.length;
  }
  return Buffer.concat(blocks).subarray(0, byteLength);
}

/** Compressible filler, for a fixture that should land well under a size ceiling. */
export function filler(byteLength: number): Buffer {
  return Buffer.from('a'.repeat(byteLength), 'utf8');
}

/** gzip level 9, matching both committed build gates. */
export function gzipSize(bytes: Buffer): number {
  return gzipSync(bytes, { level: 9 }).length;
}

export interface GateRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

/**
 * Runs a committed script with `process.execPath`.
 *
 * `cwd` defaults to the repository root so a caller has to be explicit about
 * changing it, which is what makes a location-dependent assertion visible instead of
 * accidental.
 */
export function runNode(scriptPath: string, args: readonly string[], cwd = REPO_ROOT): GateRun {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

/** Reads a repository-relative file as text. */
export function sourceOf(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, ...relativePath.split('/')), 'utf8');
}

export interface DocumentReferences {
  readonly modules?: readonly string[];
  readonly modulepreloads?: readonly string[];
  readonly styles?: readonly string[];
  readonly nomodules?: readonly string[];
  /** A `src`/`href` that names a file the build will not contain. */
  readonly dangling?: readonly string[];
  /** A `src`/`href` that points at an absolute `https:` URL. */
  readonly remote?: readonly string[];
}

/** An entry document with exactly the references the fixture declares. */
export function entryHtml(references: DocumentReferences): string {
  const lines: string[] = ['<!doctype html>', '<html lang="en"><head>'];
  for (const href of references.styles ?? []) {
    lines.push(`<link rel="stylesheet" crossorigin href="/assets/${href}">`);
  }
  for (const href of references.modulepreloads ?? []) {
    lines.push(`<link rel="modulepreload" crossorigin href="/assets/${href}">`);
  }
  lines.push('</head><body>');
  for (const src of references.modules ?? []) {
    lines.push(`<script type="module" crossorigin src="/assets/${src}"></script>`);
  }
  for (const src of references.nomodules ?? []) {
    lines.push(`<script nomodule crossorigin src="/assets/${src}"></script>`);
  }
  for (const src of references.dangling ?? []) {
    lines.push(`<script type="module" crossorigin src="/assets/${src}"></script>`);
  }
  for (const href of references.remote ?? []) {
    lines.push(`<link rel="modulepreload" crossorigin href="${href}">`);
  }
  lines.push('</body></html>');
  return `${lines.join('\n')}\n`;
}

/** Writes an entry document plus asset files into a fresh temp `dist`. */
export function writeSyntheticDist(
  references: DocumentReferences,
  assets: Readonly<Record<string, Buffer | string>>,
  distName = 'dist',
): string {
  const dist = path.join(scratch(), distName);
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), entryHtml(references), 'utf8');
  for (const [name, content] of Object.entries(assets)) {
    writeFileSync(path.join(dist, 'assets', name), content);
  }
  return dist;
}

/* ========================================================================== */
/* Workflow parsing, the way the Phase 8 wiring gates do it                     */
/* ========================================================================== */

/** Splits a workflow into job blocks keyed by job id. */
export function parseWorkflowJobs(text: string): ReadonlyMap<string, string> {
  const lines = text.split('\n');
  const jobsIndex = lines.indexOf('jobs:');
  if (jobsIndex === -1) throw new Error('Workflow has no jobs: section.');

  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current)?.push(line);
  }

  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

/** The text of the single step in `jobBody` named `stepName`. */
export function stepBlockFor(jobBody: string, stepName: string): string {
  const index = jobBody.indexOf(`name: ${stepName}`);
  if (index === -1) throw new Error(`The job has no step named ${stepName}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

/* ========================================================================== */
/* Source scanning                                                             */
/* ========================================================================== */

/**
 * Removes comments so a test may explain a rule without tripping the scan that
 * applies it.
 *
 * A `//` is a comment only when it starts a line or follows whitespace, which is what
 * keeps `//cdn.example.invalid/a.js` and `https://...` inside string literals intact.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}
