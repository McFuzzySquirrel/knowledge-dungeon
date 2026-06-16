#!/usr/bin/env node
/**
 * Lightweight bundle-size guard for the web build.
 * Fails if any chunk exceeds MAX_CHUNK_BYTES or the total dist exceeds MAX_TOTAL_BYTES.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const MAX_CHUNK_BYTES = 2_500_000; // 2.5 MB per chunk
const MAX_TOTAL_BYTES = 12_000_000; // 12 MB total

async function walk(dir) {
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

try {
  const files = await walk(DIST_DIR);
  let total = 0;
  const oversized = [];

  for (const file of files) {
    const info = await stat(file);
    total += info.size;
    if (info.size > MAX_CHUNK_BYTES && /\.(js|css)$/.test(file)) {
      oversized.push({ file: path.relative(DIST_DIR, file), size: info.size });
    }
  }

  console.log(
    `Total dist size: ${(total / 1024 / 1024).toFixed(2)} MB across ${files.length} files`,
  );

  if (oversized.length > 0) {
    console.error('Oversized chunks detected:');
    for (const o of oversized) {
      console.error(`  ${o.file}: ${(o.size / 1024 / 1024).toFixed(2)} MB`);
    }
    process.exit(1);
  }

  if (total > MAX_TOTAL_BYTES) {
    console.error(`Total bundle size ${total} exceeds limit ${MAX_TOTAL_BYTES}`);
    process.exit(1);
  }
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.warn('dist/ directory missing - run "npm run build:web" first.');
    process.exit(0);
  }
  throw error;
}
