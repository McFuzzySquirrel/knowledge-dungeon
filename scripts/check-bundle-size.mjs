#!/usr/bin/env node
/**
 * Lightweight bundle-size guard for the web build.
 * Fails if any chunk exceeds MAX_CHUNK_BYTES or the total dist exceeds TOTAL_DIST_RAW_BYTES.
 *
 * The guards live in `runBundleSizeCheck`, invoked only when this file runs as a
 * program. That guard is load-bearing as of Phase 22: `scripts/check-performance.mjs`
 * imports `TOTAL_DIST_RAW_BYTES` from here so the 12 MB ceiling has one declaration,
 * and importing a module must not run a gate and exit the importing process.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.resolve(REPO_ROOT, 'dist');

export const MAX_CHUNK_BYTES = 2_500_000; // 2.5 MB per chunk

/**
 * Plan section 10.2: "Total raw `dist`: retain the current 12 MB ceiling."
 *
 * Declared once and exported so `scripts/check-performance.mjs` reads the same
 * number rather than carrying a second copy that could drift. This script remains
 * the per-chunk raw guard and the raw-total guard; `check:perf` adds the route-aware
 * gzip budgets and the same raw total, reading this declaration.
 */
export const TOTAL_DIST_RAW_BYTES = 12_000_000; // 12 MB total

export async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Runs the size guard against `distDir`.
 *
 * Returns `0` for a pass, `1` for a failed budget, and `0` with a warning when
 * `dist` is absent - the pre-build behaviour a developer relies on. Exported and
 * parameterized so an importer can call it without the process exiting.
 */
export async function runBundleSizeCheck(distDir = DIST_DIR, log = console) {
  let files;
  try {
    files = await walk(distDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      log.warn('dist/ directory missing - run "npm run build:web" first.');
      return 0;
    }
    throw error;
  }

  let total = 0;
  const oversized = [];

  for (const file of files) {
    const info = await stat(file);
    total += info.size;
    if (info.size > MAX_CHUNK_BYTES && /\.(js|css)$/.test(file)) {
      oversized.push({ file: path.relative(distDir, file), size: info.size });
    }
  }

  log.log(`Total dist size: ${(total / 1024 / 1024).toFixed(2)} MB across ${files.length} files`);

  if (oversized.length > 0) {
    log.error('Oversized chunks detected:');
    for (const o of oversized) {
      log.error(`  ${o.file}: ${(o.size / 1024 / 1024).toFixed(2)} MB`);
    }
    return 1;
  }

  if (total > TOTAL_DIST_RAW_BYTES) {
    log.error(`Total bundle size ${total} exceeds limit ${TOTAL_DIST_RAW_BYTES}`);
    return 1;
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  const status = await runBundleSizeCheck();
  // Kept as an explicit exit so the pre-build behaviour is unchanged and the
  // sibling gates' contrast assertion ("check:bundle-size exits 0 when dist is
  // absent") still describes this file's source.
  if (status === 0) {
    process.exit(0);
  }
  process.exit(status);
}
