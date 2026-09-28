/**
 * Bundles the *public* theme barrel - `src/theme/index.ts` - into a single flat
 * ESM chunk, so a Phase 9 PixiJS host can be simulated for real rather than
 * described in prose.
 *
 * Why the barrel and not the token core: `support/tokenCoreBundle.ts` bundles
 * six named modules and asserts the closure is token-core-only. That proves the
 * token core is clean, but it is not what a host imports. A Pixi host writes
 * `import { resolveCozyColors, cozyHexToNumber } from '@/theme'`, so the barrel
 * is the import surface whose neutrality actually matters: it re-exports
 * `icons.ts` and `legacyThemeMap.ts` and `cozyCss.ts` as well, and any of those
 * could have acquired a DOM or renderer import without the token-core bundle
 * noticing.
 *
 * The same two problems the token-core bundle solves apply here, and are solved
 * the same way, deliberately, so the two helpers stay comparable:
 *
 * 1. `src/theme/index.ts` uses extensionless relative imports and TypeScript
 *    type-only exports, which Node's ESM resolver rejects. Rolldown - already
 *    present as Vite's bundler - resolves and transpiles them exactly as the
 *    application build does, so this adds no dependency.
 * 2. The probe that consumes the result needs one flat namespace, so the
 *    barrel is emitted as a single chunk.
 *
 * `platform: 'neutral'` is the load-bearing option: it forbids a Node- or
 * browser-specific default, so a `node:` import or a `window` reference inside
 * the theme graph fails the *build* here rather than at runtime in a browser.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { rolldown } from 'rolldown';

/** The import surface a Phase 9 PixiJS host is expected to use. */
export const THEME_BARREL_ENTRY = 'src/theme/index.ts';

/**
 * Every module the barrel is allowed to pull in, as a repository-relative path.
 *
 * `src/config/runtimeConfig.ts` is here because `cozyScope.ts` reads
 * `RUNTIME_FLAG_ENV_KEYS` from it to name the Cozy build flag. That module is
 * pure string data plus a pure parse function - it never reads
 * `import.meta.env` - which is why a renderer may depend on it. If that changes,
 * this list is the place that fails.
 */
export const ALLOWED_BARREL_MODULES = [
  /^src\/theme\/[\w-]+\.ts$/,
  /^src\/config\/runtimeConfig\.ts$/,
] as const;

export interface ThemeBarrelBundle {
  /** Absolute path of the emitted chunk. */
  readonly outFile: string;
  /** Size of the emitted chunk in bytes. */
  readonly bytes: number;
  /** Repository-relative module paths in the chunk, sorted. */
  readonly modules: readonly string[];
}

/** Create a scratch directory. The caller owns its lifetime. */
export function createScratchDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Remove a scratch directory, ignoring a missing one. */
export function removeScratchDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true });
}

/**
 * Bundle the theme barrel and write one chunk to `<dir>/theme-barrel.mjs`.
 *
 * @param repoRoot Absolute repository root.
 * @param dir Directory to write into; the caller owns its lifetime.
 */
export async function bundleThemeBarrel(
  repoRoot: string,
  dir: string,
): Promise<ThemeBarrelBundle> {
  const entryPath = path.join(dir, 'theme-barrel-entry.mjs');
  await writeFile(entryPath, `export * from ${JSON.stringify(`${repoRoot}/${THEME_BARREL_ENTRY}`)};`, 'utf8');

  const build = await rolldown({
    input: entryPath,
    platform: 'neutral',
    treeshake: true,
  });
  const { output } = await build.generate({ format: 'esm' });
  await build.close();

  const chunk = output[0];
  const outFile = path.join(dir, 'theme-barrel.mjs');
  await writeFile(outFile, chunk.code, 'utf8');

  const modules = Object.keys(chunk.modules ?? {})
    .map((name) => name.replace(`${repoRoot}/`, ''))
    .sort();

  return { outFile, bytes: Buffer.byteLength(chunk.code, 'utf8'), modules };
}
