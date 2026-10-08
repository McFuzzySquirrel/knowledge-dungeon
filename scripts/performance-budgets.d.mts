/**
 * Type declarations for `scripts/performance-budgets.mjs`.
 *
 * `vite.config.ts` imports the census file name, schema version, gzip level, and
 * offline-shell file list from the plain ESM module so the build and the gate share
 * one declaration. TypeScript needs this declaration file to typecheck that import;
 * the module has no runtime types of its own. Mirrors the `check-memory.d.mts`
 * pattern: the declarations are the module's real exports and nothing else.
 *
 * This file has no runtime content and is not part of any bundle.
 */

/** The census sidecar the renderer-boundary build plugin writes beside the bundle. */
export const BUNDLE_CENSUS_FILENAME: string;

/** Bumped when the census shape changes incompatibly. */
export const BUNDLE_CENSUS_SCHEMA_VERSION: number;

/** gzip level 9, stated rather than defaulted, so a number is reproducible by hand. */
export const GZIP_LEVEL: number;

/** The offline static shell's files, which form the Phase 22 `offline` boundary. */
export const OFFLINE_SHELL_BOUNDARY_FILES: readonly string[];
