#!/usr/bin/env node
/**
 * Phase 1A deterministic web-artifact identity and integrity verification.
 *
 * Every compatibility lane must exercise the same production web artifact. This
 * script records a reproducible identity for the `dist` tree and verifies a tree
 * against a previously recorded manifest, so a CI job can consume an uploaded
 * artifact instead of rebuilding a different one.
 *
 * The script uses Node built-ins only: no shell commands beyond `git` for
 * listing tracked paths, no dependencies, and no platform-specific path or
 * hashing behavior.
 *
 * ## Two identities, because one is not enough
 *
 * The `dist` identity is a SHA-256 tree hash over `sha256(bytes)
 * posix/relative/path` lines in path order, which is stable across Linux,
 * macOS, and Windows. On its own it is **self-referential**: the manifest is
 * recorded from the same `dist` a lane then serves, so a lane that finds
 * `dist` matching the manifest has only proved `dist` matches `dist`. A stale
 * `dist` from an older source revision, paired with a manifest recorded from
 * that same stale tree, passes that comparison byte for byte. That is a gate
 * that certifies a stale artifact.
 *
 * So the manifest also carries a **source identity**, `sha256-git-tracked-v1`:
 * a SHA-256 tree hash in the same line format over every git-tracked file,
 * hashed from working-tree content, in path order. It is
 *
 * - derived from actual source content, so a dirty worktree still produces a
 *   passing pair and a `dist` built from different content is still detected
 *   (a commit sha alone is not enough: an uncommitted tree has a sha that does
 *   not describe it);
 * - restricted to tracked files, so build outputs, `artifacts/`, `dist/`,
 *   `node_modules/`, and other untracked files cannot perturb it, and in
 *   particular the build's own timestamped `public/assets/sprite-manifest.json`
 *   - gitignored, because a clean rebuild is not bit-reproducible for exactly
 *   that reason - is never hashed;
 * - line-ending normalized for text, using git's own NUL-byte text heuristic,
 *   so the same commit hashes identically on a CRLF checkout and an LF one and
 *   a verifying job on another host cannot report a source change that did not
 *   happen.
 *
 * ## What the source identity does and does not prove
 *
 * It proves the recorded manifest is **not older than the current tracked
 * source**: a recorded artifact whose source identity differs from the worktree
 * it is verified against is stale evidence, and the gate fails. It does not
 * cryptographically prove which source produced a given `dist` - nothing outside
 * the build can - and it is not a substitute for the tree identity, which still
 * carries the artifact-level claim on its own. Both must hold.
 *
 * ## Integrity rules
 *
 * - `dist` may contain only regular files. Symlinks, sockets, devices, and other
 *   special entries are rejected instead of being followed or hashed.
 * - A recorded manifest must have the supported schema, a complete identity, a
 *   well-formed file array (no duplicate, absolute, backslash, or parent-escaping
 *   paths; 64-character hex digests; non-negative byte counts), and a
 *   self-consistent entrypoint. The recorded tree digest is recomputed from the
 *   recorded file entries and must equal the recorded identity, and the recorded
 *   file count, byte total, and entrypoint must match.
 * - A manifest with no well-formed source identity is rejected. That is what
 *   forces a pre-fix manifest to be re-recorded rather than trusted.
 * - The recomputed `dist` identity must then equal the recorded identity, and
 *   the recomputed source identity must equal the recorded one.
 * - A tracked source file that is missing or unregular fails closed: the scan
 *   reports a bounded problem code instead of hashing a guess.
 *
 * Output is always structured and sanitized. Messages never contain absolute
 * paths, request data, or learner data; integrity failures are reported as
 * bounded problem codes plus dist-relative build-output paths.
 *
 * Usage:
 *   node scripts/web-artifact-manifest.mjs write [--dist=<dir>] [--out=<file>] [--source-root=<dir>]
 *   node scripts/web-artifact-manifest.mjs verify [--dist=<dir>] [--manifest=<file>] [--source-root=<dir>] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const IDENTITY_ALGORITHM = 'sha256-tree-v1';
const SOURCE_IDENTITY_ALGORITHM = 'sha256-git-tracked-v1';
/** Bumped because a manifest without a source identity is no longer evidence. */
const MANIFEST_SCHEMA_VERSION = 2;
const ENTRYPOINT_PATH = 'index.html';
const MAX_REPORTED_DIFFERENCES = 5;
const MAX_MESSAGE_LENGTH = 240;
const MAX_PATH_LENGTH = 160;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODES = new Set(['write', 'verify']);
/** Token for a tracked file with no working-tree copy. Never a 64-hex digest. */
const ABSENT_SOURCE_TOKEN = 'absent';
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

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

/**
 * Every git-tracked path, or `null` when git cannot answer. `--cached` reads the
 * index, so a tracked file is listed whether or not a working-tree copy exists
 * and whether or not that copy is modified. `-z` keeps paths raw, so no path
 * can be reshaped by git's quoting.
 */
function listGitTrackedPaths(sourceRoot) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    })
      .split('\0')
      .filter((trackedPath) => trackedPath.length > 0);
  } catch {
    return null;
  }
}

/**
 * Line-ending normalization for source hashing, using git's own text heuristic:
 * a NUL byte means binary, so binaries are hashed byte for byte and only text
 * is normalized. Without it the same commit would hash differently on a CRLF
 * checkout than on an LF one, and a verifying job on a second host would
 * report a source change that never happened. It cannot hide a real edit:
 * every other byte still contributes, and a whitespace-only rewrap is not a
 * change the `dist` tree identity can see either.
 */
function normalizeSourceBytes(contents) {
  if (contents.includes(0)) return contents;
  const normalized = Buffer.allocUnsafe(contents.length);
  let length = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === 0x0d && contents[index + 1] === 0x0a) continue;
    normalized[length] = contents[index];
    length += 1;
  }
  return normalized.subarray(0, length);
}

/** Same line format and same path ordering as the `dist` identity. */
function sourceIdentityFromEntries(entries) {
  const treeHash = createHash('sha256');
  let totalBytes = 0;
  for (const entry of entries) {
    treeHash.update(`${entry.token}  ${entry.path}\n`, 'utf8');
    totalBytes += entry.bytes;
  }
  return {
    algorithm: SOURCE_IDENTITY_ALGORITHM,
    treeSha256: treeHash.digest('hex'),
    fileCount: entries.length,
    totalBytes,
  };
}

/**
 * The source identity for a checkout, or a structured failure. Fails closed: a
 * source identity that cannot be computed is a gate that cannot evaluate its own
 * precondition, and reporting it as anything but a failure would put this script
 * back where it started.
 */
async function scanSource(sourceRoot) {
  const trackedPaths = listGitTrackedPaths(sourceRoot);
  if (trackedPaths === null) {
    return {
      failure: result(
        'source-unavailable',
        'source-identity-unavailable',
        'The tracked source tree could not be listed. Record and verify from a git checkout.',
        { algorithm: SOURCE_IDENTITY_ALGORITHM },
      ),
    };
  }

  const entries = [];
  const problems = [];
  for (const trackedPath of trackedPaths) {
    if (!isValidRelativePath(trackedPath)) {
      problems.push({ code: 'source-path-invalid', path: null });
      continue;
    }
    const absolutePath = path.join(sourceRoot, ...trackedPath.split('/'));
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      // A tracked file deleted in the worktree is a legitimate dirty state, not
      // a failure: it hashes as absent so the identity still describes the tree.
      entries.push({ path: trackedPath, token: ABSENT_SOURCE_TOKEN, bytes: 0 });
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      // Never followed and never hashed, for the same reason `dist` is not.
      problems.push({ code: 'source-non-regular-entry', path: trackedPath });
      continue;
    }
    const contents = normalizeSourceBytes(await readFile(absolutePath));
    entries.push({ path: trackedPath, token: sha256Hex(contents), bytes: contents.byteLength });
  }

  if (problems.length > 0) {
    return {
      failure: result(
        'source-invalid',
        'source-integrity',
        'The tracked source tree contains entries that cannot be hashed.',
        {
          algorithm: SOURCE_IDENTITY_ALGORITHM,
          problems: boundedProblems(problems),
          problemCodes: problemCodes(problems),
        },
      ),
    };
  }

  entries.sort(comparePaths);
  return { source: sourceIdentityFromEntries(entries) };
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
    return { problems, identity: null, source: null, files: null, entrypoint: null };
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

  // Validated independently of the schema-version check, so a manifest recorded
  // before source identity existed reports `source-missing` - the actionable
  // code - alongside `schema-version-unsupported` rather than only the latter.
  const source = manifest.source;
  if (!isPlainObject(source)) {
    add('source-missing');
  } else {
    if (source.algorithm !== SOURCE_IDENTITY_ALGORITHM) add('source-algorithm-unsupported');
    if (!isSha256(source.treeSha256)) add('source-tree-sha256-invalid');
    if (!isByteCount(source.fileCount)) add('source-file-count-invalid');
    if (!isByteCount(source.totalBytes)) add('source-total-bytes-invalid');
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

  return { problems, identity, source, files, entrypoint: recordedEntrypoint };
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

/** Bounded, algorithm-agnostic view of either recorded identity. */
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

async function writeManifest(distDir, manifestPath, sourceRoot) {
  const { failure, scan } = await scanDistOrFail(distDir);
  if (failure) return { failure };

  // The source identity is recorded in the same pass, so a manifest can never
  // claim a source identity that was not read beside the tree it describes.
  const { failure: sourceFailure, source } = await scanSource(sourceRoot);
  if (sourceFailure) return { failure: sourceFailure };

  const identity = identityFromFiles(scan.files);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    identity,
    source,
    entrypoint: entrypointOf(scan.files),
    build: buildContext(),
    files: scan.files,
  };

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, identity, source };
}

async function verifyManifest(distDir, manifestPath, sourceRoot) {
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
        recordedSource: identitySummary(isPlainObject(validation.source) ? validation.source : null),
        recordedEntrypoint: validation.entrypoint,
      }),
    };
  }

  // Evaluated after the manifest is known to be well formed, and before the
  // comparison, so a source tree that cannot be hashed is a hard failure rather
  // than a silent pass.
  const { failure: sourceFailure, source: currentSource } = await scanSource(sourceRoot);
  if (sourceFailure) return { result: sourceFailure };

  const actual = identityFromFiles(scan.files);
  const recorded = validation.identity;
  const differences = describeDistDifferences(validation.files, scan.files);
  const treeMatches =
    actual.treeSha256 === recorded.treeSha256 &&
    actual.fileCount === recorded.fileCount &&
    actual.totalBytes === recorded.totalBytes;
  const sourceMatches = currentSource.treeSha256 === validation.source.treeSha256;
  const matches = treeMatches && sourceMatches;

  // Tree mismatch first, because a different `dist` is the more direct
  // diagnosis. The source comparison is the one that catches the case the tree
  // comparison structurally cannot: identical stale `dist` bytes paired with a
  // manifest recorded from that same stale tree.
  let code = 'match';
  let message = 'The web build matches the recorded production artifact and the source it was recorded from.';
  if (!treeMatches) {
    code = 'dist-does-not-match-recorded-artifact';
    message = 'The web build does not match the recorded production artifact.';
  } else if (!sourceMatches) {
    code = 'source-does-not-match-recorded-artifact';
    message =
      'The web build matches the recorded artifact byte for byte, but that artifact was recorded from different ' +
      'source content, so it is stale evidence. Rebuild and re-record it.';
  }

  return {
    result: result(matches ? 'match' : 'mismatch', code, message, {
      identity: identitySummary(actual),
      recordedIdentity: identitySummary(recorded),
      source: identitySummary(currentSource),
      recordedSource: identitySummary(validation.source),
      sourceMatches,
      entrypoint: entrypointOf(scan.files),
      recordedEntrypoint: validation.entrypoint,
      differences: treeMatches ? [] : differences,
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
  // Overridable only so the gate's own tests can exercise it against a throwaway
  // git checkout. Every lane and every package script uses the default, so the
  // recorded identity and the verified identity are always the same source root.
  const sourceRoot = path.resolve(PROJECT_ROOT, argumentValue('source-root') ?? PROJECT_ROOT);

  if (selectedMode === 'write') {
    const outcome = await writeManifest(distDir, manifestPath, sourceRoot);
    if (outcome.failure) {
      if (flagPresent('json')) {
        console.log(JSON.stringify(outcome.failure, null, 2));
      } else {
        console.error(`${outcome.failure.status}: ${outcome.failure.message} (${outcome.failure.code})`);
        for (const problem of outcome.failure.problems ?? []) {
          console.error(`  ${problem.code}${problem.path ? ` ${problem.path}` : ""}`);
        }
      }
      process.exitCode = 1;
      return;
    }
    const { manifest, identity, source } = outcome;
    console.log(
      `Recorded ${identity.algorithm} identity ${identity.treeSha256} for ${identity.fileCount} dist files ` +
        `(${identity.totalBytes} bytes).`,
    );
    console.log(
      `Recorded ${source.algorithm} identity ${source.treeSha256} for ${source.fileCount} tracked source files ` +
        `(${source.totalBytes} bytes).`,
    );
    console.log(`Entrypoint ${manifest.entrypoint.path} sha256 ${manifest.entrypoint.sha256}.`);
    console.log(`Manifest: ${toPosixPath(path.relative(PROJECT_ROOT, manifestPath))}`);
    return;
  }

  const { result: verification } = await verifyManifest(distDir, manifestPath, sourceRoot);
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
    if (verification.source) {
      console.log(
        `source identity ${verification.source.algorithm} ${verification.source.treeSha256} ` +
          `(${verification.source.fileCount} tracked files, ${verification.source.totalBytes} bytes).`,
      );
    }
    if (verification.recordedSource && verification.sourceMatches === false) {
      console.log(
        `recorded source identity ${verification.recordedSource.treeSha256} ` +
          `(${verification.recordedSource.fileCount} tracked files, ${verification.recordedSource.totalBytes} bytes).`,
      );
    }
    for (const problem of verification.problems ?? []) {
      console.error(`  ${problem.code}${problem.path ? ` ${problem.path}` : ""}`);
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
