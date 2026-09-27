import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Phase 1A web-artifact manifest integrity checks.
 *
 * Every case runs the real script against an isolated temporary directory, so the
 * repository's own `dist` tree and recorded manifest are never modified. The
 * suite covers the accepted state plus modified, added, removed, renamed,
 * malformed, duplicate, invalid-path, entrypoint, digest, count, and symlink
 * cases, and it asserts that failure output stays sanitized and structured.
 *
 * The second suite is the source-identity suite. It builds throwaway git
 * checkouts in temporary directories and drives the real script against them
 * with `--source-root`, so the property the fix exists for - a stale artifact
 * recorded from stale source fails - is exercised with real source content
 * rather than asserted from a reading of the code.
 */

const SCRIPT_PATH = path.resolve('scripts/web-artifact-manifest.mjs');
const SENTINEL = 'SENTINEL-QUERY-abc123';

interface ScriptResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly stdout: string;
  readonly stderr: string;
}

let workspace: string;
let distDir: string;
let manifestPath: string;
let sourceRoot: string;

function runScript(args: readonly string[], expectJson: boolean): ScriptResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: 0,
      json: expectJson ? (JSON.parse(stdout) as Record<string, unknown>) : {},
      stdout,
      stderr: '',
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    const stdout = failure.stdout ?? '';
    return {
      status: failure.status ?? 1,
      json: expectJson && stdout.trim().length > 0 ? (JSON.parse(stdout) as Record<string, unknown>) : {},
      stdout,
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * A throwaway git checkout, so `git ls-files` has an index to read. Every case
 * that is not specifically about the repository's own source runs against one of
 * these, so the suite neither depends on the working tree being a git checkout
 * nor pays a full source scan of it on every invocation.
 */
function createSourceCheckout(root: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(root, { recursive: true });
  for (const [filePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...filePath.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }
  const git = (...args: readonly string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git('init', '--quiet');
  git('config', 'user.email', 'artifact-lane@example.invalid');
  git('config', 'user.name', 'Artifact Lane Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '--all');
  git('commit', '--quiet', '-m', 'fixture');
}

function writeIn(root: string, filePath: string, contents: string): void {
  const absolute = path.join(root, ...filePath.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function gitIn(root: string, ...args: readonly string[]): void {
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

function verify(): ScriptResult {
  return runScript(
    ['verify', `--dist=${distDir}`, `--manifest=${manifestPath}`, `--source-root=${sourceRoot}`, '--json'],
    true,
  );
}

function write(expectJson = false): ScriptResult {
  return runScript(
    [
      'write',
      `--dist=${distDir}`,
      `--out=${manifestPath}`,
      `--source-root=${sourceRoot}`,
      ...(expectJson ? ['--json'] : []),
    ],
    expectJson,
  );
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

function saveManifest(manifest: Record<string, unknown>): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * `write` prints its human summary on success and JSON only on failure, so the
 * recorded source identity is read back from the manifest file rather than
 * parsed out of stdout. That is also the more honest assertion: it checks what
 * was actually written.
 */
function recordFrom(root: string, expectJson = false): ScriptResult {
  return runScript(
    ['write', `--dist=${distDir}`, `--out=${manifestPath}`, `--source-root=${root}`, ...(expectJson ? ['--json'] : [])],
    expectJson,
  );
}

function verifyFrom(root: string): ScriptResult {
  return runScript(
    ['verify', `--dist=${distDir}`, `--manifest=${manifestPath}`, `--source-root=${root}`, '--json'],
    true,
  );
}

/** The source identity recomputed by a `verify` run. */
function sourceOf(result: ScriptResult): Record<string, unknown> {
  return result.json.source as Record<string, unknown>;
}

/** The source identity as it was written into the manifest file. */
function recordedSourceOf(): Record<string, unknown> {
  return readManifest().source as Record<string, unknown>;
}

function problemCodes(result: ScriptResult): readonly string[] {
  return (result.json.problemCodes as readonly string[] | undefined) ?? [];
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'kd-artifact-'));
  distDir = path.join(workspace, 'dist');
  manifestPath = path.join(workspace, 'web-artifact-manifest.json');
  mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Knowledge Dungeon</title>\n', 'utf8');
  writeFileSync(path.join(distDir, 'assets', 'app.js'), 'export const build = "test";\n', 'utf8');
  writeFileSync(path.join(distDir, 'assets', 'app.css'), ':root { color: #fff; }\n', 'utf8');
  sourceRoot = path.join(workspace, 'source');
  createSourceCheckout(sourceRoot, {
    'package.json': '{\n  "name": "knowledge-dungeon",\n  "version": "7.0.0"\n}\n',
    'index.html': '<!doctype html><title>Knowledge Dungeon</title>\n',
    'src/app/main.ts': 'export const revision = "a";\n',
    'public/assets/tree.svg': '<svg viewBox="0 0 16 16"></svg>\n',
  });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('web-artifact manifest integrity', () => {
  it('records and verifies an unmodified artifact', () => {
    const recorded = write();
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain('sha256-tree-v1');

    const verification = verify();
    expect(verification.status).toBe(0);
    expect(verification.json.status).toBe('match');
    expect(verification.json.code).toBe('match');
    expect(verification.json.differences).toEqual([]);

    const identity = verification.json.identity as Record<string, unknown>;
    const recordedIdentity = verification.json.recordedIdentity as Record<string, unknown>;
    expect(identity.treeSha256).toBe(recordedIdentity.treeSha256);
    expect(identity.fileCount).toBe(3);
    expect(identity.totalBytes).toBeGreaterThan(0);

    const entrypoint = verification.json.entrypoint as Record<string, unknown>;
    const recordedEntrypoint = verification.json.recordedEntrypoint as Record<string, unknown>;
    expect(entrypoint.sha256).toBe(recordedEntrypoint.sha256);
    expect(entrypoint.path).toBe('index.html');
    expect(entrypoint.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects a modified file', () => {
    write();
    writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>tampered</title>\n', 'utf8');

    const verification = verify();
    expect(verification.status).toBe(1);
    expect(verification.json.status).toBe('mismatch');
    const differences = verification.json.differences as readonly { path: string; kind: string }[];
    expect(differences).toHaveLength(1);
    expect(differences[0].path).toBe('index.html');
    expect(differences[0].kind).toBe('modified');
  });

  it('detects an added file', () => {
    write();
    writeFileSync(path.join(distDir, 'assets', 'extra.js'), 'export const extra = 1;\n', 'utf8');

    const verification = verify();
    expect(verification.json.status).toBe('mismatch');
    const differences = verification.json.differences as readonly { path: string; kind: string }[];
    expect(differences.map((entry) => entry.kind)).toContain('added');
    expect(differences.map((entry) => entry.path)).toContain('assets/extra.js');
  });

  it('detects a removed file', () => {
    write();
    rmSync(path.join(distDir, 'assets', 'app.css'));

    const verification = verify();
    expect(verification.json.status).toBe('mismatch');
    const differences = verification.json.differences as readonly { path: string; kind: string }[];
    expect(differences.map((entry) => entry.kind)).toContain('removed');
    expect(differences.map((entry) => entry.path)).toContain('assets/app.css');
  });

  it('detects a renamed file', () => {
    write();
    renameSync(path.join(distDir, 'assets', 'app.css'), path.join(distDir, 'assets', 'app.min.css'));

    const verification = verify();
    expect(verification.json.status).toBe('mismatch');
    const differences = verification.json.differences as readonly { path: string; kind: string }[];
    const kinds = differences.map((entry) => entry.kind);
    expect(kinds).toContain('removed');
    expect(kinds).toContain('added');
  });

  it('rejects a manifest whose recorded tree digest does not match its own file entries', () => {
    write();
    const manifest = readManifest();
    const identity = { ...(manifest.identity as Record<string, unknown>) };
    identity.treeSha256 = 'a'.repeat(64);
    saveManifest({ ...manifest, identity });

    const verification = verify();
    expect(verification.status).toBe(1);
    expect(verification.json.status).toBe('invalid-manifest');
    expect(problemCodes(verification)).toContain('recorded-tree-digest-mismatch');
  });

  it('rejects a manifest whose recorded file count or byte total is inconsistent', () => {
    write();
    const manifest = readManifest();
    const identity = { ...(manifest.identity as Record<string, unknown>) };
    identity.fileCount = 99;
    identity.totalBytes = 1;
    saveManifest({ ...manifest, identity });

    const verification = verify();
    expect(verification.json.status).toBe('invalid-manifest');
    expect(problemCodes(verification)).toEqual(
      expect.arrayContaining(['recorded-file-count-mismatch', 'recorded-total-bytes-mismatch']),
    );
  });

  it('rejects a malformed file array', () => {
    write();
    const manifest = readManifest();
    saveManifest({ ...manifest, files: { not: 'an array' } });

    const verification = verify();
    expect(verification.json.status).toBe('invalid-manifest');
    expect(problemCodes(verification)).toContain('files-not-array');
  });

  it('rejects duplicate recorded paths', () => {
    write();
    const manifest = readManifest();
    const files = manifest.files as readonly Record<string, unknown>[];
    saveManifest({ ...manifest, files: [...files, { ...files[0] }] });

    const verification = verify();
    expect(verification.json.status).toBe('invalid-manifest');
    expect(problemCodes(verification)).toContain('file-path-duplicate');
  });

  it('rejects invalid recorded paths, digests, and byte counts', () => {
    write();
    const manifest = readManifest();
    const files = manifest.files as readonly Record<string, unknown>[];

    saveManifest({ ...manifest, files: [...files, { path: '/etc/passwd', sha256: 'b'.repeat(64), bytes: 1 }] });
    expect(problemCodes(verify())).toContain('file-path-invalid');

    saveManifest({ ...manifest, files: [...files, { path: 'assets/../escape.js', sha256: 'b'.repeat(64), bytes: 1 }] });
    expect(problemCodes(verify())).toContain('file-path-invalid');

    saveManifest({ ...manifest, files: [...files, { path: 'assets\\win.js', sha256: 'b'.repeat(64), bytes: 1 }] });
    expect(problemCodes(verify())).toContain('file-path-invalid');

    saveManifest({ ...manifest, files: [...files, { path: 'assets/bad.js', sha256: 'not-a-digest', bytes: 1 }] });
    expect(problemCodes(verify())).toContain('file-sha256-invalid');

    saveManifest({ ...manifest, files: [...files, { path: 'assets/bad.js', sha256: 'c'.repeat(64), bytes: -1 }] });
    expect(problemCodes(verify())).toContain('file-bytes-invalid');
  });

  it('rejects a missing or unsupported schema and a missing identity', () => {
    write();
    const manifest = readManifest();

    saveManifest({ ...manifest, schemaVersion: 99 });
    expect(problemCodes(verify())).toContain('schema-version-unsupported');

    const { identity: _identity, ...withoutIdentity } = manifest;
    void _identity;
    saveManifest(withoutIdentity);
    const verification = verify();
    expect(verification.json.status).toBe('invalid-manifest');
    expect(problemCodes(verification)).toContain('identity-missing');
  });

  it('rejects an entrypoint that is missing or inconsistent with the file list', () => {
    write();
    const manifest = readManifest();

    const { entrypoint: _entrypoint, ...withoutEntrypoint } = manifest;
    void _entrypoint;
    saveManifest(withoutEntrypoint);
    expect(problemCodes(verify())).toContain('entrypoint-missing');

    saveManifest({
      ...manifest,
      entrypoint: { path: 'index.html', sha256: 'd'.repeat(64), bytes: 1 },
    });
    expect(problemCodes(verify())).toContain('entrypoint-inconsistent-with-file-list');

    saveManifest({ ...manifest, entrypoint: { path: 'other.html', sha256: 'd'.repeat(64), bytes: 1 } });
    expect(problemCodes(verify())).toContain('entrypoint-invalid');
  });

  it('rejects unreadable and missing manifests with structured results', () => {
    write();

    writeFileSync(manifestPath, '{ not json', 'utf8');
    const unreadable = verify();
    expect(unreadable.status).toBe(1);
    expect(unreadable.json.status).toBe('invalid-manifest');
    expect(unreadable.json.code).toBe('manifest-unreadable');

    rmSync(manifestPath);
    const missing = verify();
    expect(missing.status).toBe(1);
    expect(missing.json.status).toBe('manifest-missing');
  });

  it('rejects a symlink inside the web build instead of following it', () => {
    const target = path.join(workspace, 'outside.txt');
    writeFileSync(target, `${SENTINEL}\n`, 'utf8');
    let supported = true;
    try {
      symlinkSync(target, path.join(distDir, 'assets', 'link.js'));
    } catch {
      supported = false;
    }
    if (!supported) return; // Symlink creation requires extra privileges on some hosts.

    const recorded = write(true);
    expect(recorded.status).toBe(1);
    expect(recorded.json.status).toBe('dist-invalid');
    expect(problemCodes(recorded)).toContain('symlink-entry');
    // The human-readable path reports the same bounded code on stderr.
    const human = write();
    expect(human.stderr).toContain('symlink-entry');

    const verification = verify();
    expect(verification.status).toBe(1);
    expect(verification.json.status).toBe('dist-invalid');
    expect(problemCodes(verification)).toContain('symlink-entry');
  });

  it('rejects a missing build and a build without an entrypoint', () => {
    const missing = runScript(
      ['verify', `--dist=${path.join(workspace, 'absent')}`, `--manifest=${manifestPath}`, '--json'],
      true,
    );
    expect(missing.status).toBe(1);
    expect(missing.json.status).toBe('dist-missing');

    rmSync(path.join(distDir, 'index.html'));
    const recorded = write(true);
    expect(recorded.status).toBe(1);
    expect(recorded.json.status).toBe('dist-invalid');
    expect(recorded.json.code).toBe('entrypoint-missing');
  });

  it('returns sanitized structured output instead of a raw exception', () => {
    const unsupportedMode = runScript(
      ['explode', `--dist=${distDir}`, `--manifest=${manifestPath}`, '--json'],
      true,
    );
    expect(unsupportedMode.status).toBe(1);
    expect(unsupportedMode.json.status).toBe('error');
    expect(unsupportedMode.json.code).toBe('unexpected-error');
    expect(unsupportedMode.json.message).toEqual(expect.any(String));

    const verification = verify();
    const serialized = JSON.stringify(verification.json);
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('\\');
  });

  // This is the only test in the file that does real work against the real
  // checkout: the `write` and `verify` calls above it each enumerate the tracked
  // source tree and sha256 every file in it, twice. Measured at 0.8s on an idle
  // machine, so a 5s default is only a ~6x margin, and it was observed taking
  // 7.1s and timing out on a loaded one - which is a flaky gate, not a finding.
  // The budget is explicit and generous rather than left to the 5s default,
  // because a slow runner must not be able to report this product's evidence
  // contract as broken.
  it('never fails the real repository dist or manifest', { timeout: 120_000 }, () => {
    // The suite only ever points the script at temporary directories, except
    // here, where the default source root is deliberately the real repository:
    // one case proves the script reads a real checkout and a real recorded
    // manifest without either of them being disturbed.
    expect(path.resolve('dist')).not.toBe(distDir);
    expect(path.resolve('artifacts/web-artifact-manifest.json')).not.toBe(manifestPath);
    const recorded = runScript(['write', `--dist=${distDir}`, `--out=${manifestPath}`], false);
    expect(recorded.status).toBe(0);
    const verification = runScript(['verify', `--dist=${distDir}`, `--manifest=${manifestPath}`, '--json'], true);
    expect(verification.json.status).toBe('match');
    expect(sourceOf(verification).algorithm).toBe('sha256-git-tracked-v1');
    expect(sourceOf(verification).fileCount as number).toBeGreaterThan(0);
  });
});

// ── Source identity ─────────────────────────────────────────────────────────
//
// The defect this suite exists for: the manifest was recorded from the same
// `dist` the lane then served, so `dist` matching the manifest proved only that
// `dist` matched `dist`, and a stale `dist` paired with a manifest recorded from
// that same stale tree passed byte for byte. The source identity is what makes
// that pairing fail, so these cases build real git checkouts and drive the real
// script across them.

describe('web-artifact manifest source identity', () => {
  let sourceA: string;
  let sourceB: string;

  beforeEach(() => {
    // Two deliberately different source states. `sourceA` is the checkout the
    // outer fixture already built and committed as `fixture`; `sourceB` is what
    // a second revision looks like: same file set, one file's content changed.
    sourceA = sourceRoot;
    sourceB = path.join(workspace, 'source-b');
    createSourceCheckout(sourceB, {
      'package.json': '{\n  "name": "knowledge-dungeon",\n  "version": "7.0.0"\n}\n',
      'index.html': '<!doctype html><title>Knowledge Dungeon</title>\n',
      'src/app/main.ts': 'export const revision = "b";\n',
      'public/assets/tree.svg': '<svg viewBox="0 0 16 16"></svg>\n',
    });
  });

  it('records a source identity and verifies a matching dist and source pair', () => {
    const recorded = recordFrom(sourceA);
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain('sha256-git-tracked-v1');
    const recordedSource = recordedSourceOf();
    expect(recordedSource.algorithm).toBe('sha256-git-tracked-v1');
    expect(recordedSource.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recordedSource.fileCount).toBe(4);

    const verification = verifyFrom(sourceA);
    expect(verification.status).toBe(0);
    expect(verification.json.status).toBe('match');
    expect(verification.json.sourceMatches).toBe(true);
    expect(sourceOf(verification).treeSha256).toBe(recordedSource.treeSha256);
    // The manifest carries both identities, and the tree one is unchanged.
    expect((readManifest().identity as Record<string, unknown>).algorithm).toBe('sha256-tree-v1');
    expect(readManifest().schemaVersion).toBe(2);
  });

  it('fails a dist and manifest pair recorded from a different source state', () => {
    // The exact shape of the reported defect: a `dist` built from one source
    // revision, a manifest recorded from that same `dist`, and a worktree that
    // has since moved on. The tree identity matches, byte for byte.
    expect(recordFrom(sourceA).status).toBe(0);
    expect(verifyFrom(sourceA).json.status).toBe('match');

    const stale = verifyFrom(sourceB);
    expect(stale.status).toBe(1);
    expect(stale.json.status).toBe('mismatch');
    expect(stale.json.code).toBe('source-does-not-match-recorded-artifact');
    // The tree half of the gate is unchanged and still reports a match, which is
    // exactly why it could not have caught this on its own.
    expect(stale.json.differences).toEqual([]);
    expect((stale.json.identity as Record<string, unknown>).treeSha256).toBe(
      (stale.json.recordedIdentity as Record<string, unknown>).treeSha256,
    );
    expect(sourceOf(stale).treeSha256).not.toBe((stale.json.recordedSource as Record<string, unknown>).treeSha256);
  });

  it('fails a dist and manifest pair recorded from a different source state, in the other order', () => {
    expect(recordFrom(sourceB).status).toBe(0);
    expect(verifyFrom(sourceB).json.status).toBe('match');
    expect(verifyFrom(sourceA).json.code).toBe('source-does-not-match-recorded-artifact');
  });

  it('changes when source content changes and when a tracked path changes', () => {
    recordFrom(sourceA);
    const before = recordedSourceOf().treeSha256 as string;
    recordFrom(sourceB);
    expect(recordedSourceOf().treeSha256).not.toBe(before);

    // Same content, different tracked path: the identity is over paths too.
    gitIn(sourceA, 'mv', 'public/assets/tree.svg', 'public/assets/canopy.svg');
    recordFrom(sourceA);
    expect(recordedSourceOf().treeSha256).not.toBe(before);
  });

  it('is stable across a re-record from unchanged source', () => {
    recordFrom(sourceA);
    const first = recordedSourceOf().treeSha256;
    recordFrom(sourceA);
    expect(recordedSourceOf().treeSha256).toBe(first);
    // ...and a fresh `dist` recorded against unchanged source still verifies,
    // which is the rebuild case a timestamped build output must not break.
    writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>rebuilt</title>\n', 'utf8');
    expect(recordFrom(sourceA).status).toBe(0);
    expect(verifyFrom(sourceA).json.status).toBe('match');
    expect(sourceOf(verifyFrom(sourceA)).treeSha256).toBe(first);
  });

  it('ignores untracked files, artifacts, dist, and the timestamped build output', () => {
    recordFrom(sourceA);
    const before = recordedSourceOf().treeSha256;

    // The one a real build produces: generated into `public/`, gitignored, and
    // carrying a `generatedAt` timestamp, which is why a clean rebuild is not
    // bit-reproducible. If this perturbed the source identity, no recorded pair
    // would ever verify twice.
    writeIn(sourceA, 'public/assets/sprite-manifest.json', '{"generatedAt":"2026-01-01T00:00:00.000Z"}\n');
    writeIn(sourceA, 'artifacts/web-artifact-manifest-storage-v2.json', '{"schemaVersion":2}\n');
    writeIn(sourceA, 'dist/index.html', '<!doctype html><title>ignored</title>\n');
    writeIn(sourceA, 'node_modules/vite/package.json', '{"version":"0.0.0"}\n');
    writeIn(sourceA, 'notes-scratch.md', `${SENTINEL}\n`);
    recordFrom(sourceA);
    expect(recordedSourceOf().treeSha256).toBe(before);

    // With the build output present, the pair still verifies.
    expect(verifyFrom(sourceA).json.status).toBe('match');
  });

  it('detects an uncommitted source change in a dirty worktree', () => {
    // No commit, no staging: the normal state while developing. A commit sha
    // alone would describe the same revision as the pair below, so this case is
    // what a revision field cannot see.
    expect(recordFrom(sourceA).status).toBe(0);
    expect(verifyFrom(sourceA).json.status).toBe('match');

    writeIn(sourceA, 'src/app/main.ts', 'export const revision = "uncommitted";\n');
    const dirty = verifyFrom(sourceA);
    expect(dirty.status).toBe(1);
    expect(dirty.json.code).toBe('source-does-not-match-recorded-artifact');

    // Re-recorded against the same dirty worktree it is a passing pair again.
    expect(recordFrom(sourceA).status).toBe(0);
    expect(verifyFrom(sourceA).json.status).toBe('match');
  });

  it('treats a tracked file deleted in the worktree as absent rather than failing', () => {
    recordFrom(sourceA);
    const before = recordedSourceOf();
    rmSync(path.join(sourceA, 'public', 'assets', 'tree.svg'));
    recordFrom(sourceA);
    const after = recordedSourceOf();
    expect(after.fileCount).toBe(before.fileCount);
    expect(after.treeSha256).not.toBe(before.treeSha256);
    expect(after.totalBytes as number).toBeLessThan(before.totalBytes as number);
    expect(verifyFrom(sourceA).json.status).toBe('match');
  });

  it('hashes CRLF and LF line endings identically, and a real edit differently', () => {
    // The verifying job may run on another host. Git for Windows defaults
    // `core.autocrlf` to true, so an un-normalized identity would report a
    // source change between a CRLF checkout and an LF one and fail the Windows
    // compatibility lane for a reason that never happened.
    recordFrom(sourceA);
    const lf = recordedSourceOf().treeSha256;
    writeIn(sourceA, 'src/app/main.ts', 'export const revision = "a";\r\n');
    recordFrom(sourceA);
    expect(recordedSourceOf().treeSha256).toBe(lf);

    writeIn(sourceA, 'src/app/main.ts', 'export const revision = "b";\r\n');
    recordFrom(sourceA);
    expect(recordedSourceOf().treeSha256).not.toBe(lf);
  });

  it('rejects a manifest with no source identity instead of trusting it', () => {
    recordFrom(sourceA);
    const manifest = readManifest();

    const { source: _source, ...withoutSource } = manifest;
    void _source;
    saveManifest(withoutSource);
    const missing = verifyFrom(sourceA);
    expect(missing.status).toBe(1);
    expect(missing.json.status).toBe('invalid-manifest');
    expect(problemCodes(missing)).toContain('source-missing');

    // A pre-fix manifest is a schema it no longer supports, and says so
    // alongside the actionable code rather than only the version number.
    saveManifest({ ...withoutSource, schemaVersion: 1 });
    const preFix = verifyFrom(sourceA);
    expect(preFix.status).toBe(1);
    expect(problemCodes(preFix)).toEqual(
      expect.arrayContaining(['schema-version-unsupported', 'source-missing']),
    );

    for (const source of [
      { ...(manifest.source as Record<string, unknown>), algorithm: 'sha256-tree-v1' },
      { ...(manifest.source as Record<string, unknown>), treeSha256: 'not-a-digest' },
      { ...(manifest.source as Record<string, unknown>), fileCount: -1 },
      { ...(manifest.source as Record<string, unknown>), totalBytes: 1.5 },
    ]) {
      saveManifest({ ...manifest, source });
      const invalid = verifyFrom(sourceA);
      expect(invalid.status).toBe(1);
      expect(invalid.json.status).toBe('invalid-manifest');
    }
  });

  it('fails closed when the source tree cannot be hashed', () => {
    // A source identity that cannot be computed is a gate that cannot evaluate
    // its own precondition. It must never report a match.
    const notACheckout = path.join(workspace, 'not-a-checkout');
    mkdirSync(notACheckout, { recursive: true });
    const recorded = recordFrom(notACheckout, true);
    expect(recorded.status).toBe(1);
    expect(recorded.json.status).toBe('source-unavailable');
    expect(recorded.json.code).toBe('source-identity-unavailable');
    expect(recorded.json.algorithm).toBe('sha256-git-tracked-v1');
  });

  it('reports a source mismatch without leaking paths or source content', () => {
    recordFrom(sourceA);
    // The sentinel is now IN the verified source tree, so this asserts the
    // mismatch payload carries the identity and nothing read out of the file.
    writeIn(sourceA, 'src/app/main.ts', `export const revision = "${SENTINEL}";\n`);
    const stale = verifyFrom(sourceA);
    const serialized = JSON.stringify(stale.json);
    expect(stale.json.code).toBe('source-does-not-match-recorded-artifact');
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain(SENTINEL);
  });
});

// ── CI wiring ───────────────────────────────────────────────────────────────

const WORKFLOW_PATHS = [
  path.resolve('.github/workflows/ci.yml'),
  path.resolve('.github/workflows/compatibility.yml'),
] as const;

/**
 * Every `path:` entry of every `upload-artifact` step, read line by line.
 *
 * Handles both forms these workflows use: a single inline value, and a `|`
 * block whose entries are the more-indented lines that follow. A scanner that
 * missed the block form would read an upload as empty and pass every assertion
 * below, so the tests also assert that this returns the entries they expect.
 */
function uploadedPaths(workflow: string): readonly string[] {
  const lines = workflow.split('\n');
  const paths: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/uses:\s*actions\/upload-artifact/.test(lines[index] as string)) continue;
    for (let scan = index; scan < Math.min(lines.length, index + 12); scan += 1) {
      const match = /^(\s*)(?:-\s*)?path:\s*(\S.*)$/.exec(lines[scan] as string);
      if (!match) continue;
      const indent = (match[1] as string).length + (/-/.test(match[2] as string) ? 0 : 0);
      const value = (match[2] as string).trim();
      if (value !== '|' && value !== '>') {
        paths.push(value);
        continue;
      }
      for (let continuation = scan + 1; continuation < lines.length; continuation += 1) {
        const next = lines[continuation] as string;
        if (next.trim().length === 0) continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        paths.push(next.trim());
        scan = continuation;
      }
    }
  }
  return paths;
}

function trackedPaths(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((tracked) => tracked.length > 0);
}

/**
 * Each top-level job body, keyed by job name. A job header is a two-space
 * indent followed by a name and a colon; the 2-space-indented comment blocks
 * these workflows carry are not job headers, so the body is taken from one job
 * header to the next rather than split on every two-space line.
 */
function ciJobs(workflow: string): ReadonlyMap<string, string> {
  const lines = workflow.split('\n');
  const headers: { name: string; line: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index] as string);
    if (match) headers.push({ name: match[1] as string, line: index });
  }
  const jobs = new Map<string, string>();
  headers.forEach((header, index) => {
    const end = index + 1 < headers.length ? (headers[index + 1] as { line: number }).line : lines.length;
    jobs.set(header.name, lines.slice(header.line, end).join('\n'));
  });
  return jobs;
}

describe('web-artifact source identity CI wiring', () => {
  it('no uploaded artifact path can overwrite tracked source on download', () => {
    // The source identity is read from the working tree, so a downloaded
    // artifact that landed on a tracked path would replace the very source the
    // gate compares against and put the comparison back to being
    // self-referential - the defect this identity exists to close. Today every
    // upload is `dist` or `artifacts/`, both ignored, and this asserts it stays
    // that way rather than being true by accident.
    const tracked = trackedPaths();
    expect(tracked.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const workflowPath of WORKFLOW_PATHS) {
      const uploaded = uploadedPaths(readFileSync(workflowPath, 'utf8'));
      expect(uploaded.length, `${workflowPath} has no upload-artifact path`).toBeGreaterThan(0);
      // Guards the extractor above: if it stopped reading block-form paths it
      // would report an empty upload set and pass for the wrong reason.
      expect(uploaded, `${workflowPath} uploads no dist entry`).toContain('dist');
      expect(
        uploaded.some((entry) => entry.startsWith('artifacts/')),
        `${workflowPath} uploads no artifacts/ entry`,
      ).toBe(true);
      for (const entry of uploaded) {
        const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
        for (const file of tracked) {
          if (file === normalized || file.startsWith(`${normalized}/`)) {
            violations.push(`${normalized} covers tracked ${file}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('the manifest and dist are uploaded together, so no lane can verify one without the other', () => {
    // A lane that received a manifest without the matching `dist` could not run
    // the identity check at all, which is the shape of the reported failure: the
    // gate silently not applying.
    for (const workflowPath of WORKFLOW_PATHS) {
      const uploaded = uploadedPaths(readFileSync(workflowPath, 'utf8'));
      expect(uploaded, `${workflowPath} uploads no dist entry`).toContain('dist');
      expect(
        uploaded.some((entry) => /web-artifact-manifest[^/]*\.json$/.test(entry)),
        `${workflowPath} uploads no web-artifact manifest`,
      ).toBe(true);
    }
  });

  it('every CI verification runs in a job that also builds, records, or downloads first', () => {
    // The source identity is only satisfiable when the verifying job and the
    // recording job describe the same source, so the two halves travel together
    // in one job or as one downloaded pair. A verification that ran with neither
    // would be asserting against a manifest it has no artifact for.
    let verifications = 0;
    for (const workflowPath of WORKFLOW_PATHS) {
      const jobs = ciJobs(readFileSync(workflowPath, 'utf8'));
      for (const [name, body] of jobs) {
        if (!/npm run verify:web-artifact/.test(body)) continue;
        verifications += 1;
        const prepared =
          /npm run build:/.test(body) ||
          /npm run record:web-artifact/.test(body) ||
          /actions\/download-artifact/.test(body);
        expect(
          prepared,
          `${workflowPath} job ${name} verifies the artifact without building, recording, or downloading one`,
        ).toBe(true);
        // The gate reads the repository's own tracked source, so no lane may be
        // pointed at a different one.
        expect(body, `${workflowPath} job ${name} overrides the source root`).not.toContain('--source-root');
      }
    }
    expect(verifications, 'no CI job verifies the web-artifact identity').toBeGreaterThan(0);
  });
});
