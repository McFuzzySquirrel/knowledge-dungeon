#!/usr/bin/env node
/**
 * Records reproducible Phase 1 build metadata for later performance work.
 * This is measurement only; it does not enforce Phase 22 budgets.
 */
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'artifacts');
const OUTPUT_PATH = path.join(ARTIFACTS_DIR, 'build-metadata.json');

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(relativePath, 'utf8'));
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function installedPackageVersion(packageName) {
  try {
    return readJson(path.join(PROJECT_ROOT, 'node_modules', packageName, 'package.json')).version;
  } catch {
    return null;
  }
}

function gitValue(args) {
  return commandVersion('git', args);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files.sort();
}

function kindFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.js' || extension === '.mjs') return 'javascript';
  if (extension === '.css') return 'css';
  if (filePath.endsWith('.map')) return 'source-map';
  return 'asset';
}

function emptyTotals() {
  return { fileCount: 0, rawBytes: 0, gzipBytes: 0 };
}

function addFile(totals, rawBytes, gzipBytes) {
  totals.fileCount += 1;
  totals.rawBytes += rawBytes;
  totals.gzipBytes += gzipBytes;
}

const mode = argumentValue('mode') ?? 'production';
const packageJson = readJson(path.join(PROJECT_ROOT, 'package.json'));
const distFiles = await walk(DIST_DIR);
const totalsByKind = {
  javascript: emptyTotals(),
  css: emptyTotals(),
  'source-map': emptyTotals(),
  asset: emptyTotals(),
};
const chunkFiles = [];

for (const absolutePath of distFiles) {
  const contents = await readFile(absolutePath);
  const rawBytes = contents.byteLength;
  const gzipBytes = gzipSync(contents, { level: 9 }).byteLength;
  const kind = kindFor(absolutePath);
  const relativePath = path.relative(DIST_DIR, absolutePath).split(path.sep).join('/');
  addFile(totalsByKind[kind], rawBytes, gzipBytes);

  if (kind === 'javascript' || kind === 'css') {
    chunkFiles.push({ file: relativePath, kind, rawBytes, gzipBytes });
  }
}

const distTotal = Object.values(totalsByKind).reduce(
  (total, current) => ({
    fileCount: total.fileCount + current.fileCount,
    rawBytes: total.rawBytes + current.rawBytes,
    gzipBytes: total.gzipBytes + current.gzipBytes,
  }),
  emptyTotals(),
);
const chunkTotal = chunkFiles.reduce(
  (total, chunk) => ({
    fileCount: total.fileCount + 1,
    rawBytes: total.rawBytes + chunk.rawBytes,
    gzipBytes: total.gzipBytes + chunk.gzipBytes,
  }),
  emptyTotals(),
);
const npmUserAgent = process.env.npm_config_user_agent;
const npmVersion = npmUserAgent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? commandVersion('npm', ['--version']);

const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  build: {
    mode,
    production: mode === 'production',
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  },
  git: {
    revision: gitValue(['rev-parse', 'HEAD']),
    branch: gitValue(['branch', '--show-current']),
    dirty: Boolean(gitValue(['status', '--porcelain'])),
  },
  runtime: {
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    arch: process.arch,
  },
  tools: {
    vite: installedPackageVersion('vite'),
    typescript: installedPackageVersion('typescript'),
    playwright: installedPackageVersion('@playwright/test'),
    axeCorePlaywright: installedPackageVersion('@axe-core/playwright'),
  },
  dist: {
    ...distTotal,
    gzipMeasurement: 'sum of deterministic per-file gzip level 9 sizes',
    totalsByKind,
    chunkTotal,
    chunks: chunkFiles,
  },
};

await mkdir(ARTIFACTS_DIR, { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

console.log(
  `Recorded ${distTotal.fileCount} dist files, ${distTotal.rawBytes} raw bytes, ` +
    `${distTotal.gzipBytes} summed gzip bytes, and ${chunkTotal.fileCount} JS/CSS chunks.`,
);
console.log(`Build metadata: ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
