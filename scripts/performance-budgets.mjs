#!/usr/bin/env node
/**
 * The shared, Node-loadable declarations the Phase 22 performance gates read.
 *
 * ## Why this file exists rather than the numbers living beside their gates
 *
 * Plan section 10.2 sets one number per artefact property, and every gate that
 * enforces a number has to read the *same* declaration or the repository has two
 * sources of truth that can disagree. The byte limits themselves stay with the gate
 * that first owned them - `LAZY_CHUNK_GZIP_BYTES` in `scripts/check-memory.mjs` and
 * `TOTAL_DIST_RAW_BYTES` in `scripts/check-bundle-size.mjs` - so the existing Phase 9
 * and Phase 8 wiring tests, which read those scripts' own source, keep passing
 * unchanged. What lives here is the small amount of *shared vocabulary* that a second
 * gate would otherwise have to invent a second time:
 *
 * - the census sidecar's file name and schema version, so the build that writes it
 *   and the gate that reads it cannot drift;
 * - the gzip level, so the two measurements are comparable by hand;
 * - the offline static shell's declared files, so the offline boundary has one
 *   definition rather than one per reader.
 *
 * This module is plain ESM with no imports and no dependency, so both `node` (which
 * runs `scripts/check-performance.mjs` on the supported Node in CI) and the Vite config loader
 * (which bundles `vite.config.ts` for the build) can consume it. It is deliberately
 * not TypeScript: `vite.config.ts` is compiled by esbuild, but the gate is run by a
 * bare `node`, and a `.ts` file would not be loadable there without a dependency the
 * repository does not have.
 *
 * Privacy: this file names build output only. It contains no learner data and no
 * subject, note, attachment, progression, statistic, preference, or assistance value.
 */

/**
 * The census sidecar the renderer-boundary build plugin writes beside the bundle.
 *
 * Same directory as `index.html`, so it travels with the uploaded artifact and a
 * consuming job reads the census that describes the bytes it is actually serving.
 */
export const BUNDLE_CENSUS_FILENAME = 'bundle-census.json';

/**
 * Bumped when the census shape changes incompatibly.
 *
 * A gate that reads a census it does not understand must fail rather than interpret
 * it optimistically: `scripts/check-performance.mjs` treats any other value as a
 * finding.
 */
export const BUNDLE_CENSUS_SCHEMA_VERSION = 1;

/** gzip level 9, stated rather than defaulted, so a number is reproducible by hand. */
export const GZIP_LEVEL = 9;

/**
 * The offline static shell's files, which form the Phase 22 `offline` boundary.
 *
 * Not emitted into the module bundle - the offline plugin generates them after
 * `writeBundle` - so the census cannot describe them and the gate reads their
 * presence from `dist` directly. They are listed once here so the default build
 * (where they are absent) and the offline-flagged build (where they are measured)
 * agree about what the boundary is.
 */
export const OFFLINE_SHELL_BOUNDARY_FILES = Object.freeze([
  'sw.js',
  'offline-shell-manifest.js',
  'manifest.webmanifest',
]);
