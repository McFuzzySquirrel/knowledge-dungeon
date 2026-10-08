#!/usr/bin/env node
/**
 * The Phase 22 route-aware performance budget gate, run against a built `dist`.
 *
 * ## The requirement this exists for
 *
 * Plan section 10.2 sets three artefact-level numbers and the scope locked on
 * 2026-10-06 restated two of them as route-aware:
 *
 *   - "Any lazy JavaScript chunk: no more than 800 KB gzip."
 *   - the locked ruling: "each lazy route no more than 800 KiB cumulative gzip of its
 *     own chunk set."
 *   - "Total raw `dist`: retain the current 12 MB ceiling."
 *
 * `scripts/check-bundle-size.mjs` is a raw-byte guard that allows 2.5 MB *raw* per
 * chunk - roughly 800 KB *uncompressed* - so a lazy chunk can reach twice the plan's
 * gzip ceiling without it noticing. `scripts/check-memory.mjs` closes that gap for
 * *renderer* chunks only. A feature lane (assistance, share, offline) had no gzip
 * budget at all. This gate extends the 800 KiB ceiling to every declared lazy
 * boundary and re-checks the 12 MB raw total.
 *
 * ## "Route" is defined mechanically, and no route architecture was invented
 *
 * The repository has **no route-level code split**, and Phase 21 explicitly declined
 * one ("lazy-loading `VillageScreen`/`GameScreen` was declined as a route-loading
 * architecture decision"). So a "route" here is not a new abstraction: it is a
 * **declared lazy boundary** the artefact already has - the two renderer families
 * (`vendor-phaser-*`, `vendor-pixi-*`) and the feature lanes (assistance, share, and
 * the offline static shell). This gate does not add a split, a `React.lazy` boundary,
 * or a router.
 *
 * ## The census is reused, not re-derived
 *
 * The conventional way to answer "which chunks belong to this boundary" from an
 * artefact is to walk the emitted import graph. Doing that here would be a second
 * implementation of `vite.config.ts`'s emitter census, and the two could disagree
 * about what "statically reachable" means - the exact class of drift that census
 * removed. Instead, the renderer-boundary build plugin (`rendererChunkBoundaryPlugin`)
 * computes the boundaries **once**, with the same `auditRendererChunkBoundary`,
 * `auditFeatureLane`, `collectStaticClosure` and `collectFetchableClosure` the build
 * already enforces, and writes them beside the bundle as `bundle-census.json`. This
 * gate reads that census and measures the chunk files it names. The build states what
 * it emitted; the gate budgets it; neither re-derives the other.
 *
 * This is also why the gate is a bare `node` script with no dependency. CI's
 * `web-build` job runs **Node 20**, which cannot import the TypeScript census
 * functions, and the repository's rule is no new dependency. A JSON sidecar produced
 * by the build is the one shape that both Node 20 and the gate can agree on.
 *
 * ## What it measures, and what it reports per boundary
 *
 * For every declared boundary it sums the gzip size (level 9) of that boundary's own
 * lazy chunk set - the chunks a browser downloads to enter the boundary, excluding
 * chunks the module entry already downloads, plus the CSS the set imports - and
 * compares the sum to the 800 KiB ceiling. It prints one line per boundary, and it
 * prints an **absent** boundary as "NOT PRESENT in this build (not measured)" rather
 * than silently omitting it, so a reader can tell "measured and within budget" from
 * "absent, so not looked at". It also sums every file in `dist` and compares to the
 * 12 MB raw ceiling.
 *
 * ## No vacuous pass
 *
 * A missing `dist`, a missing or unreadable `bundle-census.json`, a census that names
 * no module entry, a census whose accounted files are gone from `dist`, a boundary
 * chunk that is named but absent, and a build with no measured lazy boundary at all
 * are each a **failure with the command to run**, never a warning-and-exit-0. That is
 * the house rule `scripts/check-welcome-budget.mjs` and `scripts/check-memory.mjs`
 * follow, and `scripts/check-bundle-size.mjs` deliberately does not (it is a
 * pre-build convenience).
 *
 * ## What this gate cannot prove, and does not claim
 *
 * Plan section 10.2's interaction acknowledgement under 100 ms and its p95 frame time
 * under 20 ms are **runtime** measurements. They cannot be read out of a directory of
 * files, and this gate prints that on every run rather than approximating them with a
 * byte count. The browser lane owns them.
 *
 * ## Determinism
 *
 * gzip level 9, paths sorted, no clock, no randomness, no dev server, no network.
 * Two runs over the same `dist` produce byte-identical output.
 *
 * ## One source of truth per number
 *
 * `LAZY_CHUNK_GZIP_BYTES` (800 KiB) is declared once in `scripts/check-memory.mjs` and
 * imported here; `TOTAL_DIST_RAW_BYTES` (12 MB) is declared once in
 * `scripts/check-bundle-size.mjs` and imported here. The 300 KiB Welcome budget is
 * **not** re-checked here - `scripts/check-welcome-budget.mjs` owns it and remains the
 * only declaration of it.
 *
 * ## Usage
 *
 *   node scripts/check-performance.mjs              # gate on ./dist
 *   node scripts/check-performance.mjs --dist=DIR   # gate on another build
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { LAZY_CHUNK_GZIP_BYTES, LAZY_CHUNK_GZIP_KIB } from './check-memory.mjs';
import { TOTAL_DIST_RAW_BYTES } from './check-bundle-size.mjs';
import {
  BUNDLE_CENSUS_FILENAME,
  BUNDLE_CENSUS_SCHEMA_VERSION,
  GZIP_LEVEL,
  OFFLINE_SHELL_BOUNDARY_FILES,
} from './performance-budgets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIST = path.join(REPO_ROOT, 'dist');

/** The 800 KiB lazy-boundary ceiling, read from its one declaration. */
export const LAZY_BOUNDARY_GZIP_BYTES = LAZY_CHUNK_GZIP_BYTES;
export const LAZY_BOUNDARY_GZIP_KIB = LAZY_CHUNK_GZIP_KIB;

/** The 12 MB raw `dist` ceiling, read from its one declaration. */
export const TOTAL_DIST_BYTES = TOTAL_DIST_RAW_BYTES;

/** The offline static shell's boundary id, so the report and the tests agree on it. */
export const OFFLINE_BOUNDARY_ID = 'lane:offline';

/**
 * The runtime properties this gate deliberately does not measure, each paired with
 * the measurement that establishes it. Printed on every run.
 */
export const NOT_MEASURED = [
  {
    property: 'interaction acknowledgement under 100 ms',
    needs: 'A browser lane that dispatches an interaction and times the acknowledgement, on the declared reference environments.',
  },
  {
    property: 'p95 frame time under 20 ms at 100 rooms',
    needs: 'A browser lane that mounts the 100-room fixture and samples frame time; software WebGL in CI is a floor, not a certification.',
  },
];

/* -------------------------------------------------------------------------- */
/* Pure measurement and evaluation                                             */
/* -------------------------------------------------------------------------- */

/** gzips a buffer at the declared level. Exported so a test can measure without a disk. */
export function gzipSize(bytes) {
  return gzipSync(bytes, { level: GZIP_LEVEL }).length;
}

export function kib(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

export function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Validates the census text.
 *
 * Fails closed: an unreadable or newer-schema census is a problem, not an empty
 * census. A gate that read an unknown schema optimistically would be measuring a
 * shape it was not written for.
 */
export function parseCensus(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problem: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: 'is not a JSON object' };
  }
  if (value.schemaVersion !== BUNDLE_CENSUS_SCHEMA_VERSION) {
    return {
      problem: `has schemaVersion ${String(value.schemaVersion)}, not ${BUNDLE_CENSUS_SCHEMA_VERSION}`,
    };
  }
  if (!Array.isArray(value.moduleEntryChunks) || value.moduleEntryChunks.length === 0) {
    return { problem: 'names no module entry chunk' };
  }
  if (!Array.isArray(value.boundaries)) {
    return { problem: 'has no boundaries array' };
  }
  if (!Array.isArray(value.accountedChunkFiles)) {
    return { problem: 'has no accountedChunkFiles array' };
  }
  return { census: value };
}

/** Normalizes one census boundary, tolerating a hand-written fixture's omissions. */
export function normalizeBoundary(raw) {
  const strings = (list) => (Array.isArray(list) ? list.filter((value) => typeof value === 'string') : []);
  return {
    id: typeof raw?.id === 'string' ? raw.id : '(boundary)',
    kind: raw?.kind === 'renderer' ? 'renderer' : 'lane',
    label: typeof raw?.label === 'string' ? raw.label : typeof raw?.id === 'string' ? raw.id : '(boundary)',
    present: raw?.present === true,
    chunks: strings(raw?.chunks),
    eagerChunks: strings(raw?.eagerChunks),
    note: typeof raw?.note === 'string' ? raw.note : '',
  };
}

/**
 * The offline static shell as a boundary, derived from the files present in `dist`.
 *
 * The shell is not part of the module bundle - the offline plugin generates it after
 * `writeBundle` - so the census cannot describe it. Its files are declared once in
 * `scripts/performance-budgets.mjs` and read from `dist` here.
 */
export function buildOfflineBoundary(existingPaths) {
  const present = OFFLINE_SHELL_BOUNDARY_FILES.filter((fileName) =>
    existingPaths.has(fileName),
  );
  return {
    id: OFFLINE_BOUNDARY_ID,
    kind: 'lane',
    label: 'Offline shell',
    present: present.length > 0,
    chunks: present,
    eagerChunks: present,
    note:
      present.length > 0
        ? 'The offline static shell files this build emitted.'
        : 'The offline static shell is absent from this build, so it was not measured.',
  };
}

/**
 * Measures the distinct chunk files a set of boundaries names.
 *
 * `readFile` is injected so a test measures in-memory bytes rather than a disk. A
 * file the reader cannot read is recorded as an error row rather than thrown: the
 * evaluator turns that into a named finding.
 */
export async function measureBoundaryChunks(boundaries, readFile) {
  const paths = [...new Set(boundaries.flatMap((boundary) => boundary.chunks))].sort();
  const sizes = new Map();
  for (const relativePath of paths) {
    try {
      const bytes = await readFile(relativePath);
      sizes.set(relativePath, { rawBytes: bytes.length, gzipBytes: gzipSize(bytes) });
    } catch (error) {
      sizes.set(relativePath, { error: error?.code ?? 'unknown error' });
    }
  }
  return sizes;
}

/**
 * Sums raw bytes over a `Map<path, rawBytes>`, or over objects with a `rawBytes`.
 *
 * Exported so the raw-total arithmetic is testable without a disk.
 */
export function sumRawBytes(entries) {
  let total = 0;
  if (entries instanceof Map) {
    for (const value of entries.values()) total += typeof value === 'number' ? value : value.rawBytes;
  } else {
    for (const value of entries) total += value.rawBytes;
  }
  return total;
}

/**
 * Decides pass or fail from a measurement.
 *
 * `boundaries` is the full declared list, census boundaries plus the offline
 * boundary. `sizes` is the map from {@link measureBoundaryChunks}. Every finding
 * names the boundary it came from, so a red run points at an artefact rather than a
 * number.
 */
export function evaluatePerformanceGate({
  boundaries,
  sizes,
  distTotalRawBytes,
  missingAccountedFiles = [],
  lazyLimitBytes = LAZY_BOUNDARY_GZIP_BYTES,
  totalLimitBytes = TOTAL_DIST_BYTES,
}) {
  const findings = [];
  const report = [];

  for (const boundary of boundaries) {
    const rows = boundary.chunks.map((relativePath) => {
      const measured = sizes.get(relativePath);
      return { path: relativePath, ...(measured ?? { error: 'not measured' }) };
    });

    for (const row of rows.filter((entry) => entry.gzipBytes === undefined)) {
      findings.push({
        code: 'missing-boundary-chunk',
        boundary: boundary.id,
        message:
          `${boundary.id} names ${row.path}, but it is not a readable file in the build ` +
          `(${row.error ?? 'missing'}). The census describes a different build; re-run npm run build:web.`,
      });
    }

    const gzipBytes = rows.reduce((sum, row) => sum + (row.gzipBytes ?? 0), 0);
    const rawBytes = rows.reduce((sum, row) => sum + (row.rawBytes ?? 0), 0);
    const over = boundary.present && boundary.chunks.length > 0 && gzipBytes > lazyLimitBytes;

    if (over) {
      findings.push({
        code: 'oversized-boundary',
        boundary: boundary.id,
        message:
          `${boundary.id} (${boundary.label}) is ${kib(gzipBytes)} gzip across ${rows.length} file(s), ` +
          `over plan section 10.2's ${LAZY_BOUNDARY_GZIP_KIB} KiB ceiling for a lazy route.`,
      });
    }

    report.push({
      id: boundary.id,
      kind: boundary.kind,
      label: boundary.label,
      present: boundary.present,
      chunks: rows.map((row) => row.path),
      eagerChunks: boundary.eagerChunks,
      chunkCount: rows.length,
      rawBytes,
      gzipBytes,
      over,
      missing: rows.filter((entry) => entry.gzipBytes === undefined).length,
      note: boundary.note,
    });
  }

  const measuredCount = report.filter((entry) => entry.present && entry.chunkCount > 0).length;
  if (measuredCount === 0) {
    findings.push({
      code: 'no-lazy-boundary',
      message:
        'The build emitted no measured lazy boundary at all, so this run budgeted nothing. A gate ' +
        'that reports success because it measured nothing is the failure it exists to prevent; ' +
        'build with npm run build:web and re-run.',
    });
  }

  if (missingAccountedFiles.length > 0) {
    findings.push({
      code: 'stale-census',
      boundary: null,
      message:
        `${missingAccountedFiles.length} JS/CSS file(s) named by the census are missing from the build ` +
        `(${missingAccountedFiles.slice(0, 5).join(', ')}${missingAccountedFiles.length > 5 ? ', ...' : ''}). ` +
        'The census and the build are not the same artefact; re-run npm run build:web.',
    });
  }

  if (distTotalRawBytes > totalLimitBytes) {
    findings.push({
      code: 'dist-over-budget',
      boundary: null,
      message:
        `raw dist is ${mib(distTotalRawBytes)} across every file, over plan section 10.2's ` +
        `${mib(totalLimitBytes)} ceiling.`,
    });
  }

  return {
    findings,
    ok: findings.length === 0,
    boundaries: report,
    measuredCount,
    distTotalRawBytes,
    totalLimitBytes,
    lazyLimitBytes,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function readArg(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

/** Every regular file under `distDir`, keyed by a dist-relative POSIX path. */
export async function collectDistFiles(distDir) {
  const entries = new Map();
  async function visit(directory, prefix) {
    const listing = await readdir(directory, { withFileTypes: true });
    for (const item of listing) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) {
        await visit(absolute, relative);
      } else if (item.isFile()) {
        entries.set(relative, (await stat(absolute)).size);
      }
    }
  }
  await visit(distDir, '');
  return entries;
}

async function main() {
  const distDir = path.resolve(REPO_ROOT, readArg('dist') ?? path.relative(REPO_ROOT, DEFAULT_DIST));
  const censusPath = path.join(distDir, BUNDLE_CENSUS_FILENAME);

  let censusText;
  try {
    censusText = await readFile(censusPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error(
        [
          `Performance budget gate: no bundle census at ${path.relative(REPO_ROOT, censusPath)}.`,
          'This gate fails rather than passing an unmeasured build, because a gate that reports',
          'success because it measured nothing is the failure this gate exists to prevent.',
          'Run: npm run build:web',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const parsed = parseCensus(censusText);
  if (parsed.problem !== undefined) {
    console.error(
      `Performance budget gate: ${BUNDLE_CENSUS_FILENAME} ${parsed.problem}. Run: npm run build:web`,
    );
    process.exitCode = 1;
    return;
  }
  const { census } = parsed;

  let distFiles;
  try {
    distFiles = await collectDistFiles(distDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error(
        [
          `Performance budget gate: no built artifact at ${path.relative(REPO_ROOT, distDir)}.`,
          'Run: npm run build:web',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const censusBoundaries = census.boundaries.map(normalizeBoundary);
  const boundaries = [...censusBoundaries, buildOfflineBoundary(distFiles)];
  const sizes = await measureBoundaryChunks(boundaries, (relative) =>
    readFile(path.join(distDir, ...relative.split('/'))),
  );
  const missingAccountedFiles = census.accountedChunkFiles.filter(
    (relative) => typeof relative === 'string' && !distFiles.has(relative),
  );

  const result = evaluatePerformanceGate({
    boundaries,
    sizes,
    distTotalRawBytes: sumRawBytes(distFiles),
    missingAccountedFiles,
  });

  console.log(
    `Route-aware performance budgets (plan section 10.2: each lazy boundary <= ${LAZY_BOUNDARY_GZIP_KIB} KiB gzip; ` +
      `raw dist <= ${mib(TOTAL_DIST_BYTES)})`,
  );
  console.log(`  Measured from: ${path.relative(REPO_ROOT, distDir) || '.'}`);
  console.log(`  gzip level: ${GZIP_LEVEL}`);
  console.log(
    `  Census: ${BUNDLE_CENSUS_FILENAME} (schema ${census.schemaVersion}, ` +
      `${census.moduleEntryChunks.length} module entry chunk(s))`,
  );
  console.log('');

  console.log('Declared lazy boundaries:');
  const width = Math.max(18, ...result.boundaries.map((entry) => entry.id.length));
  for (const entry of result.boundaries) {
    const verdict = !entry.present
      ? 'NOT PRESENT in this build (not measured)'
      : entry.over
        ? 'OVER BUDGET'
        : 'within budget';
    const size = entry.present ? kib(entry.gzipBytes).padStart(11) : ' '.repeat(11);
    console.log(
      `  ${entry.id.padEnd(width)}  ${entry.label.padEnd(13)}  ${size} gzip  ${verdict}`,
    );
    for (const chunk of entry.chunks) {
      const row = sizes.get(chunk);
      const sizeText = row?.gzipBytes === undefined ? 'unreadable' : kib(row.gzipBytes).padStart(11);
      console.log(`      ${chunk.padEnd(width + 13)}  ${sizeText} gzip`);
    }
    if (entry.eagerChunks.length > 0) {
      console.log(`      downloaded before any application code runs: ${entry.eagerChunks.join(', ')}`);
    }
    if (!entry.present) console.log(`      ${entry.note}`);
  }
  console.log('');

  const absent = result.boundaries.filter((entry) => !entry.present).map((entry) => entry.id);
  console.log(
    `  raw dist   ${mib(result.distTotalRawBytes)} over ${distFiles.size} file(s)   ` +
      `limit ${mib(result.totalLimitBytes)}   ${result.distTotalRawBytes <= result.totalLimitBytes ? 'within budget' : 'OVER BUDGET'}`,
  );
  console.log(
    `  measured lazy boundaries: ${result.measuredCount}` +
      (absent.length > 0 ? `; declared but absent (not measured): ${absent.join(', ')}` : ''),
  );
  console.log('');

  console.log('NOT MEASURED HERE (this gate reads a build, not a browser):');
  for (const item of NOT_MEASURED) {
    console.log(`  - ${item.property}`);
    console.log(`      needs: ${item.needs}`);
  }
  console.log('');

  if (!result.ok) {
    console.error('Performance budget gate FAILED:');
    for (const finding of result.findings) {
      console.error(`  [${finding.code}] ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const measuredNamed = result.boundaries
    .filter((entry) => entry.present && entry.chunkCount > 0)
    .map((entry) => entry.id);
  console.log(
    `Performance budget gate passed: ${result.measuredCount} lazy boundary/boundaries measured ` +
      `(${measuredNamed.join(', ') || 'none'}), each within ${LAZY_BOUNDARY_GZIP_KIB} KiB gzip; ` +
      `raw dist ${mib(result.distTotalRawBytes)} within ${mib(result.totalLimitBytes)}.`,
  );
  console.log(
    `  Not measured on this build (absent from it, so not clean either): ${absent.join(', ') || 'none'}.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) await main();
