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

function verify(): ScriptResult {
  return runScript(['verify', `--dist=${distDir}`, `--manifest=${manifestPath}`, '--json'], true);
}

function write(expectJson = false): ScriptResult {
  return runScript(
    ['write', `--dist=${distDir}`, `--out=${manifestPath}`, ...(expectJson ? ['--json'] : [])],
    expectJson,
  );
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

function saveManifest(manifest: Record<string, unknown>): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
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

  it('never fails the real repository dist or manifest', () => {
    // The suite only ever points the script at temporary directories.
    expect(path.resolve('dist')).not.toBe(distDir);
    expect(path.resolve('artifacts/web-artifact-manifest.json')).not.toBe(manifestPath);
    const recorded = write();
    expect(recorded.status).toBe(0);
    expect(verify().json.status).toBe('match');
  });
});
