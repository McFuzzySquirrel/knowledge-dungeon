/**
 * Phase 7 verifier: a first-party module-closure walker, written independently.
 *
 * ## Why not the implementers' walker
 *
 * `tests/data/support/importGraph.ts` classifies an edge into five kinds so it can pin
 * "no eager edge". A gate whose conclusion is "the product cannot reach the ZIP codec"
 * should not rest on the same helper the product's own boundary gate rests on: a shared
 * resolver that mis-parses one import shape makes both gates agree for the same wrong
 * reason. So this walker is deliberately **liberal** - it treats every textual mention of
 * a module specifier as an edge, including `require`, `import()`, and type-position
 * `import()` - because a superset walk can only ever find *more* edges, and "no path to
 * fflate" is the claim being made.
 *
 * The trade is stated rather than hidden: a liberal walk will report an edge that a
 * precise walk would not, so a *found* path is not proof of a real runtime edge. Every
 * conclusion this file draws is a **negative** one, which is the direction a superset
 * walk is valid for.
 *
 * Phase: 7.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = process.cwd();

/** Replace every comment with spaces, preserving offsets, so a specifier in prose is not an edge. */
export function blankComments(source: string): string {
  const out = source.split('');
  let index = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (index < source.length) {
    const character = source[index] as string;
    const next = source[index + 1];
    if (mode === 'code') {
      if (character === '/' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        mode = 'line';
        index += 2;
        continue;
      }
      if (character === '/' && next === '*') {
        out[index] = ' ';
        out[index + 1] = ' ';
        mode = 'block';
        index += 2;
        continue;
      }
      if (character === "'") mode = 'single';
      else if (character === '"') mode = 'double';
      else if (character === '`') mode = 'template';
    } else if (mode === 'line') {
      if (character === '\n') mode = 'code';
      else out[index] = ' ';
    } else if (mode === 'block') {
      if (character === '*' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        mode = 'code';
        index += 2;
        continue;
      }
      if (character !== '\n') out[index] = ' ';
    } else if (mode === 'single' || mode === 'double') {
      if (character === '\\') {
        out[index] = ' ';
        if (next !== undefined) out[index + 1] = ' ';
        index += 2;
        continue;
      }
      if ((mode === 'single' && character === "'") || (mode === 'double' && character === '"')) mode = 'code';
    } else if (mode === 'template') {
      if (character === '\\') {
        out[index] = ' ';
        if (next !== undefined) out[index + 1] = ' ';
        index += 2;
        continue;
      }
      if (character === '`') mode = 'code';
    }
    index += 1;
  }
  return out.join('');
}

/** Every module specifier named in a file, liberally. */
export function specifiersIn(source: string): string[] {
  const code = blankComments(source);
  const found = new Set<string>();
  const pattern = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match = pattern.exec(code);
  while (match !== null) {
    found.add(match[1] as string);
    match = pattern.exec(code);
  }
  return [...found];
}

/** Every `.ts` / `.tsx` file under a directory, recursively, sorted. */
export function sourceFilesUnder(absoluteDirectory: string): string[] {
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else if (/\.tsx?$/.test(entry)) out.push(absolute);
    }
  };
  visit(absoluteDirectory);
  return out;
}

function resolveFirstParty(fromAbsolute: string, specifier: string): string | null {
  if (!specifier.startsWith('@/') && !specifier.startsWith('.')) return null;
  const base = specifier.startsWith('@/')
    ? join(REPO_ROOT, 'src', specifier.slice(2))
    : resolve(dirname(fromAbsolute), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export interface Closure {
  /** Repo-relative first-party paths, sorted. */
  readonly paths: string[];
  /** Bare specifiers that are not first-party, sorted. */
  readonly externals: readonly string[];
}

export function repoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split('\\').join('/');
}

/** The transitive first-party closure of an entry, plus the bare specifiers it names. */
export function closureOf(entryRepoRelative: string): Closure {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [join(REPO_ROOT, entryRepoRelative)];
  while (queue.length > 0) {
    const absolute = queue.pop() as string;
    if (seen.has(absolute)) continue;
    if (!existsSync(absolute)) continue;
    seen.add(absolute);
    for (const specifier of specifiersIn(readFileSync(absolute, 'utf8'))) {
      const target = resolveFirstParty(absolute, specifier);
      if (target === null) {
        externals.add(specifier);
        continue;
      }
      queue.push(target);
    }
  }
  return { paths: [...seen].map(repoRelative).sort(), externals: [...externals].sort() };
}

/** A first-party closure over a set of synthetic sources, for a deliberate violation. */
export function closureOfSources(sources: ReadonlyMap<string, string>, entry: string): Closure {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    const source = sources.get(current);
    if (source === undefined) continue;
    seen.add(current);
    const absolute = join(REPO_ROOT, current);
    for (const specifier of specifiersIn(source)) {
      const target = resolveFirstParty(absolute, specifier);
      if (target === null) {
        externals.add(specifier);
        continue;
      }
      queue.push(repoRelative(target));
    }
  }
  return { paths: [...seen].sort(), externals: [...externals].sort() };
}
