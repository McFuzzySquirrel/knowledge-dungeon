/**
 * Reads the effective build-time flag out of a served web artifact.
 *
 * ## Why the browser lanes need this
 *
 * `VITE_PIXI_DUNGEON`, `VITE_PIXI_VILLAGE`, `VITE_PIXI_FISHING`, and
 * `VITE_WORLD_RENDERER` are build-time flags: `vite.config.ts` bakes each one's
 * *effective* value into the emitted `import.meta.env` literal, so the artifact knows
 * what it was built as. Before the Phase 23 cutover the browser lanes inferred it from
 * `process.env.VITE_PIXI_*`, which the build script happened to export for a flagged
 * build. After the cutover the *default* build has every per-world flag on without any
 * environment variable being set, so `process.env` no longer describes the artifact at
 * all - it would report "Phaser" for a build whose dungeon is Pixi.
 *
 * This reads the compiled constant from the artifact's own module bundle, the same
 * source-of-truth `scripts/require-assistance-lane-artifact.mjs` uses for the assistance
 * flag: the bytes that will be served, not the shell that asked for them. A lane that
 * said "this build was asked for X" while pointed at a build that contains Y now fails
 * instead of describing a different artifact.
 *
 * ## Shape it matches
 *
 * Vite replaces `import.meta.env` with an object literal carrying the environment keys
 * the build actually had, e.g. `VITE_PIXI_DUNGEON:"true"`. The minifier's string quoting
 * is not a contract this repository controls, so the pattern is quote-agnostic. The ES5
 * `-legacy-` re-emission is skipped: no engine in the plan's matrix executes it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** The compiled value of `envKey` in `distDir`'s module bundle, or `null` if absent. */
export function readCompiledFlag(distDir: string, envKey: string): string | null {
  const assetsDir = path.join(distDir, 'assets');
  let names: readonly string[];
  try {
    names = readdirSync(assetsDir);
  } catch {
    return null;
  }
  const pattern = new RegExp(`${envKey}\\s*:\\s*(["'\`])([^"'\`]+?)\\1`);
  for (const name of [...names].sort()) {
    if (!name.endsWith('.js') || name.includes('-legacy-')) continue;
    const match = pattern.exec(readFileSync(path.join(assetsDir, name), 'utf8'));
    if (match !== null) return match[2];
  }
  return null;
}

/** Whether `envKey` compiled to `"true"` in `distDir`'s module bundle. */
export function readCompiledBooleanFlag(distDir: string, envKey: string): boolean {
  return readCompiledFlag(distDir, envKey) === 'true';
}

/** The `dist/` a preview serves for this repository, from the lane's working directory. */
export function defaultDistDir(): string {
  return path.resolve(process.cwd(), 'dist');
}
