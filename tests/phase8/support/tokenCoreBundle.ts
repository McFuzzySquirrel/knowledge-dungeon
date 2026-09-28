/**
 * Bundles the Cozy token core into a single flat ESM chunk.
 *
 * The renderer-neutrality gate runs the token core in a plain Node process, with
 * no bundler, no Vite alias table, and no jsdom. Two problems, two answers:
 *
 * 1. **TypeScript and extensionless imports.** The repository writes
 *    `import { ... } from './cozyTokens'`, which Node's ESM resolver rejects.
 *    Rolldown - already present as Vite's bundler, so this adds no dependency -
 *    resolves and transpiles it exactly as the app build does.
 * 2. **One flat namespace.** The gate's probe imports the result as a single
 *    module, so the entry list is re-exported through a synthetic entry module
 *    rather than emitted as separate chunks with a shared-chunk name.
 *
 * Bundling is also the stronger claim of the two. The token core must be a
 * *standalone build target* for a PixiJS host or a worker, not merely a set of
 * files that happen to import cleanly under Vite. `platform: 'neutral'` keeps the
 * output free of a Node- or browser-specific default, and a `node:`-only import
 * inside the token core therefore fails the build rather than a runtime.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { rolldown } from 'rolldown';

/** The token core. Every entry must be renderer-neutral. */
export const TOKEN_CORE_ENTRIES = [
  'cozyColor.ts',
  'cozyCss.ts',
  'cozyTokens.ts',
  'motion.ts',
  'typography.ts',
  'legacyThemeMap.ts',
];

export interface TokenCoreBundle {
  readonly outFile: string;
  readonly bytes: number;
  readonly modules: readonly string[];
}

/**
 * Bundle the token core and write one chunk to `<dir>/token-core.mjs`.
 *
 * @param repoRoot Absolute repository root.
 * @param dir Directory to write into; the caller owns its lifetime.
 */
export async function bundleTokenCore(repoRoot: string, dir: string): Promise<TokenCoreBundle> {
  const entryPath = path.join(dir, 'token-core-entry.mjs');
  await writeFile(
    entryPath,
    TOKEN_CORE_ENTRIES.map(
      (name) => `export * from ${JSON.stringify(`${repoRoot}/src/theme/${name}`)};`,
    ).join('\n'),
    'utf8',
  );

  const build = await rolldown({
    input: entryPath,
    platform: 'neutral',
    treeshake: true,
  });
  const { output } = await build.generate({ format: 'esm' });
  await build.close();

  const chunk = output[0];
  const outFile = path.join(dir, 'token-core.mjs');
  await writeFile(outFile, chunk.code, 'utf8');

  const modules = Object.keys(chunk.modules ?? {})
    .map((name) => name.replace(`${repoRoot}/`, ''))
    .sort();

  return { outFile, bytes: Buffer.byteLength(chunk.code, 'utf8'), modules };
}

/** Create a scratch directory for the gate. */
export function createScratchDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Remove a scratch directory, ignoring a missing one. */
export function removeScratchDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}
