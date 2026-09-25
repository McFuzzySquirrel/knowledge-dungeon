#!/usr/bin/env node
/**
 * Phase 1A deterministic web-artifact identity and integrity verification.
 *
 * Every compatibility lane must exercise the same production web artifact. This
 * script records a reproducible identity for the `dist` tree and verifies a tree
 * against a previously recorded manifest, so a CI job can consume an uploaded
 * artifact instead of rebuilding a different one.
 *
 * The identity is a SHA-256 tree hash over `sha256(bytes)  posix/relative/path`
 * lines in path order, which is stable across Linux, macOS, and Windows. The
 * script uses Node built-ins only: no shell commands, no dependencies, and no
 * platform-specific path or hashing behavior.
 *
 * Integrity rules:
 * - `dist` may contain only regular files. Symlinks, sockets, devices, and other
 *   special entries are rejected instead of being followed or hashed.
 * - A recorded manifest must have the supported schema, a complete identity, a
 *   well-formed file array (no duplicate, absolute, backslash, or parent-escaping
 *   paths; 64-character hex digests; non-negative byte counts), and a
 *   self-consistent entrypoint. The recorded tree digest is recomputed from the
 *   recorded file entries and must equal the recorded identity, and the recorded
 *   file count, byte total, and entrypoint must match.
 * - The recomputed `dist` identity must then equal the recorded identity.
 *
 * Output is always structured and sanitized. Messages never contain absolute
 * paths, request data, or learner data; integrity failures are reported as
 * bounded problem codes plus dist-relative build-output paths.
 *
 * Usage:
 *   node scripts/web-artifact-manifest.mjs write [--dist=<dir>] [--out=<file>]
 *   node scripts/web-artifact-manifest.mjs verify [--dist=<dir>] [--manifest=<file>] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const IDENTITY_ALGORITHM = 'sha256-tree-v1';
const MANIFEST_SCHEMA_VERSION = 1;
const ENTRYPOINT_PATH = 'index.html';
const MAX_REPORTED_DIFFERENCES = 5;
const MAX_MESSAGE_LENGTH = 240;
const MAX_PATH_LENGTH = 160;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODES = new Set(['write', 'verify']);

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function flagPresent(name) {
  return process.argv.includes(`--${name}`);
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isByteCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Bounded, path-free text for human-facing messages. Absolute filesystem paths,
 * control characters, and newlines are removed so a failure string can never
 * carry machine or user data.
 */
function sanitizeMessage(text) {
  const withoutPaths = String(text)
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/\/(?:[^\s"'/]+\/)*[^\s"']*/g, '<path>')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutPaths.slice(0, MAX_MESSAGE_LENGTH);
}

function isValidRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (value.includes('\\') || value.includes('//')) return false;
  if (value.startsWith('/')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function comparePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sha256Hex(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

/** Rejects anything that is not a regular file instead of following it. */
async function scanDist(distDir) {
  const files = [];
  const problems = [];

  const visit = async (directory, relativePrefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push({ code: 'symlink-entry', path: isValidRelativePath(relativePath) ? relativePath : null });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        problems.push({ code: 'special-file-entry', path: isValidRelativePath(relativePath) ? relativePath : null });
        continue;
      }
      const contents = await readFile(absolutePath);
      files.push({ path: relativePath, sha256: sha256Hex(contents), bytes: contents.byteLength });
    }
  };

  await visit(distDir, '');
  files.sort(comparePaths);
  return { files, problems };
}

function identityFromFiles(files) {
  const treeHash = createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    treeHash.update(`${file.sha256}  ${file.path}\n`, 'utf8');
    totalBytes += file.bytes;
  }
  return {
    algorithm: IDENTITY_ALGORITHM,
    treeSha256: treeHash.digest('hex'),
    fileCount: files.length,
    totalBytes,
  };
}

function boundedProblems(problems) {
  return problems.slice(0, MAX_REPORTED_DIFFERENCES).map((problem) => ({ ...problem }));
}

function problemCodes(problems) {
  return [...new Set(problems.map((problem) => problem.code))].slice(0, MAX_REPORTED_DIFFERENCES);
}

function entrypointOf(files) {
  const entrypoint = files.find((file) => file.path === ENTRYPOINT_PATH);
  return entrypoint ? { path: entrypoint.path, sha256: entrypoint.sha256, bytes: entrypoint.bytes } : null;
}

/**
 * Structural and self-consistency validation of a recorded manifest. Returns the
 * sanitized problem list plus the recorded identity, file entries, and entrypoint
 * so the caller can compare them with the recomputed `dist` identity.
 */
function validateManifest(manifest) {
  const problems = [];
  const add = (code) => problems.push({ code, path: null });

  if (!isPlainObject(manifest)) {
    add('manifest-not-object');
    return { problems, identity: null, files: null, entrypoint: null };
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    add('schema-version-unsupported');
  }

  const identity = manifest.identity;
  if (!isPlainObject(identity)) {
    add('identity-missing');
  } else {
    if (identity.algorithm !== IDENTITY_ALGORITHM) add('identity-algorithm-unsupported');
    if (!isSha256(identity.treeSha256)) add('identity-tree-sha256-invalid');
    if (!isByteCount(identity.fileCount)) add('identity-file-count-invalid');
    if (!isByteCount(identity.totalBytes)) add('identity-total-bytes-invalid');
  }

  let files = null;
  if (!Array.isArray(manifest.files)) {
    add('files-not-array');
  } else {
    files = [];
    const seen = new Set();
    for (const entry of manifest.files) {
      if (!isPlainObject(entry)) {
        add('file-entry-not-object');
        continue;
      }
      if (!isValidRelativePath(entry.path)) {
        add('file-path-invalid');
        continue;
      }
      if (seen.has(entry.path)) {
        add('file-path-duplicate');
        continue;
      }
      if (!isSha256(entry.sha256)) {
        add('file-sha256-invalid');
        continue;
      }
      if (!isByteCount(entry.bytes)) {
        add('file-bytes-invalid');
        continue;
      }
      seen.add(entry.path);
      files.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
    }

    // The recorded tree digest must be reproducible from the recorded entries.
    if (files.length === manifest.files.length) {
      const recomputed = identityFromFiles(files);
      if (isPlainObject(identity) && recomputed.treeSha256 !== identity.treeSha256) {
        add('recorded-tree-digest-mismatch');
      }
      if (isPlainObject(identity) && isByteCount(identity.fileCount) && recomputed.fileCount !== identity.fileCount) {
        add('recorded-file-count-mismatch');
      }
      if (isPlainObject(identity) && isByteCount(identity.totalBytes) && recomputed.totalBytes !== identity.totalBytes) {
        add('recorded-total-bytes-mismatch');
      }
    }
  }

  const entrypoint = manifest.entrypoint;
  let recordedEntrypoint = null;
  if (!isPlainObject(entrypoint)) {
    add('entrypoint-missing');
  } else {
    if (entrypoint.path !== ENTRYPOINT_PATH || !isSha256(entrypoint.sha256) || !isByteCount(entrypoint.bytes)) {
      add('entrypoint-invalid');
    } else {
      recordedEntrypoint = {
        path: entrypoint.path,
        sha256: entrypoint.sha256,
        bytes: entrypoint.bytes,
      };
      const recordedFile = files?.find((file) => file.path === ENTRYPOINT_PATH) ?? null;
      if (!recordedFile) {
        add('entrypoint-not-in-file-list');
      } else if (recordedFile.sha256 !== recordedEntrypoint.sha256 || recordedFile.bytes !== recordedEntrypoint.bytes) {
        add('entrypoint-inconsistent-with-file-list');
      }
    }
  }

  return { problems, identity, files, entrypoint: recordedEntrypoint };
}

function describeDistDifferences(recordedFiles, actualFiles) {
  const expected = new Map(recordedFiles.map((file) => [file.path, file]));
  const actual = new Map(actualFiles.map((file) => [file.path, file]));
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  const differences = [];

  for (const filePath of [...paths].sort()) {
    const expectedFile = expected.get(filePath);
    const actualFile = actual.get(filePath);
    if (expectedFile?.sha256 === actualFile?.sha256 && expectedFile?.bytes === actualFile?.bytes) {
      continue;
    }
    differences.push({
      path: filePath,
      kind: expectedFile === undefined ? 'added' : actualFile === undefined ? 'removed' : 'modified',
      expectedSha256: expectedFile?.sha256 ?? null,
      actualSha256: actualFile?.sha256 ?? null,
    });
    if (differences.length >= MAX_REPORTED_DIFFERENCES) break;
  }

  return differences;
}

function buildContext() {
  let packageJson = { name: 'unknown', version: 'unknown' };
  try {
    packageJson = readJson(path.join(PROJECT_ROOT, 'package.json'));
  } catch {
    // A missing package.json only reduces recorded context; the identity itself
    // depends on dist bytes alone.
  }
  const npmUserAgent = process.env.npm_config_user_agent;

  return {
    expectedBuildCommand: 'npm run build:web',
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    node: process.version,
    npm: npmUserAgent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? commandVersion('npm', ['--version']),
    platform: process.platform,
    arch: process.arch,
    tools: {
      vite: installedPackageVersion('vite'),
      typescript: installedPackageVersion('typescript'),
      playwright: installedPackageVersion('@playwright/test'),
    },
    git: {
      revision: commandVersion('git', ['rev-parse', 'HEAD']),
      branch: commandVersion('git', ['branch', '--show-current']),
      dirty: Boolean(commandVersion('git', ['status', '--porcelain'])),
    },
  };
}

function readJson(absolutePath) {
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
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

function result(status, code, message, extra = {}) {
  return {
    status,
    code,
    algorithm: IDENTITY_ALGORITHM,
    message: sanitizeMessage(message),
    ...extra,
  };
}

function identitySummary(identity) {
  if (!identity) return null;
  return {
    algorithm: identity.algorithm,
    treeSha256: identity.treeSha256,
    fileCount: identity.fileCount,
    totalBytes: identity.totalBytes,
  };
}

async function scanDistOrFail(distDir) {
  if (!existsSync(distDir)) {
    return {
      failure: result('dist-missing', 'dist-missing', 'No web build was found. Run "npm run build:web" first.'),
    };
  }

  const scan = await scanDist(distDir);
  if (scan.problems.length > 0) {
    return {
      failure: result('dist-invalid', 'dist-integrity', 'The web build contains entries that cannot be hashed.', {
        problems: boundedProblems(scan.problems),
        problemCodes: problemCodes(scan.problems),
      }),
    };
  }
  if (scan.files.length === 0) {
    return { failure: result('dist-invalid', 'dist-empty', 'The web build directory contains no files.') };
  }
  if (entrypointOf(scan.files) === null) {
    return {
      failure: result('dist-invalid', 'entrypoint-missing', `The web build has no ${ENTRYPOINT_PATH} entrypoint.`),
    };
  }
  return { scan };
}

async function writeManifest(distDir, manifestPath) {
  const { failure, scan } = await scanDistOrFail(distDir);
  if (failure) return { failure };

  const identity = identityFromFiles(scan.files);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    identity,
    entrypoint: entrypointOf(scan.files),
    build: buildContext(),
    files: scan.files,
  };

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, identity };
}

async function verifyManifest(distDir, manifestPath) {
  const { failure, scan } = await scanDistOrFail(distDir);
  if (failure) return { result: failure };

  if (!existsSync(manifestPath)) {
    return {
      result: result('manifest-missing', 'manifest-missing', 'No recorded web-artifact manifest was found.'),
    };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return {
      result: result('invalid-manifest', 'manifest-unreadable', 'The recorded web-artifact manifest is not valid JSON.'),
    };
  }

  const validation = validateManifest(manifest);
  if (validation.problems.length > 0) {
    return {
      result: result('invalid-manifest', 'manifest-integrity', 'The recorded web-artifact manifest failed integrity validation.', {
        problems: boundedProblems(validation.problems),
        problemCodes: problemCodes(validation.problems),
        recordedIdentity: identitySummary(isPlainObject(validation.identity) ? validation.identity : null),
        recordedEntrypoint: validation.entrypoint,
      }),
    };
  }

  const actual = identityFromFiles(scan.files);
  const recorded = validation.identity;
  const differences = describeDistDifferences(validation.files, scan.files);
  const matches =
    actual.treeSha256 === recorded.treeSha256 &&
    actual.fileCount === recorded.fileCount &&
    actual.totalBytes === recorded.totalBytes;

  return {
    result: matches
      ? result('match', 'match', 'The web build matches the recorded production artifact.', {
          identity: identitySummary(actual),
          recordedIdentity: identitySummary(recorded),
          entrypoint: entrypointOf(scan.files),
          recordedEntrypoint: validation.entrypoint,
          differences: [],
        })
      : result('mismatch', 'dist-does-not-match-recorded-artifact', 'The web build does not match the recorded production artifact.', {
          identity: identitySummary(actual),
          recordedIdentity: identitySummary(recorded),
          entrypoint: entrypointOf(scan.files),
          recordedEntrypoint: validation.entrypoint,
          differences,
        }),
  };
}

async function main() {
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const [mode, ...rest] = positional;
  if (rest.length > 0) {
    throw new Error(`Unexpected argument: ${rest.length} positional values are not supported.`);
  }
  const selectedMode = mode ?? 'write';
  if (!MODES.has(selectedMode)) {
    throw new Error(`Unknown mode. Use "write" or "verify".`);
  }

  const distDir = path.resolve(PROJECT_ROOT, argumentValue('dist') ?? path.join(PROJECT_ROOT, 'dist'));
  const manifestPath = path.resolve(
    PROJECT_ROOT,
    argumentValue('out') ?? argumentValue('manifest') ?? path.join(PROJECT_ROOT, 'artifacts', 'web-artifact-manifest.json'),
  );

  if (selectedMode === 'write') {
    const outcome = await writeManifest(distDir, manifestPath);
    if (outcome.failure) {
      if (flagPresent('json')) {
        console.log(JSON.stringify(outcome.failure, null, 2));
      } else {
        console.error(`${outcome.failure.status}: ${outcome.failure.message} (${outcome.failure.code})`);
        for (const problem of outcome.failure.problems ?? []) {
          console.error(`  ${problem.code}${problem.path ? ` ${problem.path}` : ''}`);
        }
      }
      process.exitCode = 1;
      return;
    }
    const { manifest, identity } = outcome;
    console.log(
      `Recorded ${identity.algorithm} identity ${identity.treeSha256} for ${identity.fileCount} dist files ` +
        `(${identity.totalBytes} bytes).`,
    );
    console.log(`Entrypoint ${manifest.entrypoint.path} sha256 ${manifest.entrypoint.sha256}.`);
    console.log(`Manifest: ${toPosixPath(path.relative(PROJECT_ROOT, manifestPath))}`);
    return;
  }

  const { result: verification } = await verifyManifest(distDir, manifestPath);
  if (flagPresent('json')) {
    console.log(JSON.stringify(verification, null, 2));
  } else {
    console.log(`${verification.status}: ${verification.message} (${verification.code})`);
    if (verification.identity) {
      console.log(
        `dist identity ${verification.identity.algorithm} ${verification.identity.treeSha256} ` +
          `(${verification.identity.fileCount} files, ${verification.identity.totalBytes} bytes).`,
      );
    }
    for (const problem of verification.problems ?? []) {
      console.error(`  ${problem.code}${problem.path ? ` ${problem.path}` : ''}`);
    }
    for (const difference of verification.differences ?? []) {
      console.error(`  ${difference.kind} ${difference.path}`);
    }
  }

  if (verification.status !== 'match') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // Never surface a raw exception: a failure must stay structured and sanitized.
  const failure = result('error', 'unexpected-error', error instanceof Error ? error.message : String(error));
  if (flagPresent('json')) {
    console.log(JSON.stringify(failure, null, 2));
  } else {
    console.error(`${failure.status}: ${failure.message} (${failure.code})`);
  }
  process.exitCode = 1;
});
